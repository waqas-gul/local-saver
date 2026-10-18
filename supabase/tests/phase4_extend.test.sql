-- Phase 4D database tests (P4-15): expiry 30/90 days and extend (phase 4 §17.8.2, §17.12, D4-13, DEC-010).
-- The request (in place or by copy, measured from the upload date), the janitor's copy claim and its guard
-- rails, the key swap, the old keys queued as superseded, a failed (partial) copy, a share ending or blocked
-- mid-copy, a copy finishing after its extension was cancelled, the deletion and reconciliation guards, the
-- purge, job health and the realtime signal. Test IDs refer to phase 4 §17.19.7.
begin;
create extension if not exists pgtap with schema extensions;

select plan(84);

delete from app.shares;
delete from app.object_deletions;
delete from app.storage_reconcile_runs;

-- ---------------------------------------------------------------------------
-- Structure and privileges
-- ---------------------------------------------------------------------------
select has_column('app', 'shares', 'extension_pending', 'shares.extension_pending exists');
select has_column('app', 'shares', 'extension_failed_at', 'shares.extension_failed_at exists');
select has_column('app', 'share_links', 'follows_share_expiry', 'share_links.follows_share_expiry exists');
select has_table('app', 'share_extension_files', 'app.share_extension_files exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'app.share_extension_files'::regclass)
  and has_table_privilege('app_server', 'app.share_extension_files', 'SELECT')
  and has_table_privilege('app_server', 'app.share_extension_files', 'INSERT')
  and not has_table_privilege('app_server', 'app.share_extension_files', 'UPDATE')
  and not has_table_privilege('app_server', 'app.share_extension_files', 'DELETE')
  and not has_table_privilege('app_janitor', 'app.share_extension_files', 'SELECT'),
  'extension rows: RLS on; the app inserts and reads them; only definer functions change them');
select ok(
  has_function_privilege('app_server', 'app.request_share_extension(uuid, uuid, integer)', 'EXECUTE')
  and not has_function_privilege('app_janitor', 'app.request_share_extension(uuid, uuid, integer)', 'EXECUTE')
  and not has_function_privilege('public', 'app.request_share_extension(uuid, uuid, integer)', 'EXECUTE')
  and not (select prosecdef from pg_proc where oid = 'app.request_share_extension(uuid, uuid, integer)'::regprocedure),
  'the app requests extensions through an invoker function');
select ok(
  has_function_privilege('app_janitor', 'app.janitor_claim_extension_copies(integer)', 'EXECUTE')
  and has_function_privilege('app_janitor', 'app.janitor_finish_extension_copy(bigint, text, text)', 'EXECUTE')
  and not has_function_privilege('app_server', 'app.janitor_claim_extension_copies(integer)', 'EXECUTE')
  and not has_function_privilege('app_server', 'app.janitor_finish_extension_copy(bigint, text, text)', 'EXECUTE')
  and (select bool_and(prosecdef) from pg_proc
        where oid in ('app.janitor_claim_extension_copies(integer)'::regprocedure, 'app.janitor_finish_extension_copy(bigint, text, text)'::regprocedure)),
  'only the janitor claims and finishes copies, through definer functions');
select ok(
  not has_function_privilege('app_server', 'app.finish_share_extension(uuid)', 'EXECUTE')
  and not has_function_privilege('app_janitor', 'app.finish_share_extension(uuid)', 'EXECUTE')
  and not has_function_privilege('public', 'app.finish_share_extension(uuid)', 'EXECUTE')
  and not has_function_privilege('app_server', 'app.stop_share_extension(uuid, bigint)', 'EXECUTE')
  and not has_function_privilege('app_janitor', 'app.stop_share_extension(uuid, bigint)', 'EXECUTE'),
  'the key swap and the failure path run only inside the janitor''s finish call');
select ok(
  has_function_privilege('app_server', 'app.cancel_share_extension(uuid)', 'EXECUTE')
  and not has_function_privilege('app_janitor', 'app.cancel_share_extension(uuid)', 'EXECUTE')
  and (select prosecdef from pg_proc where oid = 'app.cancel_share_extension(uuid)'::regprocedure),
  'end_share (run by the app) may cancel an extension, and nothing more');
select lives_ok($$
  insert into app.object_deletions (object_key, reason) values
    ('d7/2026/10/17/f4500000-0000-4000-8000-000000009901', 'superseded'),
    ('d7/2026/10/17/f4500000-0000-4000-8000-000000009902', 'extension_cancelled')$$,
  'the outbox takes the two extension reasons');
delete from app.object_deletions where object_key like 'd7/2026/10/17/f4500000-0000-4000-8000-00000000990%';
select throws_ok($$insert into app.object_deletions (object_key, reason) values ('d7/2026/10/17/f4500000-0000-4000-8000-000000009903', 'moved')$$,
  '23514', null, 'and no other new reason');

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, is_anonymous, created_at, updated_at)
values ('45000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', false, now(), now()),
       ('45000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', false, now(), now());
