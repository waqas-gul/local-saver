-- Phase 3: the storage janitor and job health (DEC-016, DEC-019; phase 3 §17.4–§17.6, §18).
--
-- One deletion executor (owner decision D-1): the storage-janitor Edge Function. pg_cron posts to
-- it through pg_net when outbox rows are due; it claims rows through the SECURITY DEFINER
-- functions below, which are all the app_janitor role may run (C-4). The web tier no longer
-- deletes or tombstones objects; access still ends at once through request-time checks.
--
-- Takedown objects are held, not deleted (D-2): end_share('blocked') and admin_block_share put
-- the share's outbox rows on legal hold, the janitor never deletes held rows, and only an
-- operator releases them (admin_release_hold). R2's lifecycle rules delete d7/, d30/ and d90/
-- objects at their class period + 1 day after upload whatever the database says, so the janitor
-- copies each held object to hold/<key>, which no rule covers (security review 2026-10-16,
-- RISK-031). After a release the janitor deletes the original and the copy together.
--
-- Vault secrets (storage_janitor_url, storage_janitor_secret) are created per environment
-- outside migrations: by `pnpm stack:start` locally, by the janitor runbook elsewhere.

-- ---------------------------------------------------------------------------
-- Outbox and files
-- ---------------------------------------------------------------------------
alter table app.object_deletions
  add column last_attempt_at timestamptz,
  add column legal_hold boolean not null default false,
  add column hold_reason text check (char_length(hold_reason) between 1 and 200),
  -- The copy of a held object out of the lifecycle rules' reach (RISK-031): null while it is still
  -- to be made (or the row was never held), 'copied' once hold/<key> exists, 'unavailable' when
  -- there was nothing left to copy (already deleted or overwritten by a tombstone).
  add column hold_copy text check (hold_copy in ('copied', 'unavailable')),
  add constraint object_deletions_hold check (legal_hold = (hold_reason is not null));

-- Reconciliation queues objects that no file row accounts for (04 §8.6).
alter table app.object_deletions drop constraint object_deletions_reason_check;
alter table app.object_deletions add constraint object_deletions_reason_check
  check (reason in ('share_ended', 'upload_rejected', 'upload_timeout', 'orphan'));

create index object_deletions_completed_idx on app.object_deletions (completed_at) where completed_at is not null;
create index object_deletions_open_file_idx on app.object_deletions (source_file_id) where completed_at is null;

-- Set by reconciliation when a verified file of an open share has no object in storage.
alter table app.files add column object_missing_at timestamptz;
create index files_object_missing_idx on app.files (object_missing_at) where object_missing_at is not null;

-- ---------------------------------------------------------------------------
-- Roles. NOLOGIN here; an operator enables login per environment (seed.sql locally).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_janitor') then
    create role app_janitor nologin;
  end if;
end
$$;
grant usage on schema app to app_janitor;

set role app_owner;

-- ---------------------------------------------------------------------------
-- Job health (phase 3 §17.6): one row per job, counts only, never keys, names or secrets.
-- ---------------------------------------------------------------------------
create table app.job_heartbeats (
  job text primary key check (job ~ '^[a-z0-9-]{1,64}$'),
  last_started_at timestamptz,
  last_succeeded_at timestamptz,
  last_failed_at timestamptz,
  last_error text check (char_length(last_error) <= 200),
  last_result jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Weekly storage reconciliation: one run spans several janitor invocations (cursor).
create table app.storage_reconcile_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'finished')),
  -- The last key listed (ListObjectsV2 StartAfter); null before the first page.
  last_key text check (char_length(last_key) <= 1024),
  locked_until timestamptz,
  counts jsonb not null default '{}'::jsonb,
  constraint storage_reconcile_runs_finished check ((status = 'running') = (finished_at is null))
);
create unique index storage_reconcile_runs_one_running_idx on app.storage_reconcile_runs ((true)) where status = 'running';

insert into app.runtime_flags (key, enabled, value, note) values
  ('storage_janitor_enabled', true, '{}', 'Kill switch: the storage janitor claims nothing and the trigger posts nothing while off (incidents, investigations)'),
  ('janitor_daily_volume_alert', true, '{"value": 10000}', '/health/cron reports janitorVolume: unusual when more objects than this were deleted in 24 h'),
  ('cron_heartbeat', true, '{}', 'Set every 5 minutes by the cron-heartbeat job ({"at"}); /health/cron fails when it is stale')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function app.record_job_run(p_job text, p_ok boolean, p_result jsonb default '{}'::jsonb, p_error text default null)
