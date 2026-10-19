-- Phase 4D database tests (P4-14): multipart uploads (phase 4 §17.8.1, §17.12.2). The file columns and
-- their shape, the outbox's upload ID on every path that can queue an open upload (the trigger, the
-- stale-upload job, end_share, a rejection by the app), and the janitor's claim: the upload ID to abort,
-- and no tombstone for multipart rows. Test IDs refer to phase 4 §17.19.4.
begin;
create extension if not exists pgtap with schema extensions;

select plan(30);

delete from app.shares;
delete from app.object_deletions;

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------
select has_column('app', 'files', c, 'files.' || c || ' exists') from unnest(array['multipart_upload_id', 'part_size_bytes', 'part_count']) as c;
select has_column('app', 'object_deletions', 'multipart_upload_id', 'outbox rows can carry the upload to abort');
select has_trigger('app', 'object_deletions', 'object_deletions_multipart_upload', 'the outbox fills upload IDs itself');
select ok(
  has_function_privilege('app_janitor', 'app.janitor_claim_deletions(integer)', 'EXECUTE')
  and not has_function_privilege('app_server', 'app.janitor_claim_deletions(integer)', 'EXECUTE')
  and not has_function_privilege('public', 'app.janitor_claim_deletions(integer)', 'EXECUTE')
  and (select prosecdef from pg_proc where oid = 'app.janitor_claim_deletions(integer)'::regprocedure),
  'the changed claim is still the janitor''s alone, as a definer function');

