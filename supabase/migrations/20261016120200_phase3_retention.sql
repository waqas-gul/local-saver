-- Phase 3: retention, cleanup, reconciliation, the egress loader role and job scheduling
-- (DEC-016, DEC-017, DEC-019; phase 3 §17.6, §17.7, §18).
--
-- Every job runs through app.run_job(), which records a heartbeat (app.job_heartbeats) on
-- success and on failure; /health/cron reads them (app.cron_health). Job functions are granted
-- to nobody: pg_cron runs them as the migration role.
--
-- Evidence (D-3): shares with abuse reports are never purged automatically, and neither are their
-- download records or the audit events about them, operator actions or reports, until the
-- evidence-retention policy is decided (Q-022).

-- The egress-list loader (D-4: a scheduled GitHub Actions job runs scripts/load-egress-ranges.cjs).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_egress_loader') then
    create role app_egress_loader nologin;
  end if;
end
$$;
grant usage on schema app to app_egress_loader;

set role app_owner;

-- ---------------------------------------------------------------------------
-- purge-tombstones (daily): ended shares after metadata_purge_after, and records after their own
-- retention dates. Cascades: files, text_items, downloads, share_links (then link_grants);
-- abuse_reports.share_id and link_id become null, which is why reported shares are kept.
-- ---------------------------------------------------------------------------
create function app.purge_tombstones(p_batch integer)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_shares integer;
  v_downloads integer;
  v_audit integer;
  v_outbox integer;
begin
  if p_batch is null or p_batch < 1 then
    raise exception 'invalid batch' using errcode = '22023';
  end if;

  with due as (
    select s.id
      from app.shares s
     where s.ended_at is not null
       and s.metadata_purge_after <= now()
       -- The hold information (tombstones, legal holds) must outlive the share row.
       and not exists (select 1 from app.files f join app.object_deletions od on od.source_file_id = f.id
                        where f.share_id = s.id and od.completed_at is null)
       and not exists (select 1 from app.abuse_reports r where r.share_id = s.id)
       and not exists (select 1 from app.abuse_reports r join app.share_links l on l.id = r.link_id where l.share_id = s.id)
     order by s.metadata_purge_after
     limit p_batch
       for update of s skip locked
  )
  delete from app.shares s using due where s.id = due.id;
  get diagnostics v_shares = row_count;

  delete from app.downloads d
   where d.id in (
     select d2.id from app.downloads d2
      where d2.retention_until <= now()
        and not exists (select 1 from app.abuse_reports r where r.share_id = d2.share_id)
        and not exists (select 1 from app.abuse_reports r join app.share_links l on l.id = r.link_id where l.share_id = d2.share_id)
      order by d2.retention_until
      limit p_batch * 10);
  get diagnostics v_downloads = row_count;

  delete from app.audit_events a
   where a.id in (
     select a2.id from app.audit_events a2
      where a2.retention_until <= now()
        and a2.action not like 'admin.%'
        and a2.action not like 'report.%'
        and not (a2.target_type = 'share' and exists (select 1 from app.abuse_reports r where r.share_id::text = a2.target_id))
        and not (a2.target_type = 'link' and exists (select 1 from app.abuse_reports r where r.link_id = a2.target_id))
      order by a2.retention_until
      limit p_batch * 10);
  get diagnostics v_audit = row_count;

  delete from app.object_deletions od
   where od.id in (
     select o2.id from app.object_deletions o2
      where o2.completed_at < now() - interval '30 days'
      order by o2.completed_at
      limit p_batch * 10);
  get diagnostics v_outbox = row_count;

  return jsonb_build_object('shares', v_shares, 'downloads', v_downloads, 'auditEvents', v_audit, 'outboxRows', v_outbox);
end
$$;