returns void
language plpgsql security invoker set search_path = ''
as $$
begin
  insert into app.job_heartbeats as h (job, last_started_at, last_succeeded_at, last_failed_at, last_error, last_result)
  values (p_job, now(), case when p_ok then now() end, case when not p_ok then now() end,
          case when not p_ok then left(coalesce(p_error, 'error'), 200) end, coalesce(p_result, '{}'::jsonb))
  on conflict (job) do update
     set last_succeeded_at = case when p_ok then now() else h.last_succeeded_at end,
         last_failed_at = case when not p_ok then now() else h.last_failed_at end,
         last_error = case when not p_ok then left(coalesce(p_error, 'error'), 200) else h.last_error end,
         last_result = coalesce(p_result, '{}'::jsonb),
         updated_at = now();
  if p_job = 'cron-heartbeat' and p_ok then
    update app.runtime_flags
       set value = jsonb_build_object('at', now()), updated_at = now(), updated_by = 'cron-heartbeat'
     where key = 'cron_heartbeat';
  end if;
end
$$;

create function app.job_started(p_job text)
returns void
language sql security invoker set search_path = ''
as $$
  insert into app.job_heartbeats as h (job, last_started_at) values (p_job, now())
  on conflict (job) do update set last_started_at = now(), updated_at = now();
$$;