-- ---------------------------------------------------------------------------
-- Fixtures: one user, one network; shares s…1 … s…6 pending, each with files.
-- 120 MiB in 16 MiB parts: 8 parts (the last 8 MiB).
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, is_anonymous, created_at, updated_at)
values ('41000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        false, now(), now());
insert into app.network_spaces (id, network_key, key_version, family)
values ('e4100000-0000-4000-8000-000000000001', decode(repeat('e1', 32), 'hex'), 1, 6);
insert into app.shares (id, scope, network_space_id, kind, created_by_user_id, billing_subject_type, billing_subject_id,
                        status, retention_class, expires_at, file_count, total_bytes, entitlement_snapshot)
select ('a4100000-0000-4000-8000-00000000000' || i)::uuid, 'network', 'e4100000-0000-4000-8000-000000000001', 'files',
       '41000000-0000-4000-8000-000000000001', 'user', '41000000-0000-4000-8000-000000000001', 'pending_upload', 'd7',
       now() + interval '1 day', 1, 125829120, '{"historyRetentionDays": 365}'
  from generate_series(1, 6) as i;

create function pg_temp.multipart_file(p_file text, p_share text, p_deadline interval default interval '24 hours')
returns void language sql as $$
  insert into app.files (id, share_id, network_space_id, object_key, original_name, declared_mime, stored_content_type,
                         declared_size_bytes, upload_expires_at, upload_url_expires_at, upload_mode, multipart_upload_id,
                         part_size_bytes, part_count)
  values (p_file::uuid, p_share::uuid, 'e4100000-0000-4000-8000-000000000001', 'd7/2026/10/17/' || p_file, 'big.bin',
          'application/octet-stream', 'application/octet-stream', 125829120, now() + p_deadline, now() + interval '50 minutes',
          'multipart', 'upload-' || right(p_file, 4), 16777216, 8);
$$;
create function pg_temp.single_file(p_file text, p_share text, p_deadline interval default interval '24 hours')
returns void language sql as $$
  insert into app.files (id, share_id, network_space_id, object_key, original_name, declared_mime, stored_content_type,
                         declared_size_bytes, upload_expires_at, upload_url_expires_at)
  values (p_file::uuid, p_share::uuid, 'e4100000-0000-4000-8000-000000000001', 'd7/2026/10/17/' || p_file, 'small.txt',
          'text/plain', 'application/octet-stream', 10, now() + p_deadline, now() + interval '10 minutes');
$$;

-- ---------------------------------------------------------------------------
-- The file shape (§17.12.2)
-- ---------------------------------------------------------------------------
select lives_ok($$select pg_temp.multipart_file('f4100000-0000-4000-8000-000000000101', 'a4100000-0000-4000-8000-000000000001')$$,
  'a multipart file has its upload ID, part size and part count');
select throws_ok($$
  insert into app.files (share_id, object_key, original_name, declared_mime, stored_content_type, declared_size_bytes, upload_expires_at,
                         upload_mode, part_size_bytes, part_count)
  values ('a4100000-0000-4000-8000-000000000001', 'd7/2026/10/17/f4100000-0000-4000-8000-000000000901', 'x', 'x', 'x', 125829120,
          now(), 'multipart', 16777216, 8)$$,
  '23514', null, 'a multipart file without its upload ID is refused');
select throws_ok($$
  insert into app.files (share_id, object_key, original_name, declared_mime, stored_content_type, declared_size_bytes, upload_expires_at,
                         part_size_bytes)
  values ('a4100000-0000-4000-8000-000000000001', 'd7/2026/10/17/f4100000-0000-4000-8000-000000000902', 'x', 'x', 'x', 10, now(), 16777216)$$,
  '23514', null, 'a single PUT carries no multipart columns');
select throws_ok($$
  insert into app.files (share_id, object_key, original_name, declared_mime, stored_content_type, declared_size_bytes, upload_expires_at,
                         upload_mode, multipart_upload_id, part_size_bytes, part_count)
  values ('a4100000-0000-4000-8000-000000000001', 'd7/2026/10/17/f4100000-0000-4000-8000-000000000903', 'x', 'x', 'x', 125829120,
          now(), 'multipart', 'u', 16777216, 7)$$,
  '23514', null, 'the part count must cover the declared size exactly');
select throws_ok($$
  insert into app.files (share_id, object_key, original_name, declared_mime, stored_content_type, declared_size_bytes, upload_expires_at,
                         upload_mode, multipart_upload_id, part_size_bytes, part_count)
  values ('a4100000-0000-4000-8000-000000000001', 'd7/2026/10/17/f4100000-0000-4000-8000-000000000904', 'x', 'x', 'x', 125829120,
          now(), 'multipart', 'u', 1048576, 120)$$,
  '23514', null, 'parts are at least 5 MiB (R2)');
select throws_ok($$
  insert into app.files (share_id, object_key, original_name, declared_mime, stored_content_type, declared_size_bytes, upload_expires_at,
                         upload_mode, multipart_upload_id, part_size_bytes, part_count)
  values ('a4100000-0000-4000-8000-000000000001', 'd7/2026/10/17/f4100000-0000-4000-8000-000000000905', 'x', 'x', 'x', 125829120,
          now(), 'multipart', 'an id', 16777216, 8)$$,
  '23514', null, 'an upload ID is visible ASCII');
-- P4-15 added superseded and extension_cancelled (supabase/tests/phase4_extend.test.sql); anything else is still refused.
select throws_ok($$
  insert into app.object_deletions (object_key, reason) values ('d7/2026/10/17/f4100000-0000-4000-8000-000000000906', 'aborted')$$,
  '23514', null, 'the outbox takes no reason beyond the planned ones');

-- ---------------------------------------------------------------------------
-- The outbox's upload ID (the trigger) on each path
-- ---------------------------------------------------------------------------
-- s…1: its pending multipart file plus a pending single file; the creator deletes the share.
select pg_temp.single_file('f4100000-0000-4000-8000-000000000102', 'a4100000-0000-4000-8000-000000000001');
select app.end_share('a4100000-0000-4000-8000-000000000001', 'deleted_by_creator');
select is((select array[reason, multipart_upload_id] from app.object_deletions where source_file_id = 'f4100000-0000-4000-8000-000000000101'),
  array['share_ended', 'upload-0101'], 'a share ending mid-upload queues its open upload for the janitor to abort');
select is((select multipart_upload_id from app.object_deletions where source_file_id = 'f4100000-0000-4000-8000-000000000102'), null,
  'a single PUT''s row carries no upload ID');

-- s…2: a multipart file that was completed and verified, then the share ended: nothing left to abort.
select pg_temp.multipart_file('f4100000-0000-4000-8000-000000000201', 'a4100000-0000-4000-8000-000000000002');
update app.files set upload_status = 'verified', size_bytes = declared_size_bytes, verified_at = now()
 where id = 'f4100000-0000-4000-8000-000000000201';
update app.shares set status = 'active' where id = 'a4100000-0000-4000-8000-000000000002';
select app.end_share('a4100000-0000-4000-8000-000000000002', 'expired');
select is((select array[reason, coalesce(multipart_upload_id, '-')] from app.object_deletions where source_file_id = 'f4100000-0000-4000-8000-000000000201'),
  array['share_ended', '-'], 'a completed upload is deleted as an object, with no abort');

-- s…3: the app rejects a multipart file at completion (lib/server/shares/complete.ts) as app_server.
select pg_temp.multipart_file('f4100000-0000-4000-8000-000000000301', 'a4100000-0000-4000-8000-000000000003');
grant app_server to current_user;
set local role app_server;
update app.files set upload_status = 'rejected', rejection_reason = 'multipart_invalid' where id = 'f4100000-0000-4000-8000-000000000301';
insert into app.object_deletions (object_key, reason, source_file_id)
values ('d7/2026/10/17/f4100000-0000-4000-8000-000000000301', 'upload_rejected', 'f4100000-0000-4000-8000-000000000301');
reset role;
select app.end_share('a4100000-0000-4000-8000-000000000003', 'upload_failed');
select is((select multipart_upload_id from app.object_deletions where source_file_id = 'f4100000-0000-4000-8000-000000000301'),
  'upload-0301', 'a rejection queued by the web tier carries the upload ID too');

-- An explicit upload ID is kept; a row for another key gets none from the file.
insert into app.object_deletions (object_key, reason, source_file_id, multipart_upload_id)
values ('d7/2026/10/17/f4100000-0000-4000-8000-000000000907', 'multipart_abort', 'f4100000-0000-4000-8000-000000000301', 'explicit');
insert into app.object_deletions (object_key, reason, source_file_id)
values ('d7/2026/10/17/f4100000-0000-4000-8000-000000000908', 'orphan', 'f4100000-0000-4000-8000-000000000301');
select is(
  (select array_agg(coalesce(multipart_upload_id, '-') order by object_key) from app.object_deletions
    where object_key in ('d7/2026/10/17/f4100000-0000-4000-8000-000000000907', 'd7/2026/10/17/f4100000-0000-4000-8000-000000000908')),
  array['explicit', '-'], 'an explicit upload ID is kept, and only the file''s own key gets the file''s');
-- (Both would be refused by the key_mismatch guard rail; they were only for the trigger.)
delete from app.object_deletions where object_key in ('d7/2026/10/17/f4100000-0000-4000-8000-000000000907', 'd7/2026/10/17/f4100000-0000-4000-8000-000000000908');

-- s…4 (T4-M11): a multipart file and a single file past their deadline.
select pg_temp.multipart_file('f4100000-0000-4000-8000-000000000401', 'a4100000-0000-4000-8000-000000000004', interval '-1 minute');
select pg_temp.single_file('f4100000-0000-4000-8000-000000000402', 'a4100000-0000-4000-8000-000000000004', interval '-1 minute');
select app.reserve_storage('user', '41000000-0000-4000-8000-000000000001', 'f4100000-0000-4000-8000-000000000401', 125829120,
                           107374182400, interval '26 hours');
select is(app.fail_stale_uploads(100), 2, 'the stale-upload job fails both files');
select is((select array[reason, multipart_upload_id] from app.object_deletions where source_file_id = 'f4100000-0000-4000-8000-000000000401'),
  array['multipart_abort', 'upload-0401'], 'an abandoned multipart upload is queued as multipart_abort with its upload ID');
select is((select array[reason, coalesce(multipart_upload_id, '-')] from app.object_deletions where source_file_id = 'f4100000-0000-4000-8000-000000000402'),
  array['upload_timeout', '-'], 'an abandoned single PUT is queued as before');
select is((select array[upload_status, rejection_reason] from app.files where id = 'f4100000-0000-4000-8000-000000000401'),
  array['rejected', 'upload_timeout'], 'the file is rejected');
select is((select status from app.storage_reservations where file_id = 'f4100000-0000-4000-8000-000000000401'), 'released',
  'its 26-hour reservation is released');
select is((select status from app.shares where id = 'a4100000-0000-4000-8000-000000000004'), 'failed',
  'the share fails, all or nothing (DV1-10)');

-- ---------------------------------------------------------------------------
-- janitor_claim_deletions: the upload to abort, and no tombstone for multipart rows
-- ---------------------------------------------------------------------------
-- s…5: a single PUT whose URL is still live (tombstone), queued like the others.
select pg_temp.single_file('f4100000-0000-4000-8000-000000000501', 'a4100000-0000-4000-8000-000000000005');
select app.end_share('a4100000-0000-4000-8000-000000000005', 'deleted_by_creator');
-- Every multipart file above has a part URL live for 50 more minutes (upload_url_expires_at).

create temp table claimed (id bigint, object_key text, reason text, hold_until timestamptz, tombstoned boolean, refused text,
                           attempts int, hold_copy_key text, multipart_upload_id text) on commit drop;
grant select, insert on claimed to app_janitor;
grant app_janitor to current_user;
set local role app_janitor;
insert into claimed select * from app.janitor_claim_deletions(100);
reset role;

select is((select array[coalesce(multipart_upload_id, '-'), coalesce(hold_until::text, '-')] from claimed
            where object_key = 'd7/2026/10/17/f4100000-0000-4000-8000-000000000101'),
  array['upload-0101', '-'], 'an open upload is claimed with its upload ID, to delete outright although a part URL is live');
select is((select array[coalesce(multipart_upload_id, '-'), coalesce(hold_until::text, '-')] from claimed
            where object_key = 'd7/2026/10/17/f4100000-0000-4000-8000-000000000201'),
  array['-', '-'], 'a completed multipart object is deleted outright: no upload to abort, no PUT URL to hold against');
select is((select array[multipart_upload_id] from claimed where object_key = 'd7/2026/10/17/f4100000-0000-4000-8000-000000000401'),
  array['upload-0401'], 'the stale-upload job''s row reaches the janitor with its upload ID');
select ok((select multipart_upload_id is null and hold_until > now() from claimed
            where object_key = 'd7/2026/10/17/f4100000-0000-4000-8000-000000000501'),
  'a single PUT with a live URL still gets its tombstone (review M1, unchanged)');
select is((select count(*)::int from claimed where refused is not null), 0, 'no guard rail refused a row');

-- A refused row never hands out its upload ID: s…6's file is still uploading (share_open).
select pg_temp.multipart_file('f4100000-0000-4000-8000-000000000601', 'a4100000-0000-4000-8000-000000000006');
insert into app.object_deletions (object_key, reason, source_file_id)
values ('d7/2026/10/17/f4100000-0000-4000-8000-000000000601', 'multipart_abort', 'f4100000-0000-4000-8000-000000000601');
delete from claimed;
set local role app_janitor;
insert into claimed select * from app.janitor_claim_deletions(100);
reset role;
select is((select array[refused, coalesce(object_key, '-'), coalesce(multipart_upload_id, '-')] from claimed),
  array['share_open', '-', '-'], 'an upload of an open share is never aborted, and its upload ID is not handed out');

select * from finish();
rollback;
