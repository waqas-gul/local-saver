-- Phase 4D, P4-15: share expiry of 30 and 90 days, and extend (phase 4 §17.8.2, §17.12, §17.15; D4-13, DEC-010).
--
-- 30 and 90 days at creation need nothing here: Pro's options and the d30/d90 classes exist since 4B. This
-- migration adds extending a share's expiry (POST /shares/{id}/extend, lib/server/shares/extend.ts):
--
--   in place  when every object of the share outlives the new expiry by at least a day, counted from its
--             upload date (R2's lifecycle rules count from upload: a d7 object goes 8 days after it was
--             written). The upload date is the date in the key, the earliest the object can have been
--             written. A text has no object: always in place.
--   by copy   otherwise (DEC-010). The request writes one share_extension_files row per file; the storage
--             janitor copies each object to a new key (CopyObject, non-destructive) and, when the last one
--             is copied, finish_share_extension swaps the keys, sets the new expiry and class, and queues
--             the old keys as 'superseded'. Downloads use the old keys until the swap.
--
-- Deletion stays with the janitor and its guard rails (D-1): every key an extension leaves behind goes
-- through the outbox. A new key is the next class that holds the new expiry, today's date and a fresh UUID,
-- so no key is ever used twice: a retry or a repeated extension can't land on a key that an earlier
-- attempt queued for deletion. While an extension is pending, the janitor refuses to delete either of its
-- keys ('extension_pending') and reconciliation never calls them orphans. A share that ends mid-copy
-- cancels its extension and queues the new keys (held for a takedown, like the old ones).

-- ---------------------------------------------------------------------------
-- Links that follow their share's expiry (C4-7, D4-13)
-- ---------------------------------------------------------------------------
alter table app.share_links add column follows_share_expiry boolean not null default false;
-- Links made before Phase 4 carry no flag (D4-13, recommended): one whose expiry is its share's was made
-- "until the share expires", Phase 2's default.
update app.share_links l set follows_share_expiry = true from app.shares s where s.id = l.share_id and l.expires_at = s.expires_at;

-- ---------------------------------------------------------------------------
-- Shares and the outbox (§17.12.2)
-- ---------------------------------------------------------------------------
alter table app.shares
  add column extension_pending boolean not null default false,
  -- The last extension failed (its copies kept failing); cleared by the next extension. The creator sees it.
  add column extension_failed_at timestamptz,
  add constraint shares_extension_open check (not extension_pending or ended_at is null);

alter table app.object_deletions drop constraint object_deletions_reason_check;
alter table app.object_deletions add constraint object_deletions_reason_check
  check (reason in ('share_ended', 'upload_rejected', 'upload_timeout', 'orphan', 'multipart_abort', 'superseded', 'extension_cancelled'));

set role app_owner;

