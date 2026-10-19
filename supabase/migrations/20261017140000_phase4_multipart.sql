-- Phase 4D, P4-14: multipart uploads up to the Pro file limit (phase 4 §17.8.1, §17.12.2, §17.15; DEC-026).
--
-- Files above 100 MiB go to storage in parts. The server fixes the part size and count at init, signs
-- each part's Content-Length, and completes the upload with its own ListParts result after checking
-- every part (lib/server/shares/complete.ts). Aborting an upload is destructive, so the web tier never
-- does it: like every deletion it goes through the outbox, and the storage janitor (the one deletion
-- executor, D-1) runs AbortMultipartUpload before DeleteObject.
--
-- Every outbox row for a file whose multipart upload may still be open carries the upload ID, whichever
-- path queued it (the abort route, a rejected completion, the stale-upload job, end_share for any reason),
-- through the trigger below. Without it, a share ending mid-upload (its creator deleting it, its expiry,
-- a takedown, another file's rejection) would leave the upload's parts in storage until the weekly
-- reconciliation or the lifecycle rule. Multipart rows get no tombstone: no PUT URL is ever issued for a
-- multipart file's key, and once the upload is aborted no part URL can write anything (NoSuchUpload).

-- ---------------------------------------------------------------------------
-- Files (§17.12.2)
-- ---------------------------------------------------------------------------
alter table app.files drop constraint files_upload_mode_check;
alter table app.files
  add constraint files_upload_mode_check check (upload_mode in ('single', 'multipart')),
  -- The storage's upload ID: opaque, visible ASCII.
  add column multipart_upload_id text check (char_length(multipart_upload_id) between 1 and 1024 and multipart_upload_id ~ '^[!-~]+$'),
  -- R2: parts of 5 MiB to 5 GiB, all equal but the last, at most 10,000.
  add column part_size_bytes bigint check (part_size_bytes between 5242880 and 5368709120),
  add column part_count integer check (part_count between 1 and 10000),
  add constraint files_multipart_shape check (
    (upload_mode = 'multipart') = (multipart_upload_id is not null and part_size_bytes is not null and part_count is not null)
    and (upload_mode = 'multipart' or (multipart_upload_id is null and part_size_bytes is null and part_count is null))),
  -- Completion checks parts against these two numbers: they must describe the declared size exactly.
  add constraint files_multipart_parts check (
    upload_mode <> 'multipart' or part_count = (declared_size_bytes + part_size_bytes - 1) / part_size_bytes);

-- ---------------------------------------------------------------------------
-- Deletion outbox (§17.8.1 "What multipart changes in Phase 3's janitor")
-- ---------------------------------------------------------------------------
alter table app.object_deletions drop constraint object_deletions_reason_check;
alter table app.object_deletions
  add constraint object_deletions_reason_check
    check (reason in ('share_ended', 'upload_rejected', 'upload_timeout', 'orphan', 'multipart_abort')),
  add column multipart_upload_id text check (char_length(multipart_upload_id) between 1 and 1024 and multipart_upload_id ~ '^[!-~]+$');

set role app_owner;

-- Fills an outbox row's upload ID from its file when the file's multipart upload may still be open:
-- a multipart file that was never verified (a verified one's upload was completed, so there is nothing
-- to abort). The row keeps it after the file row is purged.
create function app.object_deletions_multipart_upload()
returns trigger
language plpgsql security invoker set search_path = ''
as $$
begin
  if new.multipart_upload_id is null and new.source_file_id is not null then
    new.multipart_upload_id := (
      select f.multipart_upload_id from app.files f
       where f.id = new.source_file_id and f.object_key = new.object_key
         and f.upload_mode = 'multipart' and f.verified_at is null);
  end if;
  return new;
end
$$;

create trigger object_deletions_multipart_upload
  before insert on app.object_deletions
  for each row execute function app.object_deletions_multipart_upload();

-- ---------------------------------------------------------------------------
-- fail_stale_uploads (§17.12.3): a multipart file past its deadline is queued as multipart_abort (with
-- its upload ID); single PUTs as before. Otherwise as Phase 1.
-- ---------------------------------------------------------------------------
create or replace function app.fail_stale_uploads(p_batch integer)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  v_share uuid;
  f record;
  v_count integer := 0;
begin
  for v_share in
    select distinct fi.share_id from app.files fi
     where fi.upload_status = 'pending' and fi.upload_expires_at <= now()
     limit p_batch
  loop
    perform 1 from app.shares s where s.id = v_share for update skip locked;
    if not found then
      continue;
    end if;
    for f in
      select fi.id, fi.object_key, fi.upload_mode, fi.multipart_upload_id from app.files fi
       where fi.share_id = v_share and fi.upload_status = 'pending' and fi.upload_expires_at <= now()
       order by fi.id
       for update
    loop
      update app.files set upload_status = 'rejected', rejection_reason = 'upload_timeout' where id = f.id;
      perform app.release_reservation(r.id)
         from app.storage_reservations r where r.file_id = f.id and r.status = 'active';
      insert into app.object_deletions (object_key, reason, source_file_id, multipart_upload_id)
      values (f.object_key, case when f.upload_mode = 'multipart' then 'multipart_abort' else 'upload_timeout' end,
              f.id, f.multipart_upload_id)
      on conflict (object_key) where completed_at is null do nothing;
      v_count := v_count + 1;
    end loop;
    perform app.end_share(v_share, 'upload_failed');
  end loop;
  return v_count;
end
$$;

-- ---------------------------------------------------------------------------
-- janitor_claim_deletions (§17.12.3): also returns the upload ID to abort, and a multipart row never
-- gets a tombstone hold. Guard rails unchanged (key format, share_open, key_mismatch).
-- ---------------------------------------------------------------------------
drop function app.janitor_claim_deletions(integer);
create function app.janitor_claim_deletions(p_limit integer)
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

reset role;

revoke execute on all functions in schema app from public;
grant execute on function app.janitor_claim_deletions(integer) to app_janitor;