-- ---------------------------------------------------------------------------
-- reconcile-storage-usage (daily, DEC-019): per subject, lock the ledger row first, then recount
-- in new statements. A completion that has verified its file but not yet moved its reservation
-- must wait for this lock, so the recount always sees a consistent state (phase 3 §17.6).
-- Corrections above max(1 MiB, 0.1 %) are unexplained drift: audited and reported.
-- ---------------------------------------------------------------------------
create function app.reconcile_storage_usage(p_batch integer)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_cursor uuid := nullif((select h.last_result ->> 'cursor' from app.job_heartbeats h where h.job = 'reconcile-storage-usage'), '')::uuid;
  r record;
  v_old record;
  v_committed bigint;
  v_files integer;
  v_reserved bigint;
  v_threshold bigint;
  v_checked integer := 0;
  v_corrected integer := 0;
  v_drift integer := 0;
  v_max bigint := 0;
  v_last uuid;
begin
  if p_batch is null or p_batch < 1 then
    raise exception 'invalid batch' using errcode = '22023';
  end if;

  -- Subjects with bytes to count but no ledger row.
  insert into app.storage_usage (subject_type, subject_id)
  select distinct s.billing_subject_type, s.billing_subject_id
    from app.files f join app.shares s on s.id = f.share_id
   where f.upload_status = 'verified'
  union
  select distinct res.subject_type, res.subject_id from app.storage_reservations res where res.status = 'active'
  on conflict do nothing;

  for r in
    select u.subject_type, u.subject_id from app.storage_usage u
     where v_cursor is null or u.subject_id > v_cursor
     order by u.subject_id
     limit p_batch
  loop
    select u.bytes_committed, u.bytes_reserved, u.files_committed into v_old
      from app.storage_usage u
     where u.subject_type = r.subject_type and u.subject_id = r.subject_id
       for update;
    select coalesce(sum(f.size_bytes), 0), count(*)::integer into v_committed, v_files
      from app.files f join app.shares s on s.id = f.share_id
     where s.billing_subject_type = r.subject_type and s.billing_subject_id = r.subject_id and f.upload_status = 'verified';
    select coalesce(sum(res.bytes), 0) into v_reserved
      from app.storage_reservations res
     where res.subject_type = r.subject_type and res.subject_id = r.subject_id and res.status = 'active';
    v_checked := v_checked + 1;
    v_last := r.subject_id;

    if (v_old.bytes_committed, v_old.bytes_reserved, v_old.files_committed) is distinct from (v_committed, v_reserved, v_files) then
      update app.storage_usage u
         set bytes_committed = v_committed, bytes_reserved = v_reserved, files_committed = v_files, updated_at = now()
       where u.subject_type = r.subject_type and u.subject_id = r.subject_id;
      v_corrected := v_corrected + 1;
      v_threshold := greatest(1048576, (greatest(v_old.bytes_committed, v_committed) / 1000));
      v_max := greatest(v_max, abs(v_old.bytes_committed - v_committed), abs(v_old.bytes_reserved - v_reserved));
      if abs(v_old.bytes_committed - v_committed) > v_threshold or abs(v_old.bytes_reserved - v_reserved) > v_threshold then
        v_drift := v_drift + 1;
        insert into app.audit_events (actor_kind, action, target_type, target_id, metadata)
        values ('system', 'storage.drift_corrected', 'storage_subject', r.subject_id::text,
                jsonb_build_object('committedBefore', v_old.bytes_committed, 'committedAfter', v_committed,
                                   'reservedBefore', v_old.bytes_reserved, 'reservedAfter', v_reserved,
                                   'filesBefore', v_old.files_committed, 'filesAfter', v_files));
        raise warning 'storage_usage.drift subject % committed % -> %, reserved % -> %',
          r.subject_id, v_old.bytes_committed, v_committed, v_old.bytes_reserved, v_reserved;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'checked', v_checked, 'corrected', v_corrected, 'drift', v_drift, 'maxDriftBytes', v_max,
    -- Where the next run starts; null once every subject has been checked this round.
    'cursor', case when v_checked = p_batch then v_last end);