-- ---------------------------------------------------------------------------
-- Extension copies (§17.12.1)
-- ---------------------------------------------------------------------------
create table app.share_extension_files (
  id bigint generated always as identity primary key,
  share_id uuid not null references app.shares (id) on delete cascade,
  file_id uuid not null references app.files (id) on delete cascade,
  -- Generated keys only (the janitor's format). A copy always goes to a longer-lived class.
  old_key text not null
    check (old_key ~ '^(d7|d30|d90)/[0-9]{4}/[0-9]{2}/[0-9]{2}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  new_key text not null
    check (new_key ~ '^(d30|d90)/[0-9]{4}/[0-9]{2}/[0-9]{2}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  new_retention_class text not null check (new_retention_class in ('d30', 'd90')),
  new_expires_at timestamptz not null,
  -- pending → copied → swapped; or cancelled (the share ended, a sibling failed) or failed (5 failures).
  status text not null default 'pending' check (status in ('pending', 'copied', 'swapped', 'cancelled', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  not_before timestamptz not null default now(),
  locked_until timestamptz,
  last_attempt_at timestamptz,
  last_error text check (char_length(last_error) <= 200),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint share_extension_files_keys check (old_key <> new_key and split_part(new_key, '/', 1) = new_retention_class),
  constraint share_extension_files_finished check ((status in ('pending', 'copied')) = (finished_at is null))
);
create unique index share_extension_files_open_file_idx on app.share_extension_files (file_id) where status in ('pending', 'copied');
-- A new key is never reused, whatever became of the row that made it.
create unique index share_extension_files_new_key_idx on app.share_extension_files (new_key);
create index share_extension_files_old_key_idx on app.share_extension_files (old_key);
create index share_extension_files_due_idx on app.share_extension_files (not_before, id) where status = 'pending';
create index share_extension_files_share_idx on app.share_extension_files (share_id);

-- ---------------------------------------------------------------------------
-- The request (INV, app_server), §17.12.3. Outcomes: extended (in place), pending (copies queued),
-- not_found (unknown, not the caller's, ended or past its expiry: 404 like every creator action),
-- not_allowed (not active, burn, still uploading), pending_exists, not_later. The service checks the plan,
-- the option and the creator first; these are the database's backstops, under the share's lock.
-- ---------------------------------------------------------------------------
create function app.request_share_extension(p_share_id uuid, p_user_id uuid, p_expires_in integer)
returns table (outcome text, previous_expires_at timestamptz, new_expires_at timestamptz, new_retention_class text)
language plpgsql security invoker set search_path = ''
as $$
declare
  v_share app.shares;
  v_new timestamptz;
  v_class text;
begin
  if p_expires_in is null or p_expires_in < 1 or p_expires_in > 90 * 86400 then
    raise exception 'an extension is 1 second to 90 days from now' using errcode = '22023';
  end if;
  select * into v_share from app.shares s where s.id = p_share_id for update;
  if not found or v_share.created_by_user_id is distinct from p_user_id or v_share.ended_at is not null
     or v_share.expires_at <= now() then
    return query select 'not_found'::text, null::timestamptz, null::timestamptz, null::text;
    return;
  end if;
  if v_share.status <> 'active' or v_share.burn_after_download or v_share.retention_class not in ('d7', 'd30', 'd90')
     or exists (select 1 from app.files f where f.share_id = p_share_id and f.upload_status = 'pending') then
    return query select 'not_allowed'::text, v_share.expires_at, null::timestamptz, null::text;
    return;
  end if;
  if v_share.extension_pending then
    return query select 'pending_exists'::text, v_share.expires_at, null::timestamptz, null::text;
    return;
  end if;
  v_new := now() + make_interval(secs => p_expires_in);
  if v_new <= v_share.expires_at then
    return query select 'not_later'::text, v_share.expires_at, null::timestamptz, null::text;
    return;
  end if;

  -- In place when every object outlives the new expiry by a day: new expiry ≤ upload date + class days.
  if not exists (
    select 1 from app.files f
     where f.share_id = p_share_id and f.upload_status = 'verified'
       and v_new > (make_date(split_part(f.object_key, '/', 2)::integer, split_part(f.object_key, '/', 3)::integer,
                              split_part(f.object_key, '/', 4)::integer)::timestamp at time zone 'UTC')
                   + make_interval(days => coalesce(case split_part(f.object_key, '/', 1)
                                                      when 'd7' then 7 when 'd30' then 30 when 'd90' then 90 end, 0))
  ) then
    update app.shares s set expires_at = v_new, extension_failed_at = null, updated_at = now() where s.id = p_share_id;
    update app.share_links l set expires_at = v_new
     where l.share_id = p_share_id and l.follows_share_expiry and l.revoked_at is null;
    return query select 'extended'::text, v_share.expires_at, v_new, v_share.retention_class;
    return;
  end if;

  -- By copy: the next class that holds the new expiry from now (a d90 share: a fresh d90 key, whose
  -- lifecycle starts again), today's date, a fresh UUID.
  v_class := case when v_share.retention_class = 'd7' and v_new <= now() + interval '30 days' then 'd30' else 'd90' end;
  insert into app.share_extension_files (share_id, file_id, old_key, new_key, new_retention_class, new_expires_at, not_before)
  select p_share_id, f.id, f.object_key,
         v_class || '/' || to_char(now() at time zone 'UTC', 'YYYY/MM/DD') || '/' || gen_random_uuid()::text,
         v_class, v_new,
         -- A single PUT's URL can't be revoked (write-once, If-None-Match): copy only once it is dead, so no
         -- URL can write to the old key after the janitor deletes it (review M1).
         case when f.upload_mode = 'single' and f.upload_url_expires_at + interval '5 minutes' > now()
              then f.upload_url_expires_at + interval '5 minutes' else now() end
    from app.files f
   where f.share_id = p_share_id and f.upload_status = 'verified'
   order by f.position, f.id;
  update app.shares s set extension_pending = true, extension_failed_at = null, updated_at = now() where s.id = p_share_id;
  return query select 'pending'::text, v_share.expires_at, v_new, v_class;
end
$$;

-- ---------------------------------------------------------------------------
-- Ending an extension without its swap (internal, DEF): cancelled (p_failed_id null: the share ended) or
-- failed (p_failed_id: the row whose copy failed 5 times). Every new key is queued: a copy may exist, and
-- a copy still in flight may write one, so not before its claim lock ends. No source file: no file ever
-- pointed at a new key.
-- ---------------------------------------------------------------------------
create function app.stop_share_extension(p_share_id uuid, p_failed_id bigint)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_space uuid;
  v_n integer;
begin
  select s.network_space_id into v_space from app.shares s where s.id = p_share_id for update;
  insert into app.object_deletions (object_key, reason, source_file_id, not_before)
  select e.new_key, 'extension_cancelled', null, greatest(now(), coalesce(e.locked_until, now()))
    from app.share_extension_files e
   where e.share_id = p_share_id and e.status in ('pending', 'copied')
  on conflict (object_key) where completed_at is null do nothing;
  update app.share_extension_files e
     set status = case when e.id = p_failed_id then 'failed' else 'cancelled' end, finished_at = now(), locked_until = null
   where e.share_id = p_share_id and e.status in ('pending', 'copied');
  get diagnostics v_n = row_count;
  update app.shares s
     set extension_pending = false,
         extension_failed_at = case when p_failed_id is not null then now() else s.extension_failed_at end,
         updated_at = now()
   where s.id = p_share_id and s.extension_pending;
  if p_failed_id is not null and v_n > 0 then
    insert into app.audit_events (actor_kind, network_space_id, action, target_type, target_id, metadata)
    values ('system', v_space, 'share.extension_failed', 'share', p_share_id::text, jsonb_build_object('files', v_n));
  end if;
  return v_n;
end
$$;

-- What end_share calls (it runs as the app too): cancel, nothing else.
create function app.cancel_share_extension(p_share_id uuid)
returns integer
language sql security definer set search_path = ''
as $$
  select app.stop_share_extension(p_share_id, null);
$$;

-- ---------------------------------------------------------------------------
-- The swap (internal, DEF), when every copy is made. One transaction: the files' keys, the share's expiry
-- and class, its following links, the old keys queued, the audit. False (nothing changed) unless the share
-- is still open, unexpired and pending, every row copied and every file still at the key copied from.
-- ---------------------------------------------------------------------------
create function app.finish_share_extension(p_share_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_share app.shares;
  v_open integer;
  v_copied integer;
  v_new timestamptz;
  v_class text;
begin
  select * into v_share from app.shares s where s.id = p_share_id for update;
  if not found or v_share.ended_at is not null or not v_share.extension_pending or v_share.expires_at <= now() then
    return false;
  end if;
  perform 1 from app.files f where f.share_id = p_share_id order by f.id for update;
  select count(*)::integer, (count(*) filter (where e.status = 'copied'))::integer, max(e.new_expires_at), max(e.new_retention_class)
    into v_open, v_copied, v_new, v_class
    from app.share_extension_files e
   where e.share_id = p_share_id and e.status in ('pending', 'copied');
  if v_open = 0 or v_copied < v_open then
    return false;
  end if;
  if exists (select 1 from app.share_extension_files e
               left join app.files f on f.id = e.file_id and f.share_id = e.share_id
              where e.share_id = p_share_id and e.status = 'copied'
                and (f.id is null or f.object_key <> e.old_key or f.upload_status <> 'verified'))
     or exists (select 1 from app.files f
                 where f.share_id = p_share_id and f.upload_status = 'verified'
                   and not exists (select 1 from app.share_extension_files e where e.file_id = f.id and e.status = 'copied')) then
    return false;
  end if;

  update app.files f set object_key = e.new_key
    from app.share_extension_files e
   where e.file_id = f.id and e.share_id = p_share_id and e.status = 'copied';
  -- The old keys go like every deletion, through the outbox and the janitor's guard rails: no source file
  -- (the file has its new key now, so key_mismatch would refuse the row), after 5 minutes for downloads in
  -- flight (URLs live 60 s, previews 300 s). A single PUT's URL was dead before the copy began.
  insert into app.object_deletions (object_key, reason, source_file_id, not_before)
  select e.old_key, 'superseded', null,
         case when f.upload_mode = 'single'
              then greatest(now() + interval '5 minutes', coalesce(f.upload_url_expires_at + interval '5 minutes', now()))
              else now() + interval '5 minutes' end
    from app.share_extension_files e join app.files f on f.id = e.file_id
   where e.share_id = p_share_id and e.status = 'copied'
  on conflict (object_key) where completed_at is null do nothing;
  update app.share_extension_files e set status = 'swapped', finished_at = now(), locked_until = null
   where e.share_id = p_share_id and e.status = 'copied';
  update app.shares s
     set expires_at = v_new, retention_class = v_class, extension_pending = false, extension_failed_at = null, updated_at = now()
   where s.id = p_share_id;
  update app.share_links l set expires_at = v_new
   where l.share_id = p_share_id and l.follows_share_expiry and l.revoked_at is null;
  insert into app.audit_events (actor_kind, network_space_id, action, target_type, target_id, metadata)
  values ('system', v_share.network_space_id, 'share.extended', 'share', p_share_id::text,
          jsonb_build_object('from', v_share.expires_at, 'to', v_new, 'mode', 'copy', 'retentionClass', v_class));
  return true;
end
$$;

-- ---------------------------------------------------------------------------
-- The janitor's copies (DEF, app_janitor), like the hold copies. Claimed for 10 minutes, longer than an
-- invocation can run, so one copy is never claimed twice while in flight. A copy behind a live single-PUT
-- URL waits. Guard rails: generated keys; the share still open with this extension pending; the file still
-- at the old key; nothing using or deleting either key. A refused row comes back without its keys and is
-- parked for a day, as for deletions.
-- ---------------------------------------------------------------------------
create function app.janitor_claim_extension_copies(p_limit integer)
returns table (id bigint, old_key text, new_key text, size_bytes bigint, refused text, attempts integer)
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_refused text;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'janitor batches are 1 to 500 rows' using errcode = '22023';
  end if;
  if not app.storage_janitor_enabled() then
    return;
  end if;

  for r in
    select e.id, e.share_id, e.file_id, e.old_key, e.new_key, e.attempts
      from app.share_extension_files e
     where e.status = 'pending'
       and e.not_before <= now()
       and (e.locked_until is null or e.locked_until <= now())
       and not exists (select 1 from app.files f
                        where f.id = e.file_id and f.upload_mode = 'single' and f.upload_url_expires_at + interval '5 minutes' > now())
     order by e.not_before, e.id
     limit p_limit
       for update of e skip locked
  loop
    v_refused := case
      when not app.janitor_key_valid(r.old_key) or not app.janitor_key_valid(r.new_key) or r.old_key = r.new_key then 'key_format'
      when not exists (select 1 from app.shares s where s.id = r.share_id and s.ended_at is null and s.extension_pending) then 'share_closed'
      when not exists (select 1 from app.files f
                        where f.id = r.file_id and f.share_id = r.share_id and f.object_key = r.old_key and f.upload_status = 'verified')
        then 'key_mismatch'
      when exists (select 1 from app.files f where f.object_key = r.new_key) then 'key_in_use'
      when exists (select 1 from app.object_deletions od where od.completed_at is null and od.object_key in (r.old_key, r.new_key))
        then 'deletion_queued'
    end;
    if v_refused is not null then
      update app.share_extension_files e
         set last_error = 'guard:' || v_refused, last_attempt_at = now(), not_before = now() + interval '1 day'
       where e.id = r.id;
      return query select r.id, null::text, null::text, null::bigint, v_refused, r.attempts;
      continue;
    end if;
    update app.share_extension_files e set locked_until = now() + interval '10 minutes', last_attempt_at = now() where e.id = r.id;
    return query select r.id, r.old_key, r.new_key, (select f.size_bytes from app.files f where f.id = r.file_id), null::text, r.attempts;
  end loop;
end
$$;

-- The outcome of one claimed copy: copied (the object at the new key has the file's size), or failed
-- (backoff as for deletions; the fifth failure fails the extension). Returns copied, swapped (that was the
-- last copy), failed, extension_failed, or stale: the row was no longer pending. A copy that finishes after
-- its extension was cancelled or failed may have written its new key after that key's deletion ran, so
-- the key is queued again (held if the share was taken down).
create function app.janitor_finish_extension_copy(p_id bigint, p_outcome text, p_error text default null)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_share_id uuid;
  v_blocked boolean;
  e app.share_extension_files;
begin
  if p_outcome is null or p_outcome not in ('copied', 'failed') then
    raise exception 'invalid extension copy outcome' using errcode = '22023';
  end if;
  select x.share_id into v_share_id from app.share_extension_files x where x.id = p_id;
  if not found then
    return 'stale';
  end if;
  -- The share first, as end_share locks it.
  select s.status = 'blocked' into v_blocked from app.shares s where s.id = v_share_id for update;
  select * into e from app.share_extension_files x where x.id = p_id for update;

  if e.status <> 'pending' then
    if p_outcome = 'copied' and e.status in ('cancelled', 'failed') then
      insert into app.object_deletions (object_key, reason, source_file_id)
      values (e.new_key, 'extension_cancelled', null)
      on conflict (object_key) where completed_at is null do nothing;
      if coalesce(v_blocked, false) then
        perform app.hold_share_objects(v_share_id, 'takedown');
      end if;
    end if;
    return 'stale';
  end if;

  if p_outcome = 'copied' then
    update app.share_extension_files x
       set status = 'copied', locked_until = null, last_attempt_at = now(), last_error = null
     where x.id = p_id;
    return case when app.finish_share_extension(v_share_id) then 'swapped' else 'copied' end;
  end if;

  update app.share_extension_files x
     set attempts = x.attempts + 1,
         last_error = left(coalesce(nullif(p_error, ''), 'error'), 200),
         last_attempt_at = now(),
         locked_until = null,
         not_before = now() + app.janitor_backoff(x.attempts + 1)
   where x.id = p_id;
  if e.attempts + 1 >= 5 then
    perform app.stop_share_extension(v_share_id, p_id);
    return 'extension_failed';
  end if;
  return 'failed';
end
$$;

-- ---------------------------------------------------------------------------
-- end_share (04 §9.1, DEC-016), Phase 4D version: a pending extension ends with the share (cancelled, its
-- new keys queued; for a takedown, hold_share_objects below holds them too). Otherwise as Phase 4B.
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
    when 'room_deleted' then 'deleted'
    when 'account_deleted' then 'deleted'
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

  if v_share.extension_pending then
    perform app.cancel_share_extension(p_share_id);
  end if;

  if v_share.status = 'pending_upload' and p_reason in ('upload_failed', 'deleted_by_creator', 'expired') then
    perform app.refund_upload_volume(p_share_id);
  end if;

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
-- Legal holds (D-2) reach an extension's keys too (§17.8.2 "a hold during a pending extension holds the
-- old and the new keys"). They have no source file, so they are found through the share's extension rows.
-- ---------------------------------------------------------------------------
create or replace function app.hold_share_objects(p_share_id uuid, p_reason text)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  v_n integer;
  v_x integer;
begin
  update app.object_deletions od
     set legal_hold = true, hold_reason = coalesce(od.hold_reason, left(p_reason, 200)), locked_until = null,
         hold_copy = coalesce(od.hold_copy, case when od.tombstoned_at is not null then 'unavailable' end),
         not_before = now()
    from app.files f
   where f.share_id = p_share_id and od.source_file_id = f.id and od.completed_at is null and not od.legal_hold;
  get diagnostics v_n = row_count;
  -- An extension's keys (cancelled new keys, superseded old keys). A new key's copy may still be in flight:
  -- its hold copy waits until the copy's lock ends (the row's not_before).
  update app.object_deletions od
     set legal_hold = true, hold_reason = coalesce(od.hold_reason, left(p_reason, 200)), locked_until = null,
         hold_copy = coalesce(od.hold_copy, case when od.tombstoned_at is not null then 'unavailable' end),
         not_before = greatest(now(), od.not_before)
   where od.completed_at is null and not od.legal_hold and od.source_file_id is null
     and od.object_key in (select e.old_key from app.share_extension_files e where e.share_id = p_share_id
                           union all
                           select e.new_key from app.share_extension_files e where e.share_id = p_share_id);
  get diagnostics v_x = row_count;
  return v_n + v_x;
end
$$;

create or replace function app.admin_release_hold(p_share_id uuid, p_reason text, p_operator text)
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
   where od.completed_at is null and od.legal_hold
     and (od.source_file_id in (select f.id from app.files f where f.share_id = p_share_id)
          or (od.source_file_id is null
              and od.object_key in (select e.old_key from app.share_extension_files e where e.share_id = p_share_id
                                    union all
                                    select e.new_key from app.share_extension_files e where e.share_id = p_share_id)));
  get diagnostics v_released = row_count;

  insert into app.audit_events (actor_kind, network_space_id, action, target_type, target_id, metadata)
  values ('operator', v_share.network_space_id, 'admin.release_hold', 'share', p_share_id::text,
          jsonb_build_object('operator', left(p_operator, 100), 'reason', left(p_reason, 500), 'released', v_released));

  return jsonb_build_object('shareId', p_share_id, 'released', v_released);
end
$$;

-- Takedown (03 §7.6), Phase 4D version: the operator's list of objects includes the extension's keys.
-- Otherwise as Phase 3.
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
    left join app.files f on f.id = od.source_file_id
   where od.completed_at is null
     and (f.share_id = p_share_id
          or (od.source_file_id is null
              and od.object_key in (select e.old_key from app.share_extension_files e where e.share_id = p_share_id
                                    union all
                                    select e.new_key from app.share_extension_files e where e.share_id = p_share_id)));

  return jsonb_build_object(
    'shareId', p_share_id,
    'status', (select s.status from app.shares s where s.id = p_share_id),
    'endedNow', v_ended,
    'linksRevoked', (select count(*) from app.share_links l where l.share_id = p_share_id and l.revoke_reason = 'blocked'),
    'reportsResolved', v_reports,
    'objects', v_objects);
end
$$;

-- ---------------------------------------------------------------------------
-- purge-tombstones, Phase 4D version: a share is also kept while an outbox row for one of its extension
-- keys is open (the hold information must outlive the share row). Otherwise as Phase 3.
-- ---------------------------------------------------------------------------
create or replace function app.purge_tombstones(p_batch integer)
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
       and not exists (select 1 from app.share_extension_files e
                         join app.object_deletions od on od.object_key in (e.old_key, e.new_key) and od.completed_at is null
                        where e.share_id = s.id)
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
-- janitor_claim_deletions, Phase 4D version: a new guard rail, extension_pending: never delete a key of an
-- extension that is still pending or copied (its new key isn't in any file yet, so share_open can't
-- protect it). Otherwise as P4-14.
-- ---------------------------------------------------------------------------
create or replace function app.janitor_claim_deletions(p_limit integer)
returns table (id bigint, object_key text, reason text, hold_until timestamptz, tombstoned boolean, refused text, attempts integer,
               hold_copy_key text, multipart_upload_id text)
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
    select od.id, od.object_key, od.reason, od.source_file_id, od.tombstoned_at, od.attempts, od.hold_copy, od.multipart_upload_id
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
      when exists (select 1 from app.share_extension_files e
                    where e.status in ('pending', 'copied') and (e.old_key = r.object_key or e.new_key = r.object_key)) then 'extension_pending'
      when r.source_file_id is not null
           and exists (select 1 from app.files f where f.id = r.source_file_id and f.object_key <> r.object_key) then 'key_mismatch'
    end;
    if v_refused is not null then
      update app.object_deletions od
         set last_error = 'guard:' || v_refused, last_attempt_at = now(), not_before = now() + interval '1 day'
       where od.id = r.id;
      return query select r.id, null::text, r.reason, null::timestamptz, r.tombstoned_at is not null, v_refused, r.attempts, null::text, null::text;
      continue;
    end if;

    -- A tombstone holds a single PUT's key while its URL may be live (review M1). A multipart file has
    -- no PUT URL, and an aborted upload accepts no part.
    v_hold := case when r.multipart_upload_id is null then
                (select case when f.upload_url_expires_at + interval '5 minutes' > now()
                             then f.upload_url_expires_at + interval '5 minutes' end
                   from app.files f where f.id = r.source_file_id and f.upload_mode = 'single')
              end;
    update app.object_deletions od set locked_until = now() + interval '2 minutes' where od.id = r.id;
    return query select r.id, r.object_key, r.reason, v_hold, r.tombstoned_at is not null, null::text, r.attempts,
                        case when r.hold_copy = 'copied' then 'hold/' || r.object_key end, r.multipart_upload_id;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Reconciliation, Phase 4D version: keys in pending or copied extension rows are not orphans (a new key
-- isn't in any file until the swap). Otherwise as Phase 3.
-- ---------------------------------------------------------------------------
create or replace function app.janitor_reconcile_page(
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
       or exists (select 1 from app.object_deletions od where od.object_key = k.k and od.completed_at is null)
       or exists (select 1 from app.share_extension_files e where e.status in ('pending', 'copied') and (e.old_key = k.k or e.new_key = k.k)) then
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

-- ---------------------------------------------------------------------------
-- Job health, Phase 4D version (§17.12.3):
--   janitorFailures  also guard_refused for a parked extension copy, and failing for an extension that
--                    failed in the last 24 hours (§17.8.2 "a copy fails 5 times: janitorFailures: failing")
--   extensions       stuck when an extension has been pending for more than 6 hours (copies back off for
--                    about 2.6 hours before the fifth failure; a live upload URL delays them 20 minutes)
-- Otherwise as Phase 4C.
-- ---------------------------------------------------------------------------
create or replace function app.cron_health(p_require_egress boolean)
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
  v_billing app.runtime_flags;
  v_billing_run timestamptz := (select h.last_succeeded_at from app.job_heartbeats h where h.job = 'billing-reconcile');
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
  select * into v_billing from app.runtime_flags f where f.key = 'billing_reconcile';

  v_checks := jsonb_build_object(
    'heartbeat', case when v_beat is null then 'missing' when v_beat < now() - interval '10 minutes' then 'stale' else 'ok' end,
    'janitorBacklog', case
      when v_due > 1000 or v_oldest < now() - interval '1 hour' then 'backlog'
      when v_due > 0 and (v_janitor is null or v_janitor < now() - interval '5 minutes') and v_oldest < now() - interval '5 minutes' then 'stalled'
      else 'ok' end,
    'janitorFailures', case
      when exists (select 1 from app.object_deletions od where od.completed_at is null and od.last_error like 'guard:%')
        or exists (select 1 from app.share_extension_files e where e.status = 'pending' and e.last_error like 'guard:%') then 'guard_refused'
      when exists (select 1 from app.object_deletions od where od.completed_at is null and od.attempts >= 5)
        or exists (select 1 from app.share_extension_files e where e.status = 'failed' and e.finished_at > now() - interval '24 hours') then 'failing'
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
      else 'ok' end,
    'billingWebhooks', case
      when exists (select 1 from app.billing_events e where e.status = 'failed' and e.received_at < now() - interval '1 hour') then 'failing'
      else 'ok' end,
    'billingReconcile', case
      when not coalesce(v_billing.enabled, false) then 'not_required'
      when v_billing_run is null then case when v_billing.updated_at < now() - interval '2 days' then 'stale' else 'pending' end
      when v_billing_run < now() - interval '2 days' then 'stale'
      else 'ok' end,
    'extensions', case
      when exists (select 1 from app.share_extension_files e where e.status in ('pending', 'copied') and e.created_at < now() - interval '6 hours')
        then 'stuck'
      else 'ok' end);

  return jsonb_build_object(
    'status', case when exists (select 1 from jsonb_each_text(v_checks) c where c.value not in ('ok', 'pending', 'not_required'))
                   then 'degraded' else 'ok' end,
    'checks', v_checks);
end
$$;

-- ---------------------------------------------------------------------------
-- RLS and grants (§17.12.1): the app starts extensions and reads them; only definer functions move them on.
-- ---------------------------------------------------------------------------
alter table app.share_extension_files enable row level security;
create policy app_server_read on app.share_extension_files for select to app_server using (true);
-- Rows go in pending and untried: the app can never record a copy as made.
create policy app_server_insert_pending on app.share_extension_files for insert to app_server
  with check (status = 'pending' and attempts = 0 and locked_until is null and finished_at is null and last_error is null);
grant select, insert on app.share_extension_files to app_server;

reset role;

-- ---------------------------------------------------------------------------
-- Owned by the migration role: the janitor trigger (Vault, pg_net) and the realtime signal.
-- ---------------------------------------------------------------------------

-- The janitor is also posted when an extension copy is due. Otherwise as Phase 3.
create or replace function app.trigger_storage_janitor(p_mode text)
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
         and (od.locked_until is null or od.locked_until <= now()))
      or exists (
      select 1 from app.share_extension_files e
       where e.status = 'pending' and e.not_before <= now()
         and (e.locked_until is null or e.locked_until <= now()));
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

-- share.changed (DEC-011), Phase 4D version: also when the expiry changes (an extension), so every device
-- showing the share refetches it; and, to the creator only, when an extension starts, fails or is
-- cancelled. ID-only payload, as before.
create or replace function app.emit_share_changed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_payload jsonb;
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status or new.expires_at is distinct from old.expires_at then
    v_payload := jsonb_build_object('v', 1, 'type', 'share.changed', 'shareId', new.id, 'status', new.status);
    if new.scope = 'network' then
      perform realtime.send(v_payload, 'share.changed', 'net:' || new.network_space_id::text, true);
    end if;
    if new.created_by_user_id is not null then
      perform realtime.send(v_payload, 'share.changed', 'user:' || new.created_by_user_id::text, true);
    end if;
  elsif new.extension_pending is distinct from old.extension_pending and new.created_by_user_id is not null then
    v_payload := jsonb_build_object('v', 1, 'type', 'share.changed', 'shareId', new.id, 'status', new.status);
    perform realtime.send(v_payload, 'share.changed', 'user:' || new.created_by_user_id::text, true);
  end if;
  return null;
end
$$;

drop trigger shares_emit_changed on app.shares;
create trigger shares_emit_changed
  after insert or update of status, expires_at, extension_pending on app.shares
  for each row execute function app.emit_share_changed();

revoke execute on all functions in schema app from public;
grant execute on function app.request_share_extension(uuid, uuid, integer), app.cancel_share_extension(uuid) to app_server;
grant execute on function app.janitor_claim_extension_copies(integer), app.janitor_finish_extension_copy(bigint, text, text) to app_janitor;