-- The same key format as lib/server/storage/keys.ts, stricter than the column check.
create function app.janitor_key_valid(p_key text)
returns boolean
language sql immutable security invoker set search_path = ''
as $$
  select coalesce(p_key ~ '^(d7|d30|d90|ws)/[0-9]{4}/[0-9]{2}/[0-9]{2}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false);
$$;

-- Retry delay after the n-th failure (phase 3 §17.4): 1 min, 5 min, 30 min, 2 h, then 12 h.
-- A hold copy's key (RISK-031): hold/ followed by a generated key. Never a generated key itself, so
-- no file, upload URL or orphan check can point at one.
create function app.janitor_hold_copy_key_valid(p_key text)
returns boolean
language sql immutable security invoker set search_path = ''
as $$
  select coalesce(left(p_key, 5) = 'hold/' and app.janitor_key_valid(substr(p_key, 6)), false);
$$;

create function app.janitor_backoff(p_attempts integer)
returns interval
language sql immutable security invoker set search_path = ''
as $$
  select case
    when p_attempts <= 1 then interval '1 minute'
    when p_attempts = 2 then interval '5 minutes'
    when p_attempts = 3 then interval '30 minutes'
    when p_attempts = 4 then interval '2 hours'
    else interval '12 hours'
  end;
$$;

create function app.storage_janitor_enabled()
returns boolean
language sql stable security invoker set search_path = ''
as $$
  select coalesce((select f.enabled from app.runtime_flags f where f.key = 'storage_janitor_enabled'), true);
$$;

-- Put a share's open outbox rows on legal hold (D-2). Internal: called by end_share and the takedown.
-- The janitor copies each one to hold/<key> on its next run (RISK-031); a row whose content a
-- tombstone already replaced has nothing left to copy.
create function app.hold_share_objects(p_share_id uuid, p_reason text)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  v_n integer;
begin
  update app.object_deletions od
     set legal_hold = true, hold_reason = coalesce(od.hold_reason, left(p_reason, 200)), locked_until = null,
         hold_copy = coalesce(od.hold_copy, case when od.tombstoned_at is not null then 'unavailable' end),
         not_before = now()
    from app.files f
   where f.share_id = p_share_id and od.source_file_id = f.id and od.completed_at is null and not od.legal_hold;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- ---------------------------------------------------------------------------
-- end_share (04 §9.1, DEC-016), Phase 3 version. Two changes, otherwise as Phase 2:
--   consumed: deletions wait 5 minutes, so a download from a URL issued just before the end
--             can finish (04 §8.7, phase 3 §17.8.6);
--   blocked:  the objects are put on legal hold (D-2) instead of being deleted.
-- ---------------------------------------------------------------------------
create or replace function app.end_share(p_share_id uuid, p_reason text)
returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare
  v_share app.shares;
  v_status text;
  f record;
begin
  v_status := case p_reason
    when 'expired' then 'expired'
    when 'consumed' then 'consumed'
    when 'deleted_by_creator' then 'deleted'
    when 'deleted_by_owner' then 'deleted'
    when 'blocked' then 'blocked'
    when 'upload_failed' then 'failed'
  end;
  if v_status is null then
    raise exception 'invalid end reason' using errcode = '22023';
  end if;

  select * into v_share from app.shares where id = p_share_id for update;
  if not found or v_share.ended_at is not null then
    return false;
  end if;

  for f in select * from app.files where share_id = p_share_id order by id for update loop
    if f.upload_status = 'verified' then
      update app.storage_usage u
         set bytes_committed = greatest(u.bytes_committed - f.size_bytes, 0),
             files_committed = greatest(u.files_committed - 1, 0),
             updated_at = now()
       where u.subject_type = v_share.billing_subject_type and u.subject_id = v_share.billing_subject_id;
      update app.files set upload_status = 'deleted' where id = f.id;
    elsif f.upload_status = 'pending' then
      perform app.release_reservation(r.id)
         from app.storage_reservations r where r.file_id = f.id and r.status = 'active';
      update app.files set upload_status = 'rejected', rejection_reason = 'share_ended' where id = f.id;
    end if;
    if f.upload_status in ('verified', 'pending') then
      insert into app.object_deletions (object_key, reason, source_file_id, not_before)
      values (f.object_key, 'share_ended', f.id,
              case when p_reason = 'consumed' then now() + interval '5 minutes' else now() end)
      on conflict (object_key) where completed_at is null do nothing;
    end if;
  end loop;

  if p_reason = 'blocked' then
    perform app.hold_share_objects(p_share_id, 'takedown');
  end if;

  update app.text_items set content = null where share_id = p_share_id;

  update app.share_links l
     set revoked_at = now(),
         revoke_reason = case when p_reason = 'blocked' then 'blocked' else 'share_ended' end,
         short_code_hmac = null,
         short_code_pepper_version = null,
         short_code_expires_at = null
   where l.share_id = p_share_id and l.revoked_at is null;

  update app.shares
     set status = v_status,
         ended_at = now(),
         end_reason = p_reason,
         updated_at = now(),
         metadata_purge_after = now()
           + make_interval(days => coalesce((v_share.entitlement_snapshot ->> 'historyRetentionDays')::integer, 30))
   where id = p_share_id;

  insert into app.audit_events (actor_kind, network_space_id, action, target_type, target_id, metadata)
  values ('system', v_share.network_space_id, 'share.ended', 'share', p_share_id::text,
          jsonb_build_object('reason', p_reason));
  return true;
end
$$;

-- ---------------------------------------------------------------------------
-- Takedown (03 §7.6), Phase 3 version: as Phase 2, plus every open outbox row of the share is put
-- on legal hold (also when the share had already ended), and the result says so (D-2).
-- ---------------------------------------------------------------------------
create or replace function app.admin_block_share(p_share_id uuid, p_reason text, p_operator text, p_report_id uuid default null)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_share app.shares;
  v_ended boolean;
  v_reports integer;
  v_objects jsonb;
begin
  if coalesce(trim(p_reason), '') = '' or coalesce(trim(p_operator), '') = '' then
    raise exception 'a reason and the operator''s name are required' using errcode = '22023';
  end if;
  select * into v_share from app.shares where id = p_share_id;
  if not found then
    raise exception 'unknown share' using errcode = '22023';
  end if;

  v_ended := app.end_share(p_share_id, 'blocked');
  perform app.hold_share_objects(p_share_id, 'takedown');
  -- A share that had already ended keeps its links revoked; make sure none is left.
  update app.share_links l
     set revoked_at = now(), revoke_reason = 'blocked',
         short_code_hmac = null, short_code_pepper_version = null, short_code_expires_at = null
   where l.share_id = p_share_id and l.revoked_at is null;

  update app.abuse_reports r
     set status = 'actioned', resolved_at = now(), resolved_by = left(p_operator, 100), action_taken = 'share_blocked'
   where r.status = 'open'
     and (r.share_id = p_share_id or r.id = p_report_id
          or r.link_id in (select l.id from app.share_links l where l.share_id = p_share_id));
  get diagnostics v_reports = row_count;

  insert into app.audit_events (actor_kind, network_space_id, action, target_type, target_id, metadata)
  values ('operator', v_share.network_space_id, 'admin.block', 'share', p_share_id::text,
          jsonb_build_object('operator', left(p_operator, 100), 'reason', left(p_reason, 500),
                             'reportId', p_report_id, 'previousStatus', v_share.status));

  select coalesce(jsonb_agg(jsonb_build_object(
           'objectKey', od.object_key,
           'legalHold', od.legal_hold,
           'holdCopy', coalesce(od.hold_copy, case when od.legal_hold then 'pending' end),
           'holdUntil', case when f.upload_url_expires_at + interval '5 minutes' > now()
                             then f.upload_url_expires_at + interval '5 minutes' end)
           order by od.object_key), '[]'::jsonb)
    into v_objects
    from app.object_deletions od
    join app.files f on f.id = od.source_file_id
   where f.share_id = p_share_id and od.completed_at is null;

  return jsonb_build_object(
    'shareId', p_share_id,
    'status', (select s.status from app.shares s where s.id = p_share_id),
    'endedNow', v_ended,
    'linksRevoked', (select count(*) from app.share_links l where l.share_id = p_share_id and l.revoke_reason = 'blocked'),
    'reportsResolved', v_reports,
    'objects', v_objects);
end
$$;

-- Release a takedown hold (D-2): run by an operator once legal review allows deletion (takedown
-- runbook). The objects then go through the normal janitor path, which deletes the hold copy with
-- the original (RISK-031); deletion starts afresh (copy failures don't count). Not granted to the app.
create function app.admin_release_hold(p_share_id uuid, p_reason text, p_operator text)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_share app.shares;
  v_released integer;
begin
  if coalesce(trim(p_reason), '') = '' or coalesce(trim(p_operator), '') = '' then
    raise exception 'a reason and the operator''s name are required' using errcode = '22023';
  end if;
  select * into v_share from app.shares where id = p_share_id;
  if not found then
    raise exception 'unknown share' using errcode = '22023';
  end if;

  update app.object_deletions od
     set legal_hold = false, hold_reason = null, not_before = now(), attempts = 0, last_error = null
    from app.files f
   where f.share_id = p_share_id and od.source_file_id = f.id and od.completed_at is null and od.legal_hold;
  get diagnostics v_released = row_count;

  insert into app.audit_events (actor_kind, network_space_id, action, target_type, target_id, metadata)
  values ('operator', v_share.network_space_id, 'admin.release_hold', 'share', p_share_id::text,
          jsonb_build_object('operator', left(p_operator, 100), 'reason', left(p_reason, 500), 'released', v_released));

  return jsonb_build_object('shareId', p_share_id, 'released', v_released);
end
$$;

-- ---------------------------------------------------------------------------
-- Janitor functions (app_janitor). SECURITY DEFINER, owned by app_owner: the janitor role has
-- no table privileges, only these. Guard rails live here, so every janitor obeys them.
-- ---------------------------------------------------------------------------

-- A run begins: records the start and reports whether the kill switch is on.
create function app.janitor_begin_run(p_mode text)
returns table (enabled boolean)
language plpgsql security definer set search_path = ''
as $$
begin
  if p_mode is null or p_mode not in ('delete', 'reconcile') then
    raise exception 'invalid janitor mode' using errcode = '22023';
  end if;
  perform app.job_started(case p_mode when 'delete' then 'storage-janitor' else 'storage-reconcile' end);
  return query select app.storage_janitor_enabled();
end
$$;

create function app.janitor_record_run(p_mode text, p_ok boolean, p_result jsonb, p_error text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_mode is null or p_mode not in ('delete', 'reconcile') or jsonb_typeof(coalesce(p_result, '{}'::jsonb)) <> 'object' then
    raise exception 'invalid janitor run record' using errcode = '22023';
  end if;
  perform app.record_job_run(case p_mode when 'delete' then 'storage-janitor' else 'storage-reconcile' end,
                             coalesce(p_ok, false), p_result, p_error);
end
$$;

-- Due outbox rows, claimed for 2 minutes (SKIP LOCKED, so overlapping runs are safe). Guard
-- rails (phase 3 §17.4): the key must have the generated format, and no file of an open share
-- (pending_upload, active or claimed) may use it. A refused row is not processed: it is
-- returned with `refused` set (and no key), parked for a day and must be investigated
-- (janitor runbook). hold_until is set while an upload URL may still be live: write a
-- tombstone instead of deleting (review M1, unchanged from Phase 1). hold_copy_key is set when a
-- released hold left a copy (RISK-031): the janitor deletes it with the original.
create function app.janitor_claim_deletions(p_limit integer)
returns table (id bigint, object_key text, reason text, hold_until timestamptz, tombstoned boolean, refused text, attempts integer,
               hold_copy_key text)
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_refused text;
  v_hold timestamptz;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'janitor batches are 1 to 500 rows' using errcode = '22023';
  end if;
  if not app.storage_janitor_enabled() then
    return;
  end if;

  for r in
    select od.id, od.object_key, od.reason, od.source_file_id, od.tombstoned_at, od.attempts, od.hold_copy
      from app.object_deletions od
     where od.completed_at is null
       and not od.legal_hold
       and od.not_before <= now()
       and (od.locked_until is null or od.locked_until <= now())
     order by od.not_before, od.id
     limit p_limit
       for update skip locked
  loop
    v_refused := case
      when not app.janitor_key_valid(r.object_key) then 'key_format'
      when exists (select 1 from app.files f join app.shares s on s.id = f.share_id
                    where f.object_key = r.object_key and s.ended_at is null) then 'share_open'
      when r.source_file_id is not null
           and exists (select 1 from app.files f where f.id = r.source_file_id and f.object_key <> r.object_key) then 'key_mismatch'
    end;
    if v_refused is not null then
      update app.object_deletions od
         set last_error = 'guard:' || v_refused, last_attempt_at = now(), not_before = now() + interval '1 day'
       where od.id = r.id;
      return query select r.id, null::text, r.reason, null::timestamptz, r.tombstoned_at is not null, v_refused, r.attempts, null::text;
      continue;
    end if;

    v_hold := (select case when f.upload_url_expires_at + interval '5 minutes' > now()
                           then f.upload_url_expires_at + interval '5 minutes' end
                 from app.files f where f.id = r.source_file_id);
    update app.object_deletions od set locked_until = now() + interval '2 minutes' where od.id = r.id;
    return query select r.id, r.object_key, r.reason, v_hold, r.tombstoned_at is not null, null::text, r.attempts,
                        case when r.hold_copy = 'copied' then 'hold/' || r.object_key end;
  end loop;
end
$$;

-- The outcome of one claimed row: deleted (done), tombstoned (rescheduled to the hold's end),
-- failed (backoff) or dry_run (lock released, nothing changed). A held row is never claimed, so
-- finishing one is refused (false): no janitor can close a takedown's record (D-2).
create function app.janitor_finish_deletion(p_id bigint, p_outcome text, p_error text default null)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  r app.object_deletions;
  v_hold timestamptz;
begin
  if p_outcome is null or p_outcome not in ('deleted', 'tombstoned', 'failed', 'dry_run') then
    raise exception 'invalid janitor outcome' using errcode = '22023';
  end if;
  select * into r from app.object_deletions od where od.id = p_id and od.completed_at is null and not od.legal_hold for update;
  if not found then
    return false;
  end if;

  if p_outcome = 'deleted' then
    update app.object_deletions od set completed_at = now(), locked_until = null, last_attempt_at = now() where od.id = p_id;
    update app.files f set object_deleted_at = coalesce(f.object_deleted_at, now()) where f.id = r.source_file_id;
  elsif p_outcome = 'tombstoned' then
    v_hold := (select f.upload_url_expires_at + interval '5 minutes' from app.files f where f.id = r.source_file_id);
    update app.object_deletions od
       set tombstoned_at = coalesce(od.tombstoned_at, now()),
           not_before = greatest(od.not_before, coalesce(v_hold, now())),
           locked_until = null,
           last_attempt_at = now()
     where od.id = p_id;
    -- The content is gone either way.
    update app.files f set object_deleted_at = coalesce(f.object_deleted_at, now()) where f.id = r.source_file_id;
  elsif p_outcome = 'failed' then
    update app.object_deletions od
       set attempts = od.attempts + 1,
           last_error = left(coalesce(nullif(p_error, ''), 'error'), 200),
           last_attempt_at = now(),
           locked_until = null,
           not_before = now() + app.janitor_backoff(od.attempts + 1)
     where od.id = p_id;
  else
    update app.object_deletions od set locked_until = null where od.id = p_id;
  end if;
  return true;
end
$$;

-- Held rows whose object still has to be copied out of the R2 lifecycle rules' reach (D-2,
-- RISK-031): the d7/, d30/ and d90/ rules delete objects at their class period + 1 day after
-- upload, held or not, and nothing covers hold/. Claimed for 2 minutes (SKIP LOCKED). A row waits
-- while an upload URL may still write to its key. Guard rail: the key must have the generated
-- format; a refused row comes back without its key and is parked for a day, as for deletions.
create function app.janitor_claim_hold_copies(p_limit integer)
returns table (id bigint, object_key text, copy_key text, refused text, attempts integer)
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'janitor batches are 1 to 500 rows' using errcode = '22023';
  end if;
  if not app.storage_janitor_enabled() then
    return;
  end if;

  for r in
    select od.id, od.object_key, od.attempts
      from app.object_deletions od
     where od.completed_at is null
       and od.legal_hold
       and od.hold_copy is null
       and od.not_before <= now()
       and (od.locked_until is null or od.locked_until <= now())
       and not exists (select 1 from app.files f
                        where f.id = od.source_file_id and f.upload_url_expires_at + interval '5 minutes' > now())
     order by od.not_before, od.id
     limit p_limit
       for update of od skip locked
  loop
    if not app.janitor_key_valid(r.object_key) then
      update app.object_deletions od
         set last_error = 'guard:key_format', last_attempt_at = now(), not_before = now() + interval '1 day'
       where od.id = r.id;
      return query select r.id, null::text, null::text, 'key_format'::text, r.attempts;
      continue;
    end if;
    update app.object_deletions od set locked_until = now() + interval '2 minutes' where od.id = r.id;
    return query select r.id, r.object_key, 'hold/' || r.object_key, null::text, r.attempts;
  end loop;
end
$$;

-- The outcome of one claimed copy: copied (hold/<key> exists), unavailable (the source was already
-- gone; recorded for the operator as hold:source_missing) or failed (backoff, as for deletions).
-- Only a held row still waiting for its copy can be finished.
create function app.janitor_finish_hold_copy(p_id bigint, p_outcome text, p_error text default null)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if p_outcome is null or p_outcome not in ('copied', 'unavailable', 'failed') then
    raise exception 'invalid hold copy outcome' using errcode = '22023';
  end if;
  if p_outcome = 'failed' then
    update app.object_deletions od
       set attempts = od.attempts + 1,
           last_error = left(coalesce(nullif(p_error, ''), 'error'), 200),
           last_attempt_at = now(),
           locked_until = null,
           not_before = now() + app.janitor_backoff(od.attempts + 1)
     where od.id = p_id and od.completed_at is null and od.legal_hold and od.hold_copy is null;
  else
    update app.object_deletions od
       set hold_copy = p_outcome,
           attempts = 0,
           last_error = case when p_outcome = 'unavailable' then 'hold:source_missing' end,
           last_attempt_at = now(),
           locked_until = null
     where od.id = p_id and od.completed_at is null and od.legal_hold and od.hold_copy is null;
  end if;
  return found;
end
$$;

-- Reconciliation (phase 3 §17.6 reconcile-r2-orphans). The running run, locked for 3 minutes.
create function app.janitor_reconcile_claim()
returns table (run_id bigint, run_cursor text, started_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
begin
  if not app.storage_janitor_enabled() then
    return;
  end if;
  return query
    with claimed as (
      update app.storage_reconcile_runs r
         set locked_until = now() + interval '3 minutes'
       where r.status = 'running' and (r.locked_until is null or r.locked_until <= now())
      returning r.id, r.last_key, r.started_at
    )
    select c.id, c.last_key, c.started_at from claimed c;
end
$$;

create function app.janitor_reconcile_release(p_run_id bigint)
returns void
language sql security definer set search_path = ''
as $$
  update app.storage_reconcile_runs r set locked_until = null where r.id = p_run_id and r.status = 'running';
$$;

-- One page of the bucket listing: keys after p_range_start (exclusive) up to the last listed key,
-- or to the end when p_done. p_keys is a JSON array of {"k": key, "m": LastModified}.
--   orphan:  a well-formed key that no pending or verified file uses, last modified more than
--            48 hours ago, with no open outbox row → queued (reason 'orphan'); the janitor
--            deletes it later with every guard rail. Never deleted from here.
--   hold:    a hold copy, hold/<generated key> (RISK-031) → counted, never queued: only a
--            released hold deletes it.
--   unknown: any other key without the generated format → counted and reported, never queued.
--   missing: a verified file of an open share, verified more than an hour before the run began,
--            whose key falls in this page's range but wasn't listed → files.object_missing_at.
-- Advances the cursor in the same transaction, so a crash resumes from the last finished page.
create function app.janitor_reconcile_page(
  p_run_id bigint,
  p_keys jsonb,
  p_range_start text,
  p_next_cursor text,
  p_done boolean
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_run app.storage_reconcile_runs;
  v_range_end text;
  v_orphans integer := 0;
  v_unknown integer := 0;
  v_missing integer := 0;
  v_hold_copies integer := 0;
  v_listed integer;
  k record;
  v_counts jsonb;
begin
  if jsonb_typeof(p_keys) is distinct from 'array' or p_done is null then
    raise exception 'invalid reconcile page' using errcode = '22023';
  end if;
  select * into v_run from app.storage_reconcile_runs r where r.id = p_run_id and r.status = 'running' for update;
  if not found then
    raise exception 'no running reconcile run %', p_run_id using errcode = '22023';
  end if;
  if v_run.last_key is distinct from p_range_start then
    raise exception 'reconcile page out of order' using errcode = '22023';
  end if;

  select count(distinct e ->> 'k')::integer, max((e ->> 'k') collate "C"),
         count(distinct e ->> 'k') filter (where not app.janitor_key_valid(e ->> 'k') and not app.janitor_hold_copy_key_valid(e ->> 'k'))::integer,
         count(distinct e ->> 'k') filter (where app.janitor_hold_copy_key_valid(e ->> 'k'))::integer
    into v_listed, v_range_end, v_unknown, v_hold_copies
    from jsonb_array_elements(p_keys) e;

  for k in
    select distinct on (e ->> 'k') e ->> 'k' as k, (e ->> 'm')::timestamptz as m
      from jsonb_array_elements(p_keys) e
     where app.janitor_key_valid(e ->> 'k')
  loop
    if k.m >= now() - interval '48 hours'
       or exists (select 1 from app.files f where f.object_key = k.k and f.upload_status in ('pending', 'verified'))
       or exists (select 1 from app.object_deletions od where od.object_key = k.k and od.completed_at is null) then
      continue;
    end if;
    insert into app.object_deletions (object_key, reason, source_file_id)
    values (k.k, 'orphan', (select f.id from app.files f where f.object_key = k.k))
    on conflict (object_key) where completed_at is null do nothing;
    if found then
      v_orphans := v_orphans + 1;
    end if;
  end loop;

  update app.files f
     set object_missing_at = coalesce(f.object_missing_at, now())
    from app.shares s
   where s.id = f.share_id
     and s.ended_at is null
     and f.upload_status = 'verified'
     and f.verified_at < v_run.started_at - interval '1 hour'
     and (p_range_start is null or f.object_key collate "C" > p_range_start collate "C")
     and (p_done or (v_range_end is not null and f.object_key collate "C" <= v_range_end collate "C"))
     and not exists (select 1 from jsonb_array_elements(p_keys) e where e ->> 'k' = f.object_key);
  get diagnostics v_missing = row_count;

  v_counts := jsonb_build_object(
    'listed', coalesce((v_run.counts ->> 'listed')::integer, 0) + v_listed,
    'orphansQueued', coalesce((v_run.counts ->> 'orphansQueued')::integer, 0) + v_orphans,
    'unknownKeys', coalesce((v_run.counts ->> 'unknownKeys')::integer, 0) + v_unknown,
    'missingObjects', coalesce((v_run.counts ->> 'missingObjects')::integer, 0) + v_missing,
    'holdCopies', coalesce((v_run.counts ->> 'holdCopies')::integer, 0) + v_hold_copies,
    'pages', coalesce((v_run.counts ->> 'pages')::integer, 0) + 1);
  update app.storage_reconcile_runs r
     set last_key = case when p_done then r.last_key else p_next_cursor end,
         counts = r.counts || v_counts,
         status = case when p_done then 'finished' else 'running' end,
         finished_at = case when p_done then now() end,
         locked_until = case when p_done then null else r.locked_until end
   where r.id = p_run_id;

  return jsonb_build_object('listed', v_listed, 'orphansQueued', v_orphans, 'unknownKeys', v_unknown, 'missingObjects', v_missing,
                            'holdCopies', v_hold_copies);
end
$$;

-- Counts that aren't per page (multipart uploads, C-5), merged into the run.
create function app.janitor_reconcile_note(p_run_id bigint, p_counts jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if jsonb_typeof(p_counts) is distinct from 'object' then
    raise exception 'invalid reconcile counts' using errcode = '22023';
  end if;
  update app.storage_reconcile_runs r set counts = r.counts || p_counts where r.id = p_run_id and r.status = 'running';
end
$$;

reset role;

-- ---------------------------------------------------------------------------
-- Scheduling side (owned by the migration role: Vault and pg_net). Granted to nobody; pg_cron
-- runs them as their owner. The secret never appears in logs, cron.job or migrations; pg_net
-- holds the request (with its Authorization header) in net.http_request_queue until it is sent.
-- ---------------------------------------------------------------------------

-- Post {"mode": …} to the storage-janitor function, only when there is work and the kill
-- switch is on: due deletions, or held rows waiting for their copy (RISK-031). A missing Vault
-- secret raises, so run_job records a failed heartbeat.
create function app.trigger_storage_janitor(p_mode text)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_due boolean;
  v_url text;
  v_secret text;
begin
  if p_mode is null or p_mode not in ('delete', 'reconcile') then
    raise exception 'invalid janitor mode' using errcode = '22023';
  end if;
  if not app.storage_janitor_enabled() then
    return jsonb_build_object('posted', false, 'reason', 'disabled');
  end if;
  if p_mode = 'delete' then
    v_due := exists (
      select 1 from app.object_deletions od
       where od.completed_at is null and od.not_before <= now()
         and (not od.legal_hold or od.hold_copy is null)
         and (od.locked_until is null or od.locked_until <= now()));
  else
    v_due := exists (
      select 1 from app.storage_reconcile_runs r
       where r.status = 'running' and (r.locked_until is null or r.locked_until <= now()));
  end if;
  if not v_due then
    return jsonb_build_object('posted', false, 'reason', 'nothing_due');
  end if;

  v_url := (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'storage_janitor_url');
  v_secret := (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'storage_janitor_secret');
  if v_url is null or v_secret is null then
    raise exception 'missing_secret' using errcode = 'P0001';
  end if;
  perform net.http_post(
    url := v_url,
    body := jsonb_build_object('mode', p_mode),
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    timeout_milliseconds := 10000);
  return jsonb_build_object('posted', true, 'mode', p_mode);
end
$$;

-- Weekly: open a reconcile run (one at a time) and start it.
create function app.start_storage_reconcile()
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
begin
  if not exists (select 1 from app.storage_reconcile_runs r where r.status = 'running') then
    insert into app.storage_reconcile_runs default values on conflict do nothing;
  end if;
  return app.trigger_storage_janitor('reconcile');
end
$$;

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
alter table app.job_heartbeats enable row level security;
alter table app.storage_reconcile_runs enable row level security;
-- /health/cron reads heartbeats; nothing else in the app touches either table.
create policy app_server_read on app.job_heartbeats for select to app_server using (true);
grant select on app.job_heartbeats to app_server;

revoke execute on all functions in schema app from public;

grant execute on function
  app.janitor_begin_run(text),
  app.janitor_record_run(text, boolean, jsonb, text),
  app.janitor_claim_deletions(integer),
  app.janitor_finish_deletion(bigint, text, text),
  app.janitor_claim_hold_copies(integer),
  app.janitor_finish_hold_copy(bigint, text, text),
  app.janitor_reconcile_claim(),
  app.janitor_reconcile_release(bigint),
  app.janitor_reconcile_page(bigint, jsonb, text, text, boolean),
  app.janitor_reconcile_note(bigint, jsonb)
to app_janitor;

-- One deletion executor (D-1): the web tier no longer claims outbox rows.
revoke execute on function app.claim_object_deletions(uuid, integer) from app_server;
