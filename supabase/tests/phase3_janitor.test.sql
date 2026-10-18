-- Phase 3 database tests (P3-02): the storage janitor's functions and guard rails (T-043), legal
-- hold (D-2) and its copies out of the lifecycle rules' reach (RISK-031), backoff, reconciliation
-- (T-044 database part), the cron trigger, job heartbeats and grants. Test IDs refer to 09 §4 and
-- phase 3 §17.15.
begin;
create extension if not exists pgtap with schema extensions;

select plan(89);

-- Other suites and earlier runs leave outbox rows, runs and open shares behind (whose files the
-- reconciliation below would count as missing); this transaction starts clean.
delete from app.shares;
delete from app.object_deletions;
delete from app.storage_reconcile_runs;
delete from app.job_heartbeats;

-- ---------------------------------------------------------------------------
-- Structure and grants (C-4: a least-privilege janitor role)
-- ---------------------------------------------------------------------------
select has_table('app', t, 'app.' || t || ' exists') from unnest(array['job_heartbeats', 'storage_reconcile_runs']) as t;
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relname in ('job_heartbeats', 'storage_reconcile_runs') and c.relrowsecurity),
  2, 'row level security is enabled on the job tables');
select is(
  (select array_agg(p.priv order by p.priv) from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p(priv)
    where has_table_privilege('app_server', 'app.job_heartbeats', p.priv)),
  array['SELECT'], 'app_server may only read job heartbeats (for /health/cron)');
select is(
  (select count(*)::int from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p(priv)
    where has_table_privilege('app_server', 'app.storage_reconcile_runs', p.priv)),
  0, 'app_server has no access to reconcile runs');
select is(
  (select count(*)::int
     from pg_class c join pg_namespace n on n.oid = c.relnamespace,
          unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p(priv)
    where n.nspname = 'app' and c.relkind = 'r' and has_table_privilege('app_janitor', c.oid, p.priv)),
  0, 'the janitor role has no table privileges at all');
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and has_function_privilege('app_janitor', p.oid, 'EXECUTE')),
  -- Phase 4D (§17.12.3, P4-15): the extension copies' claim and finish join the list.
  array['janitor_begin_run', 'janitor_claim_deletions', 'janitor_claim_extension_copies', 'janitor_claim_hold_copies',
        'janitor_finish_deletion', 'janitor_finish_extension_copy', 'janitor_finish_hold_copy', 'janitor_reconcile_claim',
        'janitor_reconcile_note', 'janitor_reconcile_page', 'janitor_reconcile_release', 'janitor_record_run'],
  'the janitor role may run exactly the janitor functions');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname like 'janitor\_%' and has_function_privilege('app_server', p.oid, 'EXECUTE')),
  0, 'the web tier cannot run janitor functions');
select ok(
  not has_function_privilege('app_server', 'app.trigger_storage_janitor(text)', 'EXECUTE')
  and not has_function_privilege('app_janitor', 'app.trigger_storage_janitor(text)', 'EXECUTE')
  and not has_function_privilege('app_server', 'app.record_job_run(text, boolean, jsonb, text)', 'EXECUTE')
  and not has_function_privilege('app_server', 'app.admin_release_hold(uuid, text, text)', 'EXECUTE')
  and not has_function_privilege('app_janitor', 'app.admin_release_hold(uuid, text, text)', 'EXECUTE'),
  'the trigger, heartbeats and hold release are not callable by the app or the janitor');
select is((select enabled from app.runtime_flags where key = 'storage_janitor_enabled'), true,
  'the janitor kill switch exists and defaults to on');

select is(
  array[app.janitor_backoff(1), app.janitor_backoff(2), app.janitor_backoff(3), app.janitor_backoff(4), app.janitor_backoff(5),
        app.janitor_backoff(9)],
  array[interval '1 minute', interval '5 minutes', interval '30 minutes', interval '2 hours', interval '12 hours', interval '12 hours'],
  'backoff after the 1st … 5th failure, then every 12 hours');
select is(
  array[app.janitor_key_valid('d7/2026/10/16/f4000000-0000-4000-8000-000000000001'),
        app.janitor_key_valid('d7/2026/10/16/------------------------------------'),
        app.janitor_key_valid('../d7/2026/10/16/f4000000-0000-4000-8000-000000000001'),
        app.janitor_key_valid(null)],
  array[true, false, false, false], 'only generated keys are valid');