insert into app.network_spaces (id, network_key, key_version, family)
values ('e4500000-0000-4000-8000-000000000001', decode(repeat('e5', 32), 'hex'), 1, 6);

create function pg_temp.sid(n integer) returns uuid language sql immutable as $$
  select ('a4500000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.fid(n integer) returns uuid language sql immutable as $$
  select ('f4500000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.today() returns date language sql stable as $$ select (now() at time zone 'utc')::date $$;
create function pg_temp.share(p_n integer, p_class text, p_expires interval, p_kind text default 'files', p_status text default 'active',
                              p_burn boolean default false)
returns void language sql as $$
  insert into app.shares (id, scope, network_space_id, kind, created_by_user_id, billing_subject_type, billing_subject_id,
                          status, retention_class, expires_at, file_count, total_bytes, burn_after_download, entitlement_snapshot)
  values (pg_temp.sid(p_n), 'network', 'e4500000-0000-4000-8000-000000000001', p_kind, '45000000-0000-4000-8000-000000000001',
          'user', '45000000-0000-4000-8000-000000000001', p_status, p_class, now() + p_expires, 1, 10, p_burn,
          '{"historyRetentionDays": 365}');
$$;
-- A verified file whose key carries p_key_date (its upload date) and p_class.
create function pg_temp.vfile(p_n integer, p_share integer, p_class text, p_key_date date, p_url interval default interval '-1 hour',
                              p_mode text default 'single')
returns void language sql as $$
  insert into app.files (id, share_id, network_space_id, object_key, original_name, declared_mime, stored_content_type,
                         declared_size_bytes, size_bytes, upload_status, upload_expires_at, upload_url_expires_at, verified_at,
                         upload_mode, multipart_upload_id, part_size_bytes, part_count)
  values (pg_temp.fid(p_n), pg_temp.sid(p_share), 'e4500000-0000-4000-8000-000000000001',
          p_class || '/' || to_char(p_key_date, 'YYYY/MM/DD') || '/' || pg_temp.fid(p_n)::text, 'x.bin',
          'application/octet-stream', 'application/octet-stream',
          case when p_mode = 'multipart' then 125829120 else 10 + p_n end, case when p_mode = 'multipart' then 125829120 else 10 + p_n end,
          'verified', now(), now() + p_url, now(), p_mode,
          case when p_mode = 'multipart' then 'upload-' || p_n end, case when p_mode = 'multipart' then 16777216 end,
          case when p_mode = 'multipart' then 8 end);
$$;
create function pg_temp.link(p_id text, p_share integer, p_expires timestamptz, p_follows boolean) returns void language sql as $$
  insert into app.share_links (id, share_id, secret_hmac, pepper_version, expires_at, entitlement_snapshot, follows_share_expiry)
  values (p_id, pg_temp.sid(p_share), decode(repeat('ab', 32), 'hex'), 1, p_expires, '{}', p_follows);
$$;
create function pg_temp.key(p_file integer) returns text language sql stable as $$
  select object_key from app.files where id = pg_temp.fid(p_file) $$;
create function pg_temp.row_of(p_file integer) returns app.share_extension_files language sql stable as $$
  select * from app.share_extension_files where file_id = pg_temp.fid(p_file) order by id desc limit 1 $$;

-- s1: d7, 1 hour left, uploaded today; a link that follows the share and one with its own expiry.
select pg_temp.share(1, 'd7', interval '1 hour');
select pg_temp.vfile(101, 1, 'd7', pg_temp.today());
select pg_temp.link('linkfollowsshare', 1, now() + interval '1 hour', true);
select pg_temp.link('linkownexpiry001', 1, now() + interval '30 minutes', false);
-- s2: d7, 1 day left, three files: a single PUT (URL long dead), a single PUT whose URL is live 10 more
-- minutes, a completed multipart upload (part URLs can no longer write).
select pg_temp.share(2, 'd7', interval '1 day');
select pg_temp.vfile(201, 2, 'd7', pg_temp.today());
select pg_temp.vfile(202, 2, 'd7', pg_temp.today(), interval '10 minutes');
select pg_temp.vfile(203, 2, 'd7', pg_temp.today(), interval '50 minutes', 'multipart');
select pg_temp.link('linkfollowss2000', 2, now() + interval '1 day', true);
-- s3 still uploading; s4 burn; s5 past its expiry (the job hasn't run); s6 ended.
select pg_temp.share(3, 'd7', interval '1 day', 'files', 'pending_upload');
select pg_temp.share(4, 'd7', interval '1 day', 'files', 'active', true);
select pg_temp.vfile(401, 4, 'd7', pg_temp.today());
select pg_temp.share(5, 'd7', interval '-1 minute');
select pg_temp.vfile(501, 5, 'd7', pg_temp.today());
select pg_temp.share(6, 'd7', interval '1 day');
select pg_temp.vfile(601, 6, 'd7', pg_temp.today());
select app.end_share(pg_temp.sid(6), 'deleted_by_creator');
-- s7: d7 uploaded 7 days ago; s8: d90 uploaded 80 days ago; s9: d30 uploaded today; s10: a text.
select pg_temp.share(7, 'd7', interval '1 hour');
select pg_temp.vfile(701, 7, 'd7', pg_temp.today() - 7);
select pg_temp.share(8, 'd90', interval '5 days');
select pg_temp.vfile(801, 8, 'd90', pg_temp.today() - 80);
select pg_temp.share(9, 'd30', interval '1 day');
select pg_temp.vfile(901, 9, 'd30', pg_temp.today());
select pg_temp.share(10, 'd7', interval '1 hour', 'text');
insert into app.text_items (share_id, network_space_id, content, content_bytes) values (pg_temp.sid(10), 'e4500000-0000-4000-8000-000000000001', 'hi', 2);

create temp table rq (step text, outcome text, previous_expires_at timestamptz, new_expires_at timestamptz, new_retention_class text) on commit drop;
grant select, insert on rq to app_server;
create temp table cl (step text, id bigint, old_key text, new_key text, size_bytes bigint, refused text, attempts integer) on commit drop;
create temp table fin (step text, result text) on commit drop;
create temp table dl (step text, id bigint, object_key text, reason text, hold_until timestamptz, tombstoned boolean, refused text,
                      attempts integer, hold_copy_key text, multipart_upload_id text) on commit drop;
grant select, insert on cl, fin, dl to app_janitor;
-- app_janitor can't read extension rows: the IDs it finishes come from this copy.
create temp table ext (file_id uuid, id bigint) on commit drop;
grant select on ext to app_janitor;
create function pg_temp.sync_ext() returns void language sql as $$
  delete from ext;
  insert into ext select distinct on (file_id) file_id, id from app.share_extension_files order by file_id, id desc;
$$;
create function pg_temp.xid(p_file integer) returns bigint language sql stable as $$ select id from ext where file_id = pg_temp.fid(p_file) $$;
create temp table rc (result jsonb) on commit drop;
grant select, insert on rc to app_janitor;
create temp table old_keys as select id as file_id, object_key from app.files;
grant app_server to current_user;
grant app_janitor to current_user;

-- ---------------------------------------------------------------------------
-- Requests (as the app), T4-X2 and T4-X6 backstops
-- ---------------------------------------------------------------------------
set local role app_server;
insert into rq select 's1', * from app.request_share_extension(pg_temp.sid(1), '45000000-0000-4000-8000-000000000001', 86400);
insert into rq select 's2', * from app.request_share_extension(pg_temp.sid(2), '45000000-0000-4000-8000-000000000001', 2592000);
insert into rq select 's2 again', * from app.request_share_extension(pg_temp.sid(2), '45000000-0000-4000-8000-000000000001', 7776000);
insert into rq select 's3', * from app.request_share_extension(pg_temp.sid(3), '45000000-0000-4000-8000-000000000001', 2592000);
insert into rq select 's4', * from app.request_share_extension(pg_temp.sid(4), '45000000-0000-4000-8000-000000000001', 2592000);
insert into rq select 's1 other user', * from app.request_share_extension(pg_temp.sid(1), '45000000-0000-4000-8000-000000000002', 2592000);
insert into rq select 's5', * from app.request_share_extension(pg_temp.sid(5), '45000000-0000-4000-8000-000000000001', 2592000);
insert into rq select 's6', * from app.request_share_extension(pg_temp.sid(6), '45000000-0000-4000-8000-000000000001', 2592000);
insert into rq select 'unknown', * from app.request_share_extension(gen_random_uuid(), '45000000-0000-4000-8000-000000000001', 2592000);
insert into rq select 's1 shorter', * from app.request_share_extension(pg_temp.sid(1), '45000000-0000-4000-8000-000000000001', 3600);
insert into rq select 's7', * from app.request_share_extension(pg_temp.sid(7), '45000000-0000-4000-8000-000000000001', 86400);
insert into rq select 's8', * from app.request_share_extension(pg_temp.sid(8), '45000000-0000-4000-8000-000000000001', 7776000);
insert into rq select 's9', * from app.request_share_extension(pg_temp.sid(9), '45000000-0000-4000-8000-000000000001', 604800);
insert into rq select 's10', * from app.request_share_extension(pg_temp.sid(10), '45000000-0000-4000-8000-000000000001', 7776000);
reset role;

-- In place (T4-X2): the expiry and the links that follow it move; nothing is copied.
select is((select (outcome, previous_expires_at, new_expires_at, new_retention_class)::text from rq where step = 's1'),
  ('extended', now() + interval '1 hour', now() + interval '1 day', 'd7')::text, 'within the class from the upload date: extended in place');
select is((select (expires_at, retention_class, extension_pending)::text from app.shares where id = pg_temp.sid(1)),
  (now() + interval '1 day', 'd7', false)::text, 'the share''s expiry moves, its class doesn''t');
select is((select expires_at from app.share_links where id = 'linkfollowsshare'), now() + interval '1 day', 'a link that follows the share moves with it');
select is((select expires_at from app.share_links where id = 'linkownexpiry001'), now() + interval '30 minutes', 'a link with its own expiry stays');
select is((select count(*)::int from app.share_extension_files where share_id = pg_temp.sid(1)), 0, 'nothing to copy');
select is(
  (select count(*)::int from realtime.messages where payload ->> 'shareId' = pg_temp.sid(1)::text and payload ->> 'status' = 'active'),
  4, 'the new expiry is signalled on the space and creator topics too (share.changed, ID only; two more than the insert''s)');

-- By copy (T4-X3, the request).
select is((select (outcome, previous_expires_at, new_expires_at, new_retention_class)::text from rq where step = 's2'),
  ('pending', now() + interval '1 day', now() + interval '30 days', 'd30')::text, 'a longer class is needed: copies are queued');
select is((select (expires_at, retention_class, extension_pending)::text from app.shares where id = pg_temp.sid(2)),
  (now() + interval '1 day', 'd7', true)::text, 'the share keeps its expiry and class until the copies are done');
select is((select expires_at from app.share_links where id = 'linkfollowss2000'), now() + interval '1 day', 'and so do its links');
select is(
  (select array_agg(status || ':' || new_retention_class || ':' || (new_expires_at = now() + interval '30 days')::text order by file_id)
     from app.share_extension_files where share_id = pg_temp.sid(2)),
  array['pending:d30:true', 'pending:d30:true', 'pending:d30:true'], 'one pending row per file');
select ok(
  (select bool_and(e.old_key = f.object_key
                   and e.new_key ~ ('^d30/' || to_char(pg_temp.today(), 'YYYY/MM/DD') || '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
                   and e.new_key not like '%' || f.id::text)
     from app.share_extension_files e join app.files f on f.id = e.file_id where e.share_id = pg_temp.sid(2))
  and (select count(distinct new_key) from app.share_extension_files where share_id = pg_temp.sid(2)) = 3,
  'new keys: the new class, today''s date and a fresh UUID each (never reused)');
select is(
  (select array_agg((e.not_before = case when e.file_id = pg_temp.fid(202) then now() + interval '15 minutes' else now() end)::text order by e.file_id)
     from app.share_extension_files e where e.share_id = pg_temp.sid(2)),
  array['true', 'true', 'true'], 'a single PUT''s copy waits until its upload URL is dead (plus 5 minutes); a completed multipart doesn''t');
select is((select count(*)::int from realtime.messages
            where payload ->> 'shareId' = pg_temp.sid(2)::text and topic = 'user:45000000-0000-4000-8000-000000000001'),
  2, 'the pending extension is signalled to the creator only');
select is((select outcome from rq where step = 's2 again'), 'pending_exists', 'one extension at a time (409 EXTENSION_PENDING)');

-- Refusals (T4-X6, the database's backstops behind the API's checks).
select is(
  (select array_agg(step || '=' || outcome order by step) from rq
    where step in ('s3', 's4', 's1 other user', 's5', 's6', 'unknown', 's1 shorter')),
  array['s1 other user=not_found', 's1 shorter=not_later', 's3=not_allowed', 's4=not_allowed', 's5=not_found', 's6=not_found', 'unknown=not_found'],
  'refused: still uploading, burn, another user''s, past its expiry, ended, unknown, not later than now');
select throws_ok($$select * from app.request_share_extension('a4500000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000001', 7776001)$$,
  '22023', null, 'never beyond now + 90 days');
select throws_ok($$select * from app.request_share_extension('a4500000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000001', 0)$$,
  '22023', null, 'never a non-positive extension');

-- Measured from the upload date (lifecycle counts from upload).
select is((select (outcome, new_retention_class)::text from rq where step = 's7'), ('pending', 'd30')::text,
  'uploaded 7 days ago: a d7 object can''t safely hold one more day, so it is copied');
select is((select (outcome, new_retention_class)::text from rq where step = 's8'), ('pending', 'd90')::text,
  'a d90 object past its window is copied into a fresh d90 key (the lifecycle restarts)');
select ok((select new_key like 'd90/' || to_char(pg_temp.today(), 'YYYY/MM/DD') || '/%' from pg_temp.row_of(801)), 'with today''s date');
select is((select (outcome, new_retention_class)::text from rq where step = 's9'), ('extended', 'd30')::text, 'a d30 object uploaded today holds 7 more days in place');
select is((select (outcome, previous_expires_at, new_expires_at)::text from rq where step = 's10'),
  ('extended', now() + interval '1 hour', now() + interval '90 days')::text, 'a text has no object: always in place');
select is((select retention_class from app.shares where id = pg_temp.sid(10)), 'd7', 'and its class is untouched');

select throws_ok($$
  insert into app.share_extension_files (share_id, file_id, old_key, new_key, new_retention_class, new_expires_at, status)
  values ('a4500000-0000-4000-8000-000000000009', 'f4500000-0000-4000-8000-000000000901', 'd30/2026/10/17/f4500000-0000-4000-8000-000000000901',
          'd90/2026/10/17/f4500000-0000-4000-8000-000000009999', 'd90', now() + interval '90 days', 'bogus')$$,
  '23514', null, 'statuses are checked');
set local role app_server;
select throws_ok($$
  insert into app.share_extension_files (share_id, file_id, old_key, new_key, new_retention_class, new_expires_at, status)
  values ('a4500000-0000-4000-8000-000000000009', 'f4500000-0000-4000-8000-000000000901', 'd30/2026/10/17/f4500000-0000-4000-8000-000000000901',
          'd90/2026/10/17/f4500000-0000-4000-8000-000000009999', 'd90', now() + interval '90 days', 'copied')$$,
  '42501', null, 'the app can only insert pending rows (RLS): it can''t claim a copy was made');
reset role;

-- ---------------------------------------------------------------------------
-- The janitor's copy claim
-- ---------------------------------------------------------------------------
set local role app_janitor;
insert into cl select 'first', * from app.janitor_claim_extension_copies(100);
insert into cl select 'again', * from app.janitor_claim_extension_copies(100);
reset role;
select is(
  (select array_agg(old_key || '>' || size_bytes order by old_key) from cl where step = 'first' and refused is null),
  (select array_agg(e.old_key || '>' || f.size_bytes order by e.old_key)
     from app.share_extension_files e join app.files f on f.id = e.file_id
    where e.file_id in (pg_temp.fid(201), pg_temp.fid(203), pg_temp.fid(701), pg_temp.fid(801))),
  'due copies are claimed with their keys and the size to check; the copy behind a live upload URL waits');
select is((select count(*)::int from cl where step = 'again'), 0, 'a claimed copy is locked');
select ok((select bool_and(locked_until = now() + interval '10 minutes') from app.share_extension_files where id in (select id from cl where step = 'first')),
  'for 10 minutes, longer than one janitor invocation can run');
-- The claim checks the upload URL itself too, whatever the row's not_before says.
update app.share_extension_files set not_before = now() where file_id = pg_temp.fid(202);
set local role app_janitor;
insert into cl select 'live url', * from app.janitor_claim_extension_copies(100);
reset role;
select is((select count(*)::int from cl where step = 'live url'), 0, 'a copy behind a live upload URL is never claimed, whatever its not_before says');

-- Guard rails: s11's file no longer points at its old key; s12's new key has a deletion queued.
select pg_temp.share(11, 'd7', interval '1 day');
select pg_temp.vfile(1101, 11, 'd7', pg_temp.today());
select pg_temp.share(12, 'd7', interval '1 day');
select pg_temp.vfile(1201, 12, 'd7', pg_temp.today());
select * from app.request_share_extension(pg_temp.sid(11), '45000000-0000-4000-8000-000000000001', 2592000);
select * from app.request_share_extension(pg_temp.sid(12), '45000000-0000-4000-8000-000000000001', 2592000);
update app.files set object_key = 'd7/2026/01/01/f4500000-0000-4000-8000-000000001199' where id = pg_temp.fid(1101);
insert into app.object_deletions (object_key, reason) select new_key, 'orphan' from pg_temp.row_of(1201);
set local role app_janitor;
insert into cl select 'guards', * from app.janitor_claim_extension_copies(100);
insert into dl select 'guard', * from app.janitor_claim_deletions(100);
reset role;
select is((select array_agg(refused order by refused) from cl where step = 'guards'), array['deletion_queued', 'key_mismatch'],
  'refused: a file that moved off its old key, a new key with a deletion queued');
select ok((select bool_and(last_error like 'guard:%' and not_before > now() + interval '23 hours') from app.share_extension_files
            where file_id in (pg_temp.fid(1101), pg_temp.fid(1201))), 'refused rows are parked for a day, like outbox rows');
select is((select refused from dl where step = 'guard'
             and id = (select id from app.object_deletions where object_key = (select new_key from pg_temp.row_of(1201)))), 'extension_pending',
  'the deletion guard: a key in a pending extension is never deleted');

-- ---------------------------------------------------------------------------
-- Finishing copies and the swap (T4-X3)
-- ---------------------------------------------------------------------------
select pg_temp.sync_ext();
set local role app_janitor;
insert into fin select '201', app.janitor_finish_extension_copy(pg_temp.xid(201), 'copied');
insert into fin select '203', app.janitor_finish_extension_copy(pg_temp.xid(203), 'copied');
reset role;
select is((select array_agg(result order by step) from fin where step in ('201', '203')), array['copied', 'copied'],
  'copies are recorded one by one');
select is((select (extension_pending, expires_at)::text from app.shares where id = pg_temp.sid(2)), (true, now() + interval '1 day')::text,
  'no swap while a file is still to copy');
select is((select array_agg(object_key order by id) from app.files where share_id = pg_temp.sid(2)),
  (select array_agg(object_key order by file_id) from old_keys where file_id in (pg_temp.fid(201), pg_temp.fid(202), pg_temp.fid(203))),
  'downloads still use the old keys (the copy is invisible until the swap)');
-- 202's upload URL dies; its copy becomes due.
update app.files set upload_url_expires_at = now() - interval '10 minutes' where id = pg_temp.fid(202);
update app.share_extension_files set not_before = now() where file_id = pg_temp.fid(202);
select pg_temp.sync_ext();
set local role app_janitor;
insert into cl select '202', * from app.janitor_claim_extension_copies(100);
insert into fin select '202', app.janitor_finish_extension_copy(pg_temp.xid(202), 'copied');
reset role;
select is((select result from fin where step = '202'), 'swapped', 'the last copy swaps the keys');
select is(
  (select array_agg((f.object_key = e.new_key)::text order by f.id) from app.files f join app.share_extension_files e on e.file_id = f.id
    where f.share_id = pg_temp.sid(2)),
  array['true', 'true', 'true'], 'every file now points at its copy');
select is((select (expires_at, retention_class, extension_pending)::text from app.shares where id = pg_temp.sid(2)),
  (now() + interval '30 days', 'd30', false)::text, 'the share has its new expiry and class');
select is((select expires_at from app.share_links where id = 'linkfollowss2000'), now() + interval '30 days', 'the links that follow it move');
select is((select count(*)::int from realtime.messages where payload ->> 'shareId' = pg_temp.sid(2)::text and topic like 'net:%'),
  2, 'the swap signals the new expiry on the space topic (the insert''s signal and this one)');
select is((select array_agg(status order by file_id) from app.share_extension_files where share_id = pg_temp.sid(2)),
  array['swapped', 'swapped', 'swapped'], 'the rows are done');
select is(
  (select array_agg(od.reason || ':' || coalesce(od.source_file_id::text, 'none') || ':' || (od.not_before = now() + interval '5 minutes')::text
                    order by od.object_key)
     from app.object_deletions od where od.object_key in (select object_key from old_keys where file_id in (pg_temp.fid(201), pg_temp.fid(202), pg_temp.fid(203)))),
  array['superseded:none:true', 'superseded:none:true', 'superseded:none:true'],
  'the old keys are queued as superseded, with no source file (key_mismatch can''t apply) and 5 minutes for downloads in flight');
select is(
  (select metadata from app.audit_events where action = 'share.extended' and target_id = pg_temp.sid(2)::text),
  jsonb_build_object('from', now() + interval '1 day', 'to', now() + interval '30 days', 'mode', 'copy', 'retentionClass', 'd30'),
  'share.extended is audited with from and to');
-- The superseded rows go through the normal claim, guard rails and all.
update app.object_deletions set not_before = now()
 where object_key in (select object_key from old_keys where file_id in (pg_temp.fid(201), pg_temp.fid(202), pg_temp.fid(203)));
set local role app_janitor;
insert into dl select 'superseded', * from app.janitor_claim_deletions(100);
reset role;
select is(
  (select array_agg(coalesce(refused, 'ok') || ':' || coalesce(hold_until::text, '-') || ':' || coalesce(multipart_upload_id, '-') order by object_key)
     from dl where step = 'superseded'
      and object_key in (select object_key from old_keys where file_id in (pg_temp.fid(201), pg_temp.fid(202), pg_temp.fid(203)))),
  array['ok:-:-', 'ok:-:-', 'ok:-:-'], 'the janitor deletes the old keys: no guard refuses them, no tombstone, nothing to abort');

-- ---------------------------------------------------------------------------
-- Reconciliation (T4-X5)
-- ---------------------------------------------------------------------------
insert into app.storage_reconcile_runs default values;
create temp table run on commit drop as
  select (select id from app.storage_reconcile_runs where status = 'running') as id, (select new_key from pg_temp.row_of(801)) as new_key;
grant select on run to app_janitor;
set local role app_janitor;
insert into rc
  select app.janitor_reconcile_page((select id from run),
    jsonb_build_array(
      jsonb_build_object('k', (select new_key from run), 'm', now() - interval '3 days'),
      jsonb_build_object('k', 'd7/2026/01/02/f4500000-0000-4000-8000-000000009998', 'm', now() - interval '3 days')),
    null, null, true);
reset role;
select is((select (result ->> 'orphansQueued')::int from rc), 1, 'one orphan in the page');
select ok(not exists (select 1 from app.object_deletions where object_key = (select new_key from pg_temp.row_of(801))),
  'a pending extension''s new key is not an orphan');

-- ---------------------------------------------------------------------------
-- A failed copy, with a sibling already copied (partial copy)
-- ---------------------------------------------------------------------------
select pg_temp.share(13, 'd7', interval '1 day');
select pg_temp.vfile(1301, 13, 'd7', pg_temp.today());
select pg_temp.vfile(1302, 13, 'd7', pg_temp.today());
select * from app.request_share_extension(pg_temp.sid(13), '45000000-0000-4000-8000-000000000001', 2592000);
select pg_temp.sync_ext();
set local role app_janitor;
insert into cl select '13', * from app.janitor_claim_extension_copies(100);
insert into fin select '1301', app.janitor_finish_extension_copy(pg_temp.xid(1301), 'copied');
insert into fin select '1302 #1', app.janitor_finish_extension_copy(pg_temp.xid(1302), 'failed', 's3:500:InternalError');
reset role;
select is((select array[result] from fin where step = '1302 #1'), array['failed'], 'a failed copy is retried');
select ok((select not_before = now() + interval '1 minute' and attempts = 1 and last_error = 's3:500:InternalError' and locked_until is null
             from pg_temp.row_of(1302)), 'after the janitor''s backoff');
select pg_temp.sync_ext();
set local role app_janitor;
insert into fin select '1302 #2', app.janitor_finish_extension_copy(pg_temp.xid(1302), 'failed', 's3:500:InternalError');
insert into fin select '1302 #3', app.janitor_finish_extension_copy(pg_temp.xid(1302), 'failed', 's3:500:InternalError');
insert into fin select '1302 #4', app.janitor_finish_extension_copy(pg_temp.xid(1302), 'failed', 's3:500:InternalError');
insert into fin select '1302 #5', app.janitor_finish_extension_copy(pg_temp.xid(1302), 'failed', 's3:500:InternalError');
reset role;
select is((select array_agg(result order by step) from fin where step like '1302 #%'),
  array['failed', 'failed', 'failed', 'failed', 'extension_failed'], 'the fifth failure fails the extension');
select is((select array_agg(status order by file_id) from app.share_extension_files where share_id = pg_temp.sid(13)),
  array['cancelled', 'failed'], 'the failing row is failed, its copied sibling cancelled');
select is((select (expires_at, retention_class, extension_pending, extension_failed_at is not null)::text from app.shares where id = pg_temp.sid(13)),
  (now() + interval '1 day', 'd7', false, true)::text, 'the share keeps its expiry and class, and shows the failure');
select is((select array_agg(object_key order by id) from app.files where share_id = pg_temp.sid(13)),
  array['d7/' || to_char(pg_temp.today(), 'YYYY/MM/DD') || '/' || pg_temp.fid(1301), 'd7/' || to_char(pg_temp.today(), 'YYYY/MM/DD') || '/' || pg_temp.fid(1302)],
  'the files keep their old keys');
select is(
  (select array_agg(od.reason || ':' || coalesce(od.source_file_id::text, 'none') order by od.object_key) from app.object_deletions od
    where od.object_key in (select new_key from app.share_extension_files where share_id = pg_temp.sid(13))),
  array['extension_cancelled:none', 'extension_cancelled:none'], 'both new keys (the copy that was made, and any partial one) are queued for deletion');
select is((select count(*)::int from app.audit_events where action = 'share.extension_failed' and target_id = pg_temp.sid(13)::text), 1,
  'the failure is audited');

-- A copy that finishes after its extension ended: its new key is queued again (the first deletion may have
-- run before the object existed).
update app.object_deletions set completed_at = now() where object_key = (select new_key from pg_temp.row_of(1301));
select pg_temp.sync_ext();
set local role app_janitor;
insert into fin select 'late', app.janitor_finish_extension_copy(pg_temp.xid(1301), 'copied');
reset role;
select is((select result from fin where step = 'late'), 'stale', 'a late copy changes nothing');
select is((select count(*)::int from app.object_deletions where object_key = (select new_key from pg_temp.row_of(1301)) and completed_at is null), 1,
  'but its new key is queued again');

-- A new request after the failure starts afresh, with new keys.
select is((select outcome from app.request_share_extension(pg_temp.sid(13), '45000000-0000-4000-8000-000000000001', 2592000)), 'pending',
  'the creator may retry after a failure');
select ok(
  (select extension_failed_at is null from app.shares where id = pg_temp.sid(13))
  and (select count(distinct new_key) from app.share_extension_files where share_id = pg_temp.sid(13)) = 4,
  'the failure is cleared and the retry''s keys are new');

-- ---------------------------------------------------------------------------
-- The share ends or is blocked mid-copy (T4-X4)
-- ---------------------------------------------------------------------------
select pg_temp.share(14, 'd7', interval '1 day');
select pg_temp.vfile(1401, 14, 'd7', pg_temp.today());
select * from app.request_share_extension(pg_temp.sid(14), '45000000-0000-4000-8000-000000000001', 2592000);
update app.share_extension_files set locked_until = now() + interval '7 minutes' where file_id = pg_temp.fid(1401);
select app.end_share(pg_temp.sid(14), 'expired');
select is((select status from pg_temp.row_of(1401)), 'cancelled', 'ending the share cancels its extension');
select is(
  (select array_agg(od.reason || ':' || coalesce(od.source_file_id::text, 'none') || ':' || (od.not_before = now() + interval '7 minutes')::text
                    order by od.reason)
     from app.object_deletions od where od.object_key in ((select old_key from pg_temp.row_of(1401)), (select new_key from pg_temp.row_of(1401)))),
  array['extension_cancelled:none:true', 'share_ended:' || pg_temp.fid(1401) || ':false'],
  'the old key is queued as the share''s; the new one too, once the copy in flight has finished (its lock)');
select is((select extension_pending from app.shares where id = pg_temp.sid(14)), false, 'no extension is pending on an ended share');

select pg_temp.share(15, 'd7', interval '1 day');
select pg_temp.vfile(1501, 15, 'd7', pg_temp.today());
select * from app.request_share_extension(pg_temp.sid(15), '45000000-0000-4000-8000-000000000001', 2592000);
create temp table blocked on commit drop as select app.admin_block_share(pg_temp.sid(15), 'report', 'Op One') as result;
select is(
  (select array_agg(od.reason || ':' || od.legal_hold::text order by od.reason)
     from app.object_deletions od where od.object_key in ((select old_key from pg_temp.row_of(1501)), (select new_key from pg_temp.row_of(1501)))),
  array['extension_cancelled:true', 'share_ended:true'], 'a takedown mid-copy holds the old and the new keys');
select is(
  (select array_agg(o ->> 'objectKey' order by o ->> 'objectKey') from blocked, jsonb_array_elements(result -> 'objects') o),
  (select array[least(old_key, new_key), greatest(old_key, new_key)] from pg_temp.row_of(1501)), 'and the operator''s report lists both');
select app.admin_release_hold(pg_temp.sid(15), 'cleared', 'Op One');
select is(
  (select array_agg(od.legal_hold::text) from app.object_deletions od
    where od.object_key in ((select old_key from pg_temp.row_of(1501)), (select new_key from pg_temp.row_of(1501)))),
  array['false', 'false'], 'releasing the hold releases both');

-- The purge keeps an ended share while an outbox row for one of its extension keys is open.
update app.object_deletions set completed_at = now() where source_file_id = pg_temp.fid(1401);
update app.shares set metadata_purge_after = now() - interval '1 day' where id = pg_temp.sid(14);
select app.purge_tombstones(100);
select ok(exists (select 1 from app.shares where id = pg_temp.sid(14)), 'the purge waits for the extension key''s deletion');
update app.object_deletions set completed_at = now() where object_key = (select new_key from pg_temp.row_of(1401));
select app.purge_tombstones(100);
select ok(not exists (select 1 from app.shares where id = pg_temp.sid(14)), 'then purges the share');

-- ---------------------------------------------------------------------------
-- Job health and the janitor trigger
-- ---------------------------------------------------------------------------
-- Only extension rows are left to judge: clear the outbox guard and failure state from above.
update app.object_deletions set last_error = null, attempts = 0 where completed_at is null;
select is(app.cron_health(false) -> 'checks' ->> 'janitorFailures', 'guard_refused', 'a refused extension copy shows as guard_refused');
update app.share_extension_files set last_error = null where last_error like 'guard:%';
select is(app.cron_health(false) -> 'checks' ->> 'janitorFailures', 'failing', 'a failed extension (in the last day) shows as failing');
update app.share_extension_files set finished_at = now() - interval '25 hours', last_attempt_at = now() - interval '25 hours' where status = 'failed';
select is(app.cron_health(false) -> 'checks' ->> 'janitorFailures', 'ok', 'an old failure no longer does');
select is(app.cron_health(false) -> 'checks' ->> 'extensions', 'ok', 'extensions in progress are ok');
update app.share_extension_files set created_at = now() - interval '7 hours' where file_id = pg_temp.fid(701);
select is(app.cron_health(false) -> 'checks' ->> 'extensions', 'stuck', 'one pending for more than 6 hours is stuck');

-- pg_cron posts the janitor when an extension copy is due, even with no deletion due.
update app.object_deletions set completed_at = now() where completed_at is null;
update app.share_extension_files set not_before = now() + interval '1 hour' where status = 'pending';
create function pg_temp.janitor_posted() returns text language plpgsql as $$
begin
  return coalesce(app.trigger_storage_janitor('delete') ->> 'reason', 'posted');
exception when sqlstate 'P0001' then
  return 'posted'; -- due, but this database has no Vault secrets to post with
end
$$;
select is(pg_temp.janitor_posted(), 'nothing_due', 'nothing due: the janitor isn''t posted');
update app.share_extension_files set not_before = now() where share_id = pg_temp.sid(13) and status = 'pending';
select is(pg_temp.janitor_posted(), 'posted', 'an extension copy due: it is (the request is rolled back with this test)');

select * from finish();
rollback;