end
$$;

-- ---------------------------------------------------------------------------
-- Egress lists (D-4). Replaces one source in the caller's transaction and records the load in
-- runtime_flags('egress_ranges'), which the app's fail-closed rule reads. Refuses an empty list.
-- ---------------------------------------------------------------------------
create function app.replace_egress_ranges(p_source text, p_cidrs cidr[])
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_rows integer;
begin
  if p_source is null or p_source not in ('private_relay', 'tor') then
    raise exception 'unknown egress source' using errcode = '22023';
  end if;
  if p_cidrs is null or cardinality(p_cidrs) = 0 then
    raise exception 'refusing to empty the % list', p_source using errcode = '22023';
  end if;
  if cardinality(p_cidrs) > 200000 then
    raise exception 'too many ranges for one source' using errcode = '22023';
  end if;

  delete from app.network_egress_ranges r where r.source = p_source;
  insert into app.network_egress_ranges (cidr, source)
  select distinct c, p_source from unnest(p_cidrs) c where c is not null
  on conflict do nothing;
  get diagnostics v_rows = row_count;

  update app.runtime_flags f
     set value = jsonb_build_object(
           'loadedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'rows', coalesce(f.value -> 'rows', '{}'::jsonb) || jsonb_build_object(p_source, v_rows)),
         updated_at = now(),
         updated_by = 'load-egress-ranges'
   where f.key = 'egress_ranges';
  return v_rows;
end
$$;

-- ---------------------------------------------------------------------------
-- Job health for GET /api/v1/health/cron (phase 3 §17.12, D-5). State words only: no counts,
-- keys or IDs. An external uptime monitor alerts on the 503 the route answers when any check
-- is not ok (pending and not_required count as ok).
-- ---------------------------------------------------------------------------
create function app.cron_health(p_require_egress boolean)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_beat timestamptz := (select h.last_succeeded_at from app.job_heartbeats h where h.job = 'cron-heartbeat');
  v_janitor timestamptz := (select h.last_succeeded_at from app.job_heartbeats h where h.job = 'storage-janitor');
  v_due integer;
  v_oldest timestamptz;
  v_run app.storage_reconcile_runs;
  v_last_finished timestamptz;
  v_usage app.job_heartbeats;
  v_loaded text;
  v_volume integer;
  v_threshold integer := coalesce((select (f.value ->> 'value')::integer from app.runtime_flags f where f.key = 'janitor_daily_volume_alert'), 10000);
  v_checks jsonb;
begin
  -- Held rows count until their copy is made: until then R2's lifecycle rules may delete the
  -- original (RISK-031).
  select count(*)::integer, min(od.not_before) into v_due, v_oldest
    from app.object_deletions od
   where od.completed_at is null and od.not_before <= now() and (not od.legal_hold or od.hold_copy is null);
  select * into v_run from app.storage_reconcile_runs r order by r.id desc limit 1;
  v_last_finished := (select max(r.finished_at) from app.storage_reconcile_runs r where r.status = 'finished');
  select * into v_usage from app.job_heartbeats h where h.job = 'reconcile-storage-usage';
  v_loaded := (select f.value ->> 'loadedAt' from app.runtime_flags f where f.key = 'egress_ranges');
  select count(*)::integer into v_volume from app.object_deletions od where od.completed_at > now() - interval '24 hours';

  v_checks := jsonb_build_object(
    'heartbeat', case when v_beat is null then 'missing' when v_beat < now() - interval '10 minutes' then 'stale' else 'ok' end,
    'janitorBacklog', case
      when v_due > 1000 or v_oldest < now() - interval '1 hour' then 'backlog'
      when v_due > 0 and (v_janitor is null or v_janitor < now() - interval '5 minutes') and v_oldest < now() - interval '5 minutes' then 'stalled'
      else 'ok' end,
    'janitorFailures', case
      when exists (select 1 from app.object_deletions od where od.completed_at is null and od.last_error like 'guard:%') then 'guard_refused'
      when exists (select 1 from app.object_deletions od where od.completed_at is null and od.attempts >= 5) then 'failing'
      else 'ok' end,
    'janitorVolume', case when v_volume > v_threshold then 'unusual' else 'ok' end,
    'burnFinalize', case
      when exists (select 1 from app.shares s where s.status = 'claimed' and s.claim_grace_until < now() - interval '10 minutes') then 'late'
      else 'ok' end,
    'reconcile', case
      when v_run.id is null then 'pending'
      when v_run.status = 'running' and v_run.started_at < now() - interval '24 hours' then 'stale'
      when v_run.status = 'running' and v_last_finished is null then 'pending'
      when coalesce(v_last_finished, v_run.started_at) < now() - interval '8 days' then 'stale'
      else 'ok' end,
    'storageDrift', case
      when v_usage.job is null or v_usage.last_succeeded_at is null then 'pending'
      when v_usage.last_succeeded_at < now() - interval '2 days' then 'stale'
      when coalesce((v_usage.last_result ->> 'drift')::integer, 0) > 0 then 'drift'
      else 'ok' end,
    'egressLists', case
      when not coalesce(p_require_egress, true) then 'not_required'
      when v_loaded is null then 'missing'
      when v_loaded::timestamptz < now() - interval '3 days' then 'stale'
      else 'ok' end,
    'jobs', case
      when exists (select 1 from app.job_heartbeats h
                    where h.last_failed_at is not null and h.last_failed_at > coalesce(h.last_succeeded_at, '-infinity')) then 'failing'
      else 'ok' end);

  return jsonb_build_object(
    'status', case when exists (select 1 from jsonb_each_text(v_checks) c where c.value not in ('ok', 'pending', 'not_required'))
                   then 'degraded' else 'ok' end,
    'checks', v_checks);
end
$$;

reset role;

-- ---------------------------------------------------------------------------
-- cleanup-anonymous-users (daily; RISK-006, RISK-029). Owned by the migration role, which may
-- delete from auth.users (app_owner can't reach the auth schema). Several independent conditions
-- must all hold: anonymous, 30 days old and 30 days inactive (sign-in, session refresh, device),
-- nothing open (shares, claims, reservations, stored bytes), and not suspended (D-9: the
-- suspension record must survive). Cascades: devices (and presence), user_flags, idempotency_keys
-- and the user's Auth sessions; shares and links keep their rows with the creator set to null.
-- ---------------------------------------------------------------------------
create function app.cleanup_anonymous_users(p_batch integer)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  v_ids uuid[];
  v_deleted integer;
begin
  if p_batch is null or p_batch < 1 then
    raise exception 'invalid batch' using errcode = '22023';
  end if;

  select coalesce(array_agg(c.id), '{}') into v_ids
    from (
      select u.id
        from auth.users u
       where u.is_anonymous
         and u.created_at < now() - interval '30 days'
         and (u.last_sign_in_at is null or u.last_sign_in_at < now() - interval '30 days')
         and not exists (select 1 from auth.sessions se
                          where se.user_id = u.id
                            and greatest(se.created_at, coalesce(se.updated_at, se.created_at), coalesce(se.refreshed_at, se.created_at))
                                > now() - interval '30 days')
         and not exists (select 1 from app.devices d where d.user_id = u.id and d.last_seen_at > now() - interval '30 days')
         and not exists (select 1 from app.user_flags uf where uf.user_id = u.id and uf.suspended_at is not null)
         and not exists (select 1 from app.shares s where s.created_by_user_id = u.id and s.ended_at is null)
         and not exists (select 1 from app.shares s where s.claimed_by_user_id = u.id and s.status = 'claimed')
         and not exists (select 1 from app.storage_reservations res
                          where res.subject_type = 'user' and res.subject_id = u.id and res.status = 'active')
         and not exists (select 1 from app.storage_usage su
                          where su.subject_type = 'user' and su.subject_id = u.id and (su.bytes_committed > 0 or su.bytes_reserved > 0))
       order by u.created_at
       limit p_batch
         for update of u skip locked
    ) c;

  delete from app.storage_usage su where su.subject_type = 'user' and su.subject_id = any (v_ids);
  delete from auth.users u where u.id = any (v_ids) and u.is_anonymous;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$$;

-- ---------------------------------------------------------------------------
-- The job runner: one heartbeat per job, also when it fails (the error is caught so the failure
-- is recorded, and raised again as a warning for the database log).
-- ---------------------------------------------------------------------------
create function app.run_job(p_job text)
returns void
language plpgsql security invoker set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_job is null or p_job not in ('trigger-storage-janitor', 'finalize-burn-claims', 'purge-tombstones',
                                    'cleanup-anonymous-users', 'reconcile-storage-usage', 'reconcile-r2-orphans',
                                    'cron-heartbeat') then
    raise exception 'unknown job' using errcode = '22023';
  end if;
  perform app.job_started(p_job);
  begin
    if p_job = 'trigger-storage-janitor' then
      v_result := jsonb_build_object('delete', app.trigger_storage_janitor('delete'),
                                     'reconcile', app.trigger_storage_janitor('reconcile'));
    elsif p_job = 'finalize-burn-claims' then
      v_result := jsonb_build_object('finalized', app.finalize_claims(500));
    elsif p_job = 'purge-tombstones' then
      v_result := app.purge_tombstones(1000);
    elsif p_job = 'cleanup-anonymous-users' then
      v_result := jsonb_build_object('deleted', app.cleanup_anonymous_users(1000));
    elsif p_job = 'reconcile-storage-usage' then
      v_result := app.reconcile_storage_usage(1000);
    elsif p_job = 'reconcile-r2-orphans' then
      v_result := app.start_storage_reconcile();
    else
      v_result := '{}'::jsonb;
    end if;
    perform app.record_job_run(p_job, true, v_result);
  exception when others then
    perform app.record_job_run(p_job, false, '{}'::jsonb, sqlstate || ' ' || left(sqlerrm, 180));
    raise warning 'job % failed: % %', p_job, sqlstate, sqlerrm;
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema app from public;
grant execute on function app.cron_health(boolean) to app_server;
grant execute on function app.replace_egress_ranges(text, cidr[]) to app_egress_loader;

-- ---------------------------------------------------------------------------
-- Schedules (phase 3 §17.6). Minutes are offset so at most 8 jobs start together (04 §9.1):
-- the every-minute jobs plus the */5 and */10 ones meet at :00, so the daily and weekly jobs
-- and the heartbeat avoid multiples of 5. refresh-egress-ranges is a GitHub Actions schedule
-- (D-4, P3-00): it doesn't fit in an Edge Function.
-- ---------------------------------------------------------------------------
select cron.schedule('trigger-storage-janitor', '* * * * *', $$select app.run_job('trigger-storage-janitor')$$);
select cron.schedule('finalize-burn-claims', '* * * * *', $$select app.run_job('finalize-burn-claims')$$);
select cron.schedule('cron-heartbeat', '2-59/5 * * * *', $$select app.run_job('cron-heartbeat')$$);
select cron.schedule('purge-tombstones', '3 3 * * *', $$select app.run_job('purge-tombstones')$$);
select cron.schedule('cleanup-anonymous-users', '33 3 * * *', $$select app.run_job('cleanup-anonymous-users')$$);
select cron.schedule('reconcile-storage-usage', '4 4 * * *', $$select app.run_job('reconcile-storage-usage')$$);
select cron.schedule('reconcile-r2-orphans', '6 5 * * 0', $$select app.run_job('reconcile-r2-orphans')$$);