select is(
  array[app.janitor_hold_copy_key_valid('hold/d7/2026/10/16/f4000000-0000-4000-8000-000000000001'),
        app.janitor_hold_copy_key_valid('d7/2026/10/16/f4000000-0000-4000-8000-000000000001'),
        app.janitor_hold_copy_key_valid('hold/hold/d7/2026/10/16/f4000000-0000-4000-8000-000000000001'),
        app.janitor_key_valid('hold/d7/2026/10/16/f4000000-0000-4000-8000-000000000001'),
        app.janitor_hold_copy_key_valid(null)],
  array[true, false, false, false, false], 'a hold copy key is hold/ plus a generated key, and never a generated key itself');
select has_column('app', 'object_deletions', 'hold_copy', 'outbox rows record their hold copy (RISK-031)');

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, is_anonymous, created_at, updated_at)
values ('40000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        true, now(), now());
insert into app.network_spaces (id, network_key, key_version, family)
values ('e4000000-0000-4000-8000-000000000001', decode(repeat('ef', 32), 'hex'), 1, 6);
-- s…1 ended later (deleted), s…2 active, s…3 claimed burn, s…4 ended with a live upload URL,
-- s…5 blocked, s…6 expired then taken down.
insert into app.shares (id, scope, network_space_id, kind, created_by_user_id, billing_subject_type, billing_subject_id,
                        status, retention_class, expires_at, burn_after_download, file_count, total_bytes, entitlement_snapshot)
select ('a4000000-0000-4000-8000-00000000000' || i)::uuid, 'network', 'e4000000-0000-4000-8000-000000000001', 'files',
       '40000000-0000-4000-8000-000000000001', 'user', '40000000-0000-4000-8000-000000000001', 'active', 'd7',
       now() + interval '1 day', i = 3, 1, 10, '{"historyRetentionDays": 30}'
  from generate_series(1, 6) as i;
insert into app.files (id, share_id, network_space_id, object_key, original_name, declared_mime, stored_content_type,
                       declared_size_bytes, size_bytes, upload_status, upload_expires_at, upload_url_expires_at, verified_at)
select ('f4000000-0000-4000-8000-00000000000' || i)::uuid, ('a4000000-0000-4000-8000-00000000000' || i)::uuid,
       'e4000000-0000-4000-8000-000000000001', 'd7/2026/10/16/f4000000-0000-4000-8000-00000000000' || i, 'x.bin',
       'application/octet-stream', 'application/octet-stream', 10, 10, 'verified', now() + interval '2 hours',
       case when i = 4 then now() + interval '10 minutes' else now() - interval '1 hour' end, now() - interval '2 hours'
  from generate_series(1, 6) as i;
update app.shares set status = 'claimed', claimed_at = now(), claim_grace_until = now() + interval '15 minutes',
                      claimed_by_user_id = '40000000-0000-4000-8000-000000000002', claimed_device_id = 'd4000000-0000-4000-8000-000000000002'
 where id = 'a4000000-0000-4000-8000-000000000003';

select app.end_share('a4000000-0000-4000-8000-000000000001', 'deleted_by_creator');
select app.end_share('a4000000-0000-4000-8000-000000000004', 'deleted_by_creator');
select app.end_share('a4000000-0000-4000-8000-000000000006', 'expired');

-- ---------------------------------------------------------------------------
-- Legal hold (D-2)
-- ---------------------------------------------------------------------------
select app.end_share('a4000000-0000-4000-8000-000000000005', 'blocked');
select is(
  (select array[legal_hold::text, hold_reason] from app.object_deletions where source_file_id = 'f4000000-0000-4000-8000-000000000005'),
  array['true', 'takedown'], 'a blocked share''s objects are put on legal hold, not deleted');
select is(
  (select (app.admin_block_share('a4000000-0000-4000-8000-000000000006', 'csam report', 'Op One') -> 'objects' -> 0 ->> 'legalHold')),
  'true', 'a takedown of an already-ended share holds its open deletions too');
select is((select legal_hold from app.object_deletions where source_file_id = 'f4000000-0000-4000-8000-000000000006'), true,
  'the expired share''s queued deletion is now held');
select throws_ok($$select app.admin_release_hold('a4000000-0000-4000-8000-000000000005', ' ', 'Op One')$$, '22023', null,
  'releasing a hold needs a reason');
create temp table held (id bigint, ok boolean) on commit drop;
insert into held (id) select id from app.object_deletions where source_file_id = 'f4000000-0000-4000-8000-000000000005';
grant select, update on held to app_janitor;
grant app_janitor to current_user;
set local role app_janitor;
update held set ok = app.janitor_finish_deletion(held.id, 'deleted');
reset role;
select is(
  (select array[(select ok from held)::text, (completed_at is null)::text] from app.object_deletions
    where source_file_id = 'f4000000-0000-4000-8000-000000000005'),
  array['false', 'true'], 'no janitor can complete a held row (D-2)');

-- ---------------------------------------------------------------------------
-- Hold copies (D-2, RISK-031). R2's lifecycle rules delete d7/ objects 8 days after upload, held
-- or not, so the janitor copies each held object to hold/<key>, which no rule reaches.
-- s…8 is blocked while its upload URL may still be live; s…9 was tombstoned before its takedown.
-- ---------------------------------------------------------------------------
insert into app.shares (id, scope, network_space_id, kind, created_by_user_id, billing_subject_type, billing_subject_id,
                        status, retention_class, expires_at, file_count, total_bytes, entitlement_snapshot)
select ('a4000000-0000-4000-8000-00000000000' || i)::uuid, 'network', 'e4000000-0000-4000-8000-000000000001', 'files',
       '40000000-0000-4000-8000-000000000001', 'user', '40000000-0000-4000-8000-000000000001', 'active', 'd7',
       now() + interval '1 day', 1, 10, '{"historyRetentionDays": 30}'
  from generate_series(8, 9) as i;
insert into app.files (id, share_id, network_space_id, object_key, original_name, declared_mime, stored_content_type,
                       declared_size_bytes, size_bytes, upload_status, upload_expires_at, upload_url_expires_at, verified_at)
select ('f4000000-0000-4000-8000-00000000000' || i)::uuid, ('a4000000-0000-4000-8000-00000000000' || i)::uuid, 'e4000000-0000-4000-8000-000000000001',
       'd7/2026/10/16/f4000000-0000-4000-8000-00000000000' || i, 'x.bin', 'application/octet-stream', 'application/octet-stream', 10, 10, 'verified',
       now() + interval '2 hours', case when i = 8 then now() + interval '10 minutes' else now() - interval '1 hour' end,
       now() - interval '2 hours'
  from generate_series(8, 9) as i;
select app.end_share('a4000000-0000-4000-8000-000000000009', 'deleted_by_creator');
update app.object_deletions set tombstoned_at = now() where source_file_id = 'f4000000-0000-4000-8000-000000000009';
select app.admin_block_share('a4000000-0000-4000-8000-000000000008', 'report', 'Op One');
select app.admin_block_share('a4000000-0000-4000-8000-000000000009', 'report', 'Op One');
select is(
  (select array_agg(right(object_key, 2) || ':' || coalesce(hold_copy, 'pending') order by object_key)
     from app.object_deletions where legal_hold),
  array['05:pending', '06:pending', '08:pending', '09:unavailable'],
  'every held object waits for its copy, except one a tombstone had already overwritten');

create temp table ids (name text primary key, id bigint) on commit drop;
insert into ids select 'f' || right(source_file_id::text, 2), id from app.object_deletions
 where source_file_id in ('f4000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000005', 'f4000000-0000-4000-8000-000000000006', 'f4000000-0000-4000-8000-000000000008');
create temp table hcc (step text, id bigint, object_key text, copy_key text, refused text, attempts int) on commit drop;
create temp table hcf (step text, ok boolean) on commit drop;
grant select on ids to app_janitor;
grant select, insert on hcc, hcf to app_janitor;
grant app_janitor to current_user;
set local role app_janitor;
insert into hcc select 'first', * from app.janitor_claim_hold_copies(100);
insert into hcc select 'again', * from app.janitor_claim_hold_copies(100);
reset role;
select is(
  (select array_agg(object_key || ' ' || copy_key order by object_key) from hcc where step = 'first'),
  array['d7/2026/10/16/f4000000-0000-4000-8000-000000000005 hold/d7/2026/10/16/f4000000-0000-4000-8000-000000000005',
        'd7/2026/10/16/f4000000-0000-4000-8000-000000000006 hold/d7/2026/10/16/f4000000-0000-4000-8000-000000000006'],
  'held objects are claimed for a copy to hold/<key>; one whose upload URL may still be live waits');
select is((select count(*)::int from hcc where step = 'again'), 0, 'claimed copies are locked against a second janitor');

set local role app_janitor;
insert into hcf select 'copied', app.janitor_finish_hold_copy((select id from ids where name = 'f05'), 'copied');
insert into hcf select 'unavailable', app.janitor_finish_hold_copy((select id from ids where name = 'f06'), 'unavailable');
insert into hcf select 'again', app.janitor_finish_hold_copy((select id from ids where name = 'f05'), 'copied');
insert into hcf select 'unheld', app.janitor_finish_hold_copy((select id from ids where name = 'f01'), 'copied');
reset role;
select is((select array_agg(step || ':' || ok order by step) from hcf),
  array['again:false', 'copied:true', 'unavailable:true', 'unheld:false'],
  'a claimed copy is finished once, and only a held row can be');
select is(
  (select array[hold_copy, coalesce(last_error, '-'), (locked_until is null)::text, (completed_at is null)::text, legal_hold::text]
     from app.object_deletions where source_file_id = 'f4000000-0000-4000-8000-000000000005'),
  array['copied', '-', 'true', 'true', 'true'], 'a copied row stays held and open');
select is(
  (select array[hold_copy, last_error] from app.object_deletions where source_file_id = 'f4000000-0000-4000-8000-000000000006'),
  array['unavailable', 'hold:source_missing'], 'a source already gone is recorded: the evidence is unavailable');

update app.files set upload_url_expires_at = now() - interval '1 hour' where id = 'f4000000-0000-4000-8000-000000000008';
set local role app_janitor;
insert into hcc select 'later', * from app.janitor_claim_hold_copies(100);
insert into hcf select 'failed', app.janitor_finish_hold_copy((select id from ids where name = 'f08'), 'failed', 's3:503:SlowDown');
reset role;
select is((select array_agg(right(object_key, 2) order by object_key) from hcc where step = 'later'), array['08'],
  'once its upload URL has expired, the last held object is claimed');
select is(
  (select array[coalesce(hold_copy, 'pending'), attempts::text, last_error, (not_before = now() + interval '1 minute')::text]
     from app.object_deletions where source_file_id = 'f4000000-0000-4000-8000-000000000008'),
  array['pending', '1', 's3:503:SlowDown', 'true'], 'a failed copy backs off and stays pending');
select throws_ok($$select app.janitor_finish_hold_copy(1, 'deleted')$$, '22023', null, 'unknown copy outcomes are refused');

update app.object_deletions set not_before = now() where source_file_id = 'f4000000-0000-4000-8000-000000000008';
update app.runtime_flags set enabled = false where key = 'storage_janitor_enabled';
set local role app_janitor;
insert into hcc select 'disabled', * from app.janitor_claim_hold_copies(100);
reset role;
update app.runtime_flags set enabled = true where key = 'storage_janitor_enabled';
select is((select count(*)::int from hcc where step = 'disabled'), 0, 'with the kill switch off no copy is claimed');

insert into app.object_deletions (object_key, reason, legal_hold, hold_reason)
values ('d7/2026/10/16/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa-', 'share_ended', true, 'takedown');
set local role app_janitor;
insert into hcc select 'guard', * from app.janitor_claim_hold_copies(100);
reset role;
select is(
  (select array[coalesce(object_key, '-'), coalesce(copy_key, '-'), refused] from hcc where step = 'guard' and refused is not null),
  array['-', '-', 'key_format'], 'a held row with a malformed key is refused, without its key');
update app.object_deletions set locked_until = null where completed_at is null;

-- Injected rows the guard rails must refuse (T-043): an active share's object, a claimed
-- share's object, and a key that isn't a generated key.
insert into app.object_deletions (object_key, reason, source_file_id) values
  ('d7/2026/10/16/f4000000-0000-4000-8000-000000000002', 'share_ended', 'f4000000-0000-4000-8000-000000000002'),
  ('d7/2026/10/16/f4000000-0000-4000-8000-000000000003', 'orphan', null),
  ('d7/2026/10/16/------------------------------------', 'orphan', null);

-- Phase 4 (P4-14) appends multipart_upload_id to the claim's columns; nothing here uses it.
create temp table jc (step text, id bigint, object_key text, reason text, hold_until timestamptz, tombstoned boolean, refused text,
                      attempts int, hold_copy_key text, multipart_upload_id text) on commit drop;
create temp table jr (step text, result jsonb) on commit drop;
grant select, insert on jc, jr to app_janitor;
grant app_janitor to current_user;

-- ---------------------------------------------------------------------------
-- janitor_claim_deletions
-- ---------------------------------------------------------------------------
set local role app_janitor;
insert into jc select 'first', * from app.janitor_claim_deletions(100);
insert into jc select 'again', * from app.janitor_claim_deletions(100);
reset role;

select is(
  (select array_agg(object_key order by object_key) from jc where step = 'first' and refused is null),
  array['d7/2026/10/16/f4000000-0000-4000-8000-000000000001', 'd7/2026/10/16/f4000000-0000-4000-8000-000000000004'],
  'due rows of ended shares are claimed; held rows are not');
select is((select hold_until from jc where step = 'first' and object_key like '%000000000001'), null,
  'an object with no live upload URL is deleted outright');
select is((select hold_until from jc where step = 'first' and object_key like '%000000000004'),
  (select upload_url_expires_at + interval '5 minutes' from app.files where id = 'f4000000-0000-4000-8000-000000000004'),
  'an object whose upload URL may still be live is held until its expiry plus 5 minutes');
select is(
  (select array_agg(refused order by refused) from jc where step = 'first' and refused is not null),
  array['key_format', 'share_open', 'share_open'],
  'an active share''s object, a claimed share''s object and a malformed key are refused (T-043)');
select is((select count(*)::int from jc where refused is not null and object_key is not null), 0,
  'refused rows come back without their key');
select ok(
  (select bool_and(last_error like 'guard:%' and not_before = now() + interval '1 day' and completed_at is null)
     from app.object_deletions where last_error like 'guard:%'),
  'refused rows are parked for a day with the reason, never completed');
select is((select count(*)::int from jc where step = 'again'), 0, 'claimed rows are locked against a second janitor');
select ok(
  (select bool_and(locked_until = now() + interval '2 minutes') from app.object_deletions od
     join jc on jc.id = od.id where jc.step = 'first' and jc.refused is null),
  'claims lock rows for 2 minutes');

select throws_ok($$select * from app.janitor_claim_deletions(501)$$, '22023', null, 'a batch is at most 500 rows (P3-00)');
update app.object_deletions set locked_until = null where completed_at is null;
update app.runtime_flags set enabled = false where key = 'storage_janitor_enabled';
set local role app_janitor;
insert into jc select 'disabled', * from app.janitor_claim_deletions(100);
insert into jr select 'begin-disabled', jsonb_build_object('enabled', b.enabled) from app.janitor_begin_run('delete') b;
reset role;
select is((select count(*)::int from jc where step = 'disabled'), 0, 'with the kill switch off nothing is claimed');
select is((select result ->> 'enabled' from jr where step = 'begin-disabled'), 'false', 'and a run learns it must stop');
update app.runtime_flags set enabled = true where key = 'storage_janitor_enabled';

-- ---------------------------------------------------------------------------
-- janitor_finish_deletion: deleted, tombstoned, failed (backoff), dry run
-- ---------------------------------------------------------------------------
set local role app_janitor;
insert into jc select 'second', * from app.janitor_claim_deletions(100);
insert into jr select 'deleted', to_jsonb(app.janitor_finish_deletion(
  (select id from jc where step = 'second' and object_key like '%000000000001'), 'deleted'));
insert into jr select 'tombstoned', to_jsonb(app.janitor_finish_deletion(
  (select id from jc where step = 'second' and object_key like '%000000000004'), 'tombstoned'));
insert into jr select 'deleted-twice', to_jsonb(app.janitor_finish_deletion(
  (select id from jc where step = 'second' and object_key like '%000000000001'), 'deleted'));
reset role;
select is((select result from jr where step = 'deleted'), 'true'::jsonb, 'a deleted object completes its row');
select ok(
  (select completed_at is not null and locked_until is null from app.object_deletions where source_file_id = 'f4000000-0000-4000-8000-000000000001')
  and (select object_deleted_at is not null from app.files where id = 'f4000000-0000-4000-8000-000000000001'),
  'the row is complete and the file is stamped object_deleted_at');
select is((select result from jr where step = 'deleted-twice'), 'false'::jsonb, 'a completed row cannot be finished again');
select is(
  (select array[(tombstoned_at is not null)::text, (not_before = (select upload_url_expires_at + interval '5 minutes' from app.files
                                                                      where id = 'f4000000-0000-4000-8000-000000000004'))::text,
                (completed_at is null)::text]
     from app.object_deletions where source_file_id = 'f4000000-0000-4000-8000-000000000004'),
  array['true', 'true', 'true'], 'a tombstoned row is rescheduled to the end of the hold, still open');

-- Five failures in a row (T3-02 database part): attempts and backoff, never given up on.
create temp table bo (n int, delay interval) on commit drop;
grant insert on bo to app_janitor;
do $$
declare
  v_id bigint := (select id from app.object_deletions where source_file_id = 'f4000000-0000-4000-8000-000000000004');
begin
  for i in 1..5 loop
    update app.object_deletions set not_before = now(), locked_until = now() + interval '2 minutes' where id = v_id;
    set local role app_janitor;
    perform app.janitor_finish_deletion(v_id, 'failed', 'S3 503 SlowDown');
    reset role;
    insert into bo select attempts, not_before - now() from app.object_deletions where id = v_id;
  end loop;
end
$$;
select is((select array_agg(delay order by n) from bo),
  array[interval '1 minute', interval '5 minutes', interval '30 minutes', interval '2 hours', interval '12 hours'],
  'each failure backs off further (1 min, 5 min, 30 min, 2 h, 12 h)');
select is(
  (select array[attempts::text, last_error, (completed_at is null)::text]
     from app.object_deletions where source_file_id = 'f4000000-0000-4000-8000-000000000004'),
  array['5', 'S3 503 SlowDown', 'true'], 'failures are counted with the last error and the row stays open');
select throws_ok($$select app.janitor_finish_deletion(1, 'skipped')$$, '22023', null, 'unknown outcomes are refused');

update app.object_deletions set not_before = now(), locked_until = null where source_file_id = 'f4000000-0000-4000-8000-000000000004';
set local role app_janitor;
insert into jc select 'dry', * from app.janitor_claim_deletions(100);
insert into jr select 'dry', to_jsonb(app.janitor_finish_deletion((select id from jc where step = 'dry' and refused is null), 'dry_run'));
reset role;
select is(
  (select array[(locked_until is null)::text, (completed_at is null)::text, attempts::text]
     from app.object_deletions where source_file_id = 'f4000000-0000-4000-8000-000000000004'),
  array['true', 'true', '5'], 'a dry run releases the row and changes nothing else');

-- ---------------------------------------------------------------------------
-- Releasing a hold (D-2, operators only)
-- ---------------------------------------------------------------------------
select is((app.admin_release_hold('a4000000-0000-4000-8000-000000000005', 'legal review done', 'Op One') ->> 'released')::int, 1,
  'an operator releases the hold');
select ok(
  (select not legal_hold and hold_reason is null and not_before <= now() from app.object_deletions
    where source_file_id = 'f4000000-0000-4000-8000-000000000005'),
  'the released row is due for the janitor');
select is(
  (select metadata ->> 'operator' from app.audit_events where action = 'admin.release_hold'
      and target_id = 'a4000000-0000-4000-8000-000000000005'),
  'Op One', 'the release is audited with the operator''s name');
select is(
  (select array[hold_copy, attempts::text, coalesce(last_error, '-')] from app.object_deletions
    where source_file_id = 'f4000000-0000-4000-8000-000000000005'),
  array['copied', '0', '-'], 'a released row keeps its copy state, with a fresh start for deletion');
set local role app_janitor;
insert into jc select 'released', * from app.janitor_claim_deletions(100);
reset role;
select is((select hold_copy_key from jc where step = 'released' and object_key like '%000000000005'),
  'hold/d7/2026/10/16/f4000000-0000-4000-8000-000000000005',
  'after the release the deletion claim carries the hold copy, so both objects go');
select is((select count(*)::int from jc where step = 'released' and hold_copy_key is not null), 1,
  'rows that were never copied carry no copy key');
update app.object_deletions set locked_until = null where completed_at is null;

-- ---------------------------------------------------------------------------
-- Reconciliation (T-044 database part)
-- ---------------------------------------------------------------------------
-- An ended share's object that reconcile will find again, and an old verified file of an open
-- share whose object is gone. A key a file still uses must never be queued.
insert into app.shares (id, scope, network_space_id, kind, created_by_user_id, billing_subject_type, billing_subject_id,
                        status, retention_class, expires_at, file_count, total_bytes, entitlement_snapshot)
values ('a4000000-0000-4000-8000-000000000007', 'network', 'e4000000-0000-4000-8000-000000000001', 'files',
        '40000000-0000-4000-8000-000000000001', 'user', '40000000-0000-4000-8000-000000000001', 'active', 'd7',
        now() + interval '1 day', 2, 20, '{}');
insert into app.files (id, share_id, network_space_id, object_key, original_name, declared_mime, stored_content_type,
                       declared_size_bytes, size_bytes, upload_status, upload_expires_at, verified_at)
values
  ('f4000000-0000-4000-8000-000000000071', 'a4000000-0000-4000-8000-000000000007', 'e4000000-0000-4000-8000-000000000001',
   'd7/2026/10/16/f4000000-0000-4000-8000-000000000071', 'kept.bin', 'application/octet-stream', 'application/octet-stream',
   10, 10, 'verified', now() + interval '2 hours', now() - interval '3 days'),
  ('f4000000-0000-4000-8000-000000000072', 'a4000000-0000-4000-8000-000000000007', 'e4000000-0000-4000-8000-000000000001',
   'd7/2026/10/16/f4000000-0000-4000-8000-000000000072', 'missing.bin', 'application/octet-stream', 'application/octet-stream',
   10, 10, 'verified', now() + interval '2 hours', now() - interval '3 days');

select is((app.start_storage_reconcile() ->> 'posted')::boolean, true, 'the weekly job opens a run and starts the janitor');
select is((select count(*)::int from app.storage_reconcile_runs where status = 'running'), 1, 'one run is open');
select lives_ok($$select app.start_storage_reconcile()$$, 'a second start while one runs is harmless');
select is((select count(*)::int from app.storage_reconcile_runs where status = 'running'), 1, 'still one run');

set local role app_janitor;
insert into jr select 'claim', to_jsonb(r) from app.janitor_reconcile_claim() r;
insert into jr select 'claim-again', to_jsonb(r) from app.janitor_reconcile_claim() r;
reset role;
select is((select count(*)::int from jr where step = 'claim'), 1, 'the janitor claims the run');
select is((select count(*)::int from jr where step = 'claim-again'), 0, 'a second invocation does not take it over');

-- Page 1: keys up to …0004 (sorted). Page 2 (last): the rest.
set local role app_janitor;
insert into jr select 'page1', app.janitor_reconcile_page(
  (select (result ->> 'run_id')::bigint from jr where step = 'claim'),
  jsonb_build_array(
    jsonb_build_object('k', 'd30/2026/09/01/aaaaaaaa-0000-4000-8000-000000000001', 'm', now() - interval '3 days'),
    jsonb_build_object('k', 'd30/2026/09/01/aaaaaaaa-0000-4000-8000-000000000002', 'm', now() - interval '1 hour'),
    jsonb_build_object('k', 'd7/2026/10/16/f4000000-0000-4000-8000-000000000001', 'm', now() - interval '3 days'),
    jsonb_build_object('k', 'd7/2026/10/16/f4000000-0000-4000-8000-000000000002', 'm', now() - interval '3 days'),
    jsonb_build_object('k', 'd7/2026/10/16/f4000000-0000-4000-8000-000000000003', 'm', now() - interval '3 days'),
    jsonb_build_object('k', 'd7/2026/10/16/f4000000-0000-4000-8000-000000000004', 'm', now() - interval '3 days')),
  null, 'd7/2026/10/16/f4000000-0000-4000-8000-000000000004', false);
reset role;
select is((select result from jr where step = 'page1'),
  '{"listed": 6, "orphansQueued": 2, "unknownKeys": 0, "missingObjects": 0, "holdCopies": 0}'::jsonb,
  'page 1: an old unknown object and a deleted file''s leftover are queued; a young one, live files and open outbox rows are not');
select is(
  (select array_agg(object_key || ':' || coalesce(source_file_id::text, '-') order by object_key) from app.object_deletions
    where reason = 'orphan' and object_key not like '%------%' and object_key not like '%000000000003'),
  array['d30/2026/09/01/aaaaaaaa-0000-4000-8000-000000000001:-',
        'd7/2026/10/16/f4000000-0000-4000-8000-000000000001:f4000000-0000-4000-8000-000000000001'],
  'orphans are queued as outbox rows (reason orphan), never deleted from here');

select throws_ok(
  $$select app.janitor_reconcile_page((select (result ->> 'run_id')::bigint from jr where step = 'claim'), '[]'::jsonb, null, null, true)$$,
  '22023', 'reconcile page out of order', 'pages must follow the saved cursor');
set local role app_janitor;
insert into jr select 'page2', app.janitor_reconcile_page(
  (select (result ->> 'run_id')::bigint from jr where step = 'claim'),
  jsonb_build_array(
    jsonb_build_object('k', 'd7/2026/10/16/f4000000-0000-4000-8000-000000000071', 'm', now() - interval '3 days'),
    jsonb_build_object('k', 'hold/d7/2026/10/16/f4000000-0000-4000-8000-000000000005', 'm', now() - interval '30 days'),
    jsonb_build_object('k', 'notes/readme.txt', 'm', now() - interval '30 days')),
  'd7/2026/10/16/f4000000-0000-4000-8000-000000000004', null, true);
reset role;
select is((select result from jr where step = 'page2'),
  '{"listed": 3, "orphansQueued": 0, "unknownKeys": 1, "missingObjects": 1, "holdCopies": 1}'::jsonb,
  'page 2: a live file is kept, a hold copy and an unknown key are only counted, a verified file with no object is found');
select ok((select object_missing_at is not null from app.files where id = 'f4000000-0000-4000-8000-000000000072'),
  'the missing object is marked on its file');
select ok((select object_missing_at is null from app.files where id = 'f4000000-0000-4000-8000-000000000071'),
  'a listed file is not marked');
select is((select count(*)::int from app.object_deletions where object_key = 'notes/readme.txt'), 0,
  'an unknown key is never queued');
select is((select count(*)::int from app.object_deletions where object_key like 'hold/%' or object_key like '%f4000000-0000-4000-8000-000000000005' and reason = 'orphan'), 0,
  'a hold copy is never queued, and neither is its held original');
select is(
  (select array[status, counts ->> 'listed', counts ->> 'orphansQueued', counts ->> 'unknownKeys', counts ->> 'missingObjects', counts ->> 'holdCopies']
     from app.storage_reconcile_runs where id = (select (result ->> 'run_id')::bigint from jr where step = 'claim')),
  array['finished', '9', '2', '1', '1', '1'], 'the run finishes with its totals');

-- ---------------------------------------------------------------------------
-- The cron trigger (Vault + pg_net) and job heartbeats
-- ---------------------------------------------------------------------------
update app.object_deletions set completed_at = now() where completed_at is null;
select is(app.trigger_storage_janitor('delete'), '{"posted": false, "reason": "nothing_due"}'::jsonb,
  'no post when nothing is due');
insert into app.object_deletions (object_key, reason) values ('d7/2026/10/16/f4000000-0000-4000-8000-0000000000aa', 'orphan');
update app.runtime_flags set enabled = false where key = 'storage_janitor_enabled';
select is(app.trigger_storage_janitor('delete'), '{"posted": false, "reason": "disabled"}'::jsonb,
  'no post while the kill switch is off');
update app.runtime_flags set enabled = true where key = 'storage_janitor_enabled';
create temp table posts (n int) on commit drop;
insert into posts select count(*) from net.http_request_queue where url = 'http://kong:8000/functions/v1/storage-janitor';
select is(app.trigger_storage_janitor('delete'), '{"posted": true, "mode": "delete"}'::jsonb, 'a post when rows are due');
select is(
  (select count(*)::int from net.http_request_queue where url = 'http://kong:8000/functions/v1/storage-janitor'),
  (select n + 1 from posts), 'exactly one request is queued for pg_net');
select is(
  (select array[(convert_from(body, 'utf8')::jsonb ->> 'mode'), (headers ->> 'Authorization' = 'Bearer local-only-janitor-trigger-secret-0000000000000001')::text]
     from net.http_request_queue where url = 'http://kong:8000/functions/v1/storage-janitor' order by id desc limit 1),
  array['delete', 'true'], 'the post carries the mode and the Vault secret as a bearer token');
select is(app.trigger_storage_janitor('reconcile'), '{"posted": false, "reason": "nothing_due"}'::jsonb,
  'no reconcile post without a running run');
update app.object_deletions set completed_at = now() where completed_at is null;
insert into app.object_deletions (object_key, reason, legal_hold, hold_reason)
values ('d7/2026/10/16/f4000000-0000-4000-8000-0000000000ab', 'share_ended', true, 'takedown');
select is(app.trigger_storage_janitor('delete'), '{"posted": true, "mode": "delete"}'::jsonb,
  'a held object waiting for its copy is work for the janitor (RISK-031)');
update app.object_deletions set hold_copy = 'copied' where object_key = 'd7/2026/10/16/f4000000-0000-4000-8000-0000000000ab';
select is(app.trigger_storage_janitor('delete'), '{"posted": false, "reason": "nothing_due"}'::jsonb,
  'a held object already copied is not');
-- Due work again for the job-runner checks below.
insert into app.object_deletions (object_key, reason) values ('d7/2026/10/16/f4000000-0000-4000-8000-0000000000ac', 'orphan');

select lives_ok($$select app.run_job('trigger-storage-janitor')$$, 'the job runner records a run');
select ok((select last_succeeded_at is not null from app.job_heartbeats where job = 'trigger-storage-janitor'),
  'a successful run leaves a heartbeat');
delete from vault.secrets where name = 'storage_janitor_secret';
select lives_ok($$select app.run_job('trigger-storage-janitor')$$, 'a failing job does not raise from the runner');
select is(
  (select array[(last_failed_at is not null)::text, last_error] from app.job_heartbeats where job = 'trigger-storage-janitor'),
  array['true', 'P0001 missing_secret'], 'a missing Vault secret is recorded as a failed run');
select throws_ok($$select app.run_job('drop-everything')$$, '22023', null, 'unknown jobs are refused');

select lives_ok($$select app.run_job('cron-heartbeat')$$, 'the cron heartbeat runs');
select ok((select (value ->> 'at')::timestamptz = now() from app.runtime_flags where key = 'cron_heartbeat'),
  'the heartbeat flag records the time');

set local role app_janitor;
insert into jr select 'begin', jsonb_build_object('enabled', b.enabled) from app.janitor_begin_run('delete') b;
select app.janitor_record_run('delete', true, '{"deleted": 3}'::jsonb);
reset role;
select is((select result ->> 'enabled' from jr where step = 'begin'), 'true', 'a janitor run starts with the switch on');
select is(
  (select array[(last_started_at = now())::text, (last_succeeded_at = now())::text, last_result ->> 'deleted']
     from app.job_heartbeats where job = 'storage-janitor'),
  array['true', 'true', '3'], 'the janitor records its own heartbeat (counts only)');
select throws_ok($$select app.janitor_record_run('delete', true, '[1, 2]'::jsonb)$$, '22023', null,
  'a run record must be an object of counts');

select is(
  (select count(*)::int from cron.job where jobname = 'trigger-storage-janitor' and schedule = '* * * * *' and active), 1,
  'the trigger runs every minute');

select * from finish();
rollback;
