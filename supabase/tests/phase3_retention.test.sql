-- Phase 3 database tests (P3-03): purge-tombstones and evidence retention (D-3), anonymous-user
-- cleanup (T-045, D-9), storage reconciliation (DEC-019), the egress loader (D-4), job health for
-- /health/cron (D-5), schedules and grants. Test IDs refer to 09 §4 and phase 3 §17.15.
begin;
create extension if not exists pgtap with schema extensions;

select plan(69);

-- Global jobs act on every row; this transaction starts from a clean slate (rolled back after).
delete from app.object_deletions;
delete from app.storage_reservations;
delete from app.storage_usage;
delete from app.downloads;
delete from app.audit_events;
delete from app.shares;
delete from app.abuse_reports;
delete from app.job_heartbeats;
delete from app.storage_reconcile_runs;
-- Users left by other test runs must not look inactive to the cleanup below.
update auth.users set created_at = now(), last_sign_in_at = now();

-- ---------------------------------------------------------------------------
-- Grants and schedules
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int
     from unnest(array['app.run_job(text)', 'app.purge_tombstones(integer)', 'app.cleanup_anonymous_users(integer)',
                       'app.reconcile_storage_usage(integer)', 'app.start_storage_reconcile()', 'app.finalize_claims(integer)',
                       'app.record_job_run(text, boolean, jsonb, text)']) as f(sig),
          unnest(array['app_server', 'app_janitor', 'app_egress_loader', 'anon', 'authenticated']) as r(role)
    where has_function_privilege(r.role, f.sig, 'EXECUTE')),
  0, 'job functions are granted to nobody (pg_cron runs them as their owner)');
select ok(has_function_privilege('app_server', 'app.cron_health(boolean)', 'EXECUTE'), 'app_server can read job health');
select is(
  (select array_agg(p.proname::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and has_function_privilege('app_egress_loader', p.oid, 'EXECUTE')),
  array['replace_egress_ranges'], 'the egress loader role may run only replace_egress_ranges');
select is(
  (select count(*)::int
     from pg_class c join pg_namespace n on n.oid = c.relnamespace,
          unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p(priv)
    where n.nspname = 'app' and c.relkind = 'r' and has_table_privilege('app_egress_loader', c.oid, p.priv)),
  0, 'the egress loader role has no table privileges');
select is(
  (select array_agg(jobname || ' ' || schedule order by jobname) from cron.job
    where jobname in ('trigger-storage-janitor', 'finalize-burn-claims', 'cron-heartbeat', 'purge-tombstones',
                      'cleanup-anonymous-users', 'reconcile-storage-usage', 'reconcile-r2-orphans') and active),
  array['cleanup-anonymous-users 33 3 * * *', 'cron-heartbeat 2-59/5 * * * *', 'finalize-burn-claims * * * * *',
        'purge-tombstones 3 3 * * *', 'reconcile-r2-orphans 6 5 * * 0', 'reconcile-storage-usage 4 4 * * *',
        'trigger-storage-janitor * * * * *'],
  'the Phase 3 jobs are scheduled, offset from the */5 and */10 jobs');
select ok(
  (select bool_and(command like 'select app.run_job(%') from cron.job
    where jobname in ('trigger-storage-janitor', 'finalize-burn-claims', 'cron-heartbeat', 'purge-tombstones',
                      'cleanup-anonymous-users', 'reconcile-storage-usage', 'reconcile-r2-orphans')),
  'every Phase 3 job goes through the runner, which records heartbeats');
select is((select count(*)::int from cron.job where jobname = 'refresh-egress-ranges'), 0,
  'the egress refresh is not a pg_cron job (D-4: GitHub Actions)');

-- ---------------------------------------------------------------------------
-- Fixtures: users for the cleanup (T-045)
--   …01 inactive, nothing open → deleted      …07 active reservation → kept
--   …02 device seen yesterday → kept          …08 not anonymous (a Phase 4 account) → kept
--   …03 signed in yesterday → kept            …09 suspended (D-9) → kept
--   …04 created 10 days ago → kept            …10 stored bytes → kept
--   …05 an open share → kept                  …11 session refreshed yesterday → kept
--   …06 claimant of a claimed share → kept
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, is_anonymous, created_at, updated_at, last_sign_in_at)
select ('50000000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid, '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated', i <> 8,
       case when i = 4 then now() - interval '10 days' else now() - interval '40 days' end, now() - interval '40 days',
       case when i = 3 then now() - interval '1 day' else now() - interval '40 days' end
  from generate_series(1, 11) as i;
insert into app.devices (id, user_id, label, last_seen_at)
select ('d5000000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid,
       ('50000000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid, 'Device ' || i,
       case when i = 2 then now() - interval '1 day' else now() - interval '40 days' end
  from generate_series(1, 11) as i;
insert into auth.sessions (id, user_id, created_at, updated_at, refreshed_at)
values (gen_random_uuid(), '50000000-0000-4000-8000-000000000011', now() - interval '40 days', now() - interval '1 day',
        now() - interval '1 day');
insert into app.user_flags (user_id, suspended_at, reason) values ('50000000-0000-4000-8000-000000000009', now() - interval '35 days', 'abuse');
insert into app.network_spaces (id, network_key, key_version, family)
values ('e5000000-0000-4000-8000-000000000001', decode(repeat('5a', 32), 'hex'), 1, 6);

-- Shares: p…1 purge with cascades, p…2 reported, p…3 reported through a link, p…4 open outbox row,
-- p…5 held, p…6 not due yet, p…7 active (user 05), p…8 claimed by user 06, p…9 ended share of user 01.
insert into app.shares (id, scope, network_space_id, kind, created_by_user_id, billing_subject_type, billing_subject_id,
                        status, retention_class, expires_at, burn_after_download, file_count, total_bytes, entitlement_snapshot)
select ('c5000000-0000-4000-8000-00000000000' || i)::uuid, 'network', 'e5000000-0000-4000-8000-000000000001', 'files',
       case when i = 7 then '50000000-0000-4000-8000-000000000005'::uuid when i = 9 then '50000000-0000-4000-8000-000000000001'::uuid
            else '50000000-0000-4000-8000-000000000002'::uuid end,
       'user', '50000000-0000-4000-8000-000000000002', 'active', 'd7', now() + interval '1 day', i = 8, 1, 10,
       '{"historyRetentionDays": 30}'
  from generate_series(1, 9) as i;
insert into app.files (id, share_id, network_space_id, object_key, original_name, declared_mime, stored_content_type,
                       declared_size_bytes, size_bytes, upload_status, upload_expires_at)
select ('f5000000-0000-4000-8000-00000000000' || i)::uuid, ('c5000000-0000-4000-8000-00000000000' || i)::uuid,
       'e5000000-0000-4000-8000-000000000001', 'd7/2026/10/16/f5000000-0000-4000-8000-00000000000' || i, 'x.bin',
       'application/octet-stream', 'application/octet-stream', 10, 10, 'verified', now() + interval '2 hours'
  from generate_series(1, 9) as i;
update app.shares set status = 'claimed', claimed_at = now(), claim_grace_until = now() + interval '15 minutes',
                      claimed_by_user_id = '50000000-0000-4000-8000-000000000006', claimed_device_id = 'd5000000-0000-4000-8000-000000000006'
 where id = 'c5000000-0000-4000-8000-000000000008';
insert into app.text_items (share_id, content, content_bytes) values ('c5000000-0000-4000-8000-000000000001', 'x', 1);
insert into app.share_links (id, share_id, secret_hmac, pepper_version, expires_at, entitlement_snapshot)
values ('P5linkAAAAAAAAA1', 'c5000000-0000-4000-8000-000000000001', decode(repeat('01', 32), 'hex'), 1, now() + interval '1 day', '{}'),
       ('P5linkAAAAAAAAA3', 'c5000000-0000-4000-8000-000000000003', decode(repeat('03', 32), 'hex'), 1, now() + interval '1 day', '{}');
insert into app.link_sessions (id_hash, expires_at) values (decode(repeat('5b', 32), 'hex'), now() + interval '1 hour');
insert into app.link_grants (session_id_hash, link_id, granted_via, expires_at)
values (decode(repeat('5b', 32), 'hex'), 'P5linkAAAAAAAAA1', 'secret', now() + interval '1 hour');
insert into app.downloads (share_id, file_id, actor_kind, event, retention_until)
values ('c5000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000001', 'network_device', 'url_issued', now() + interval '1 day');

select app.end_share(('c5000000-0000-4000-8000-00000000000' || i)::uuid, 'expired') from generate_series(1, 6) as i;
select app.end_share('c5000000-0000-4000-8000-000000000009', 'expired');
select app.end_share('c5000000-0000-4000-8000-000000000005', 'blocked');
-- Objects already deleted for p…1, …2, …3, …6 and …9; p…4 still open; p…5 held (blocked before expiry would also hold).
update app.object_deletions set completed_at = now() - interval '1 day'
 where source_file_id in ('f5000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000002',
                          'f5000000-0000-4000-8000-000000000003', 'f5000000-0000-4000-8000-000000000006',
                          'f5000000-0000-4000-8000-000000000009');
update app.object_deletions set legal_hold = true, hold_reason = 'takedown' where source_file_id = 'f5000000-0000-4000-8000-000000000005';
update app.shares set metadata_purge_after = now() - interval '1 day'
 where id in ('c5000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000003',
              'c5000000-0000-4000-8000-000000000004', 'c5000000-0000-4000-8000-000000000005');
insert into app.abuse_reports (share_id, category, reporter_kind) values ('c5000000-0000-4000-8000-000000000002', 'malware', 'device');
insert into app.abuse_reports (link_id, category, reporter_kind) values ('P5linkAAAAAAAAA3', 'phishing', 'link_viewer');

-- Records with their own retention dates.
insert into app.downloads (share_id, actor_kind, event, retention_until) values
  ('c5000000-0000-4000-8000-000000000007', 'network_device', 'url_issued', now() - interval '1 day'),
  ('c5000000-0000-4000-8000-000000000007', 'network_device', 'url_issued', now() + interval '1 day'),
  ('c5000000-0000-4000-8000-000000000002', 'network_device', 'url_issued', now() - interval '1 day');
insert into app.audit_events (actor_kind, action, target_type, target_id, retention_until) values
  ('system', 'share.ended', 'share', 'c5000000-0000-4000-8000-000000000007', now() - interval '1 day'),
  ('system', 'share.ended', 'share', 'c5000000-0000-4000-8000-000000000007', now() + interval '1 day'),
  ('operator', 'admin.block', 'share', 'c5000000-0000-4000-8000-000000000007', now() - interval '1 day'),
  ('device', 'report.created', 'report', gen_random_uuid()::text, now() - interval '1 day'),
  ('system', 'share.ended', 'share', 'c5000000-0000-4000-8000-000000000002', now() - interval '1 day'),
  ('system', 'link.unlocked', 'link', 'P5linkAAAAAAAAA3', now() - interval '1 day');
insert into app.object_deletions (object_key, reason, requested_at, completed_at) values
  ('d7/2026/09/01/aaaaaaaa-0000-4000-8000-0000000000a1', 'orphan', now() - interval '50 days', now() - interval '40 days'),
  ('d7/2026/09/01/aaaaaaaa-0000-4000-8000-0000000000a2', 'orphan', now() - interval '20 days', now() - interval '10 days');

-- ---------------------------------------------------------------------------
-- purge-tombstones (phase 3 §17.7, D-3)
-- ---------------------------------------------------------------------------
select is(app.purge_tombstones(1000), '{"shares": 1, "downloads": 1, "auditEvents": 1, "outboxRows": 1}'::jsonb,
  'one purge pass: one share, one download, one audit event and one completed outbox row are due');
select is((select count(*)::int from app.shares where id = 'c5000000-0000-4000-8000-000000000001'), 0,
  'an ended share past its purge date is deleted');
select is(
  array[(select count(*)::int from app.files where share_id = 'c5000000-0000-4000-8000-000000000001'),
        (select count(*)::int from app.text_items where share_id = 'c5000000-0000-4000-8000-000000000001'),
        (select count(*)::int from app.downloads where share_id = 'c5000000-0000-4000-8000-000000000001'),
        (select count(*)::int from app.share_links where share_id = 'c5000000-0000-4000-8000-000000000001'),
        (select count(*)::int from app.link_grants where link_id = 'P5linkAAAAAAAAA1')],
  array[0, 0, 0, 0, 0], 'its files, text, downloads, links and grants go with it');
select is((select count(*)::int from app.shares where id = 'c5000000-0000-4000-8000-000000000002'), 1,
  'a share with an abuse report is kept (D-3)');
select is((select count(*)::int from app.shares where id = 'c5000000-0000-4000-8000-000000000003'), 1,
  'a share reported through one of its links is kept (D-3)');
select is((select count(*)::int from app.shares where id = 'c5000000-0000-4000-8000-000000000004'), 1,
  'a share whose object deletion is still open is kept (the hold must outlive it)');
select is((select count(*)::int from app.shares where id = 'c5000000-0000-4000-8000-000000000005'), 1,
  'a share whose objects are on legal hold is kept (D-2)');
select is((select count(*)::int from app.shares where id = 'c5000000-0000-4000-8000-000000000006'), 1,
  'a share not yet past its purge date is kept');
select is((select count(*)::int from app.shares where id in ('c5000000-0000-4000-8000-000000000007', 'c5000000-0000-4000-8000-000000000008')),
  2, 'open shares are never purged');
select is((select count(*)::int from app.downloads where share_id = 'c5000000-0000-4000-8000-000000000007'), 1,
  'download records go on their own retention date');
select is((select count(*)::int from app.downloads where share_id = 'c5000000-0000-4000-8000-000000000002'), 1,
  'download records of a reported share are kept (D-3)');
select is(
  (select array_agg(action || ':' || coalesce(target_id, '') order by action, target_id) from app.audit_events
    where action <> 'share.ended' or target_id in ('c5000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000007')),
  (select array_agg(x order by x) from (
     select unnest(array[
       'admin.block:c5000000-0000-4000-8000-000000000007',
       'link.unlocked:P5linkAAAAAAAAA3',
       'share.ended:c5000000-0000-4000-8000-000000000002',
       'share.ended:c5000000-0000-4000-8000-000000000002',
       'share.ended:c5000000-0000-4000-8000-000000000007']) as x
     union all
     select action || ':' || target_id from app.audit_events where action = 'report.created') e),
  'audit events go on their own date, except operator actions, reports and events about reported shares or links');
select is(
  (select array_agg(object_key order by object_key) from app.object_deletions where reason = 'orphan'),
  array['d7/2026/09/01/aaaaaaaa-0000-4000-8000-0000000000a2'], 'completed outbox rows go 30 days after completion');
select is(app.purge_tombstones(1000), '{"shares": 0, "downloads": 0, "auditEvents": 0, "outboxRows": 0}'::jsonb,
  'purging is idempotent');

-- ---------------------------------------------------------------------------
-- cleanup-anonymous-users (T-045, D-9)
-- ---------------------------------------------------------------------------
insert into app.storage_usage (subject_type, subject_id) values ('user', '50000000-0000-4000-8000-000000000001');
insert into app.storage_usage (subject_type, subject_id, bytes_committed, files_committed)
values ('user', '50000000-0000-4000-8000-000000000010', 100, 1);
insert into app.storage_reservations (subject_type, subject_id, bytes, expires_at)
values ('user', '50000000-0000-4000-8000-000000000007', 10, now() + interval '1 hour');
insert into app.idempotency_keys (user_id, endpoint, key_hash, response)
values ('50000000-0000-4000-8000-000000000001', 'POST /api/v1/shares', decode(repeat('aa', 32), 'hex'), '{}');

select is(app.cleanup_anonymous_users(1000), 1, 'exactly one inactive anonymous user is deleted');
select is((select count(*)::int from auth.users where id = '50000000-0000-4000-8000-000000000001'), 0,
  'the inactive user with nothing open is gone');
select is(
  array[(select count(*)::int from app.devices where user_id = '50000000-0000-4000-8000-000000000001'),
        (select count(*)::int from app.idempotency_keys where user_id = '50000000-0000-4000-8000-000000000001'),
        (select count(*)::int from app.storage_usage where subject_id = '50000000-0000-4000-8000-000000000001')],
  array[0, 0, 0], 'their devices, idempotency keys and empty ledger row go with them');
select is((select created_by_user_id from app.shares where id = 'c5000000-0000-4000-8000-000000000009'), null,
  'their ended share stays, with the creator set to null');
select is(
  (select array_agg(right(id::text, 2) order by id) from auth.users where id::text like '50000000-0000-4000-8000-0000000000%'),
  array['02', '03', '04', '05', '06', '07', '08', '09', '10', '11'],
  'kept: recent device, recent sign-in, young, open share, claimant, reservation, not anonymous, suspended, stored bytes, recent session');
select is((select count(*)::int from app.user_flags where user_id = '50000000-0000-4000-8000-000000000009'), 1,
  'the suspension record survives (D-9)');
select is(app.cleanup_anonymous_users(1000), 0, 'cleanup is idempotent');

-- ---------------------------------------------------------------------------
-- reconcile-storage-usage (DEC-019, RISK-012)
-- ---------------------------------------------------------------------------
delete from app.storage_usage;
delete from app.storage_reservations;
-- Subject …02 owns the open shares' verified files (…07 and …08: 20 bytes, 2 files).
insert into app.storage_usage (subject_type, subject_id, bytes_committed, bytes_reserved, files_committed) values
  ('user', '50000000-0000-4000-8000-000000000002', 999, 0, 7),                -- small drift: corrected silently
  ('user', '50000000-0000-4000-8000-000000000003', 0, 0, 0),                  -- correct: untouched
  ('user', '50000000-0000-4000-8000-000000000004', 0, 5242880, 0);            -- 5 MiB reserved, no reservation: drift
update app.storage_usage set updated_at = now() - interval '1 day' where subject_id = '50000000-0000-4000-8000-000000000003';
-- …05 has an active reservation but no ledger row.
insert into app.storage_reservations (subject_type, subject_id, bytes, expires_at)
values ('user', '50000000-0000-4000-8000-000000000005', 10, now() + interval '1 hour');

select is(app.reconcile_storage_usage(1000) - 'cursor',
  '{"checked": 4, "corrected": 3, "drift": 1, "maxDriftBytes": 5242880}'::jsonb,
  'reconciliation checks every subject, corrects three and reports one unexplained drift');
select is(
  (select array[bytes_committed, bytes_reserved, files_committed::bigint] from app.storage_usage
    where subject_id = '50000000-0000-4000-8000-000000000002'),
  array[20, 0, 2]::bigint[], 'committed bytes and files are recounted from verified files');
select is((select bytes_reserved from app.storage_usage where subject_id = '50000000-0000-4000-8000-000000000004'), 0::bigint,
  'reserved bytes are recounted from active reservations');
select is((select bytes_reserved from app.storage_usage where subject_id = '50000000-0000-4000-8000-000000000005'), 10::bigint,
  'a subject with a reservation but no ledger row gets one');
select ok((select updated_at < now() from app.storage_usage where subject_id = '50000000-0000-4000-8000-000000000003'),
  'a correct row is left alone');
select is(
  (select array[target_id, metadata ->> 'reservedBefore', metadata ->> 'reservedAfter'] from app.audit_events
    where action = 'storage.drift_corrected'),
  array['50000000-0000-4000-8000-000000000004', '5242880', '0'], 'unexplained drift is audited; small corrections are not');
select is(app.reconcile_storage_usage(1000) - 'cursor', '{"checked": 4, "corrected": 0, "drift": 0, "maxDriftBytes": 0}'::jsonb,
  'a second pass finds nothing to correct');
select is(app.reconcile_storage_usage(2) ->> 'cursor', '50000000-0000-4000-8000-000000000003',
  'a partial pass returns where the next one starts');

-- ---------------------------------------------------------------------------
-- replace_egress_ranges (D-4)
-- ---------------------------------------------------------------------------
delete from app.network_egress_ranges;
insert into app.network_egress_ranges (cidr, source) values ('198.51.100.77/32', 'tor');
grant app_egress_loader to current_user;
create temp table eg (n int) on commit drop;
grant insert on eg to app_egress_loader;
set local role app_egress_loader;
insert into eg select app.replace_egress_ranges('private_relay', array['192.0.2.0/26', '2001:db8:5e1a::/48']::cidr[]);
reset role;
select is((select n from eg), 2, 'one source is replaced with the given ranges');
select is((select array_agg(cidr::text || ' ' || source order by cidr) from app.network_egress_ranges),
  array['192.0.2.0/26 private_relay', '198.51.100.77/32 tor', '2001:db8:5e1a::/48 private_relay'],
  'the other source is untouched');
select is((select value -> 'rows' ->> 'private_relay' from app.runtime_flags where key = 'egress_ranges'), '2',
  'the load is recorded for the fail-closed rule');
select ok((select (value ->> 'loadedAt')::timestamptz >= now() - interval '1 second' from app.runtime_flags where key = 'egress_ranges'),
  'with the load time');
select throws_ok($$select app.replace_egress_ranges('tor', array[]::cidr[])$$, '22023', 'refusing to empty the tor list',
  'an empty list is refused');
select throws_ok($$select app.replace_egress_ranges('vpn', array['10.0.0.0/8']::cidr[])$$, '22023', null,
  'only the two loaded sources can be replaced');

-- ---------------------------------------------------------------------------
-- cron_health (/health/cron, D-5)
-- ---------------------------------------------------------------------------
delete from app.object_deletions;
delete from app.job_heartbeats;
delete from app.storage_reconcile_runs;
update app.shares set status = 'deleted', ended_at = now(), end_reason = 'deleted_by_creator' where status in ('claimed');
update app.runtime_flags set value = '{}'::jsonb where key = 'egress_ranges';

select is(app.cron_health(false),
  '{"status": "degraded", "checks": {"heartbeat": "missing", "janitorBacklog": "ok", "janitorFailures": "ok", "janitorVolume": "ok",
     "burnFinalize": "ok", "reconcile": "pending", "storageDrift": "pending", "egressLists": "not_required", "jobs": "ok"}}'::jsonb,
  'before any heartbeat: degraded (heartbeat missing); jobs that have not run yet are pending');
select app.run_job('cron-heartbeat');
select is(app.cron_health(false) ->> 'status', 'ok', 'with a fresh heartbeat and nothing due: ok');
select is(app.cron_health(true) -> 'checks' ->> 'egressLists', 'missing', 'deployed environments need the egress lists');
update app.runtime_flags set value = jsonb_build_object('loadedAt', now() - interval '4 days') where key = 'egress_ranges';
select is(app.cron_health(true) -> 'checks' ->> 'egressLists', 'stale', 'lists older than 3 days are stale');
update app.runtime_flags set value = jsonb_build_object('loadedAt', now() - interval '1 day') where key = 'egress_ranges';
select is(app.cron_health(true) ->> 'status', 'ok', 'fresh lists: ok');

update app.job_heartbeats set last_succeeded_at = now() - interval '11 minutes' where job = 'cron-heartbeat';
select is(app.cron_health(false) -> 'checks' ->> 'heartbeat', 'stale', 'a heartbeat older than 10 minutes means pg_cron stopped');
update app.job_heartbeats set last_succeeded_at = now() where job = 'cron-heartbeat';

insert into app.object_deletions (object_key, reason, not_before) values
  ('d7/2026/10/16/aaaaaaaa-0000-4000-8000-0000000000b1', 'orphan', now() - interval '10 minutes');
select is(app.cron_health(false) -> 'checks' ->> 'janitorBacklog', 'stalled',
  'due rows and no recent janitor run: stalled');
select app.record_job_run('storage-janitor', true, '{}'::jsonb);
select is(app.cron_health(false) -> 'checks' ->> 'janitorBacklog', 'ok', 'a recent janitor run: ok');
update app.object_deletions set not_before = now() - interval '2 hours';
select is(app.cron_health(false) -> 'checks' ->> 'janitorBacklog', 'backlog', 'a row due for over an hour is a backlog');
insert into app.object_deletions (object_key, reason, not_before)
select 'd7/2026/10/16/aaaaaaaa-0000-4000-8000-' || lpad(i::text, 12, '0'), 'orphan', now() from generate_series(1, 1001) as i;
update app.object_deletions set not_before = now() where object_key like '%b1';
select is(app.cron_health(false) -> 'checks' ->> 'janitorBacklog', 'backlog', 'more than 1,000 due rows is a backlog');
delete from app.object_deletions;
insert into app.object_deletions (object_key, reason, not_before, legal_hold, hold_reason) values
  ('d7/2026/10/16/aaaaaaaa-0000-4000-8000-0000000000c1', 'orphan', now() - interval '3 hours', true, 'takedown');
select is(app.cron_health(false) -> 'checks' ->> 'janitorBacklog', 'backlog',
  'a held row whose copy has waited for hours is a backlog: the lifecycle rules may delete the original (RISK-031)');
update app.object_deletions set hold_copy = 'copied' where object_key like '%c1';
select is(app.cron_health(false) -> 'checks' ->> 'janitorBacklog', 'ok', 'held rows are not a backlog once copied');
insert into app.object_deletions (object_key, reason, not_before, attempts) values
  ('d7/2026/10/16/aaaaaaaa-0000-4000-8000-0000000000c2', 'orphan', now() + interval '1 hour', 5);
select is(app.cron_health(false) -> 'checks' ->> 'janitorFailures', 'failing', 'a row failing 5 times is reported');
insert into app.object_deletions (object_key, reason, not_before, last_error) values
  ('d7/2026/10/16/aaaaaaaa-0000-4000-8000-0000000000c3', 'orphan', now() + interval '1 day', 'guard:share_open');
select is(app.cron_health(false) -> 'checks' ->> 'janitorFailures', 'guard_refused', 'a guard refusal is reported first');
select is(app.cron_health(false) ->> 'status', 'degraded', 'and the status is degraded');
delete from app.object_deletions;

insert into app.object_deletions (object_key, reason, completed_at)
select 'd7/2026/10/16/bbbbbbbb-0000-4000-8000-' || lpad(i::text, 12, '0'), 'orphan', now() from generate_series(1, 11) as i;
update app.runtime_flags set value = '{"value": 10}' where key = 'janitor_daily_volume_alert';
select is(app.cron_health(false) -> 'checks' ->> 'janitorVolume', 'unusual', 'more deletions in 24 h than the threshold is unusual');
delete from app.object_deletions;

update app.shares set status = 'claimed', ended_at = null, end_reason = null, claimed_at = now() - interval '1 hour',
                      claim_grace_until = now() - interval '11 minutes', claimed_by_user_id = '50000000-0000-4000-8000-000000000006',
                      claimed_device_id = 'd5000000-0000-4000-8000-000000000006'
 where id = 'c5000000-0000-4000-8000-000000000008';
select is(app.cron_health(false) -> 'checks' ->> 'burnFinalize', 'late', 'a claim more than 10 minutes past grace is late');
select app.finalize_claims(500);
select is(app.cron_health(false) -> 'checks' ->> 'burnFinalize', 'ok', 'once finalized: ok');

insert into app.storage_reconcile_runs (started_at, status, finished_at) values (now() - interval '9 days', 'finished', now() - interval '9 days');
select is(app.cron_health(false) -> 'checks' ->> 'reconcile', 'stale', 'no finished reconciliation for 8 days is stale');
insert into app.storage_reconcile_runs (started_at) values (now() - interval '25 hours');
select is(app.cron_health(false) -> 'checks' ->> 'reconcile', 'stale', 'a run open for over 24 hours is stale');
update app.storage_reconcile_runs set status = 'finished', finished_at = now() where status = 'running';
select is(app.cron_health(false) -> 'checks' ->> 'reconcile', 'ok', 'a recent run: ok');

select app.record_job_run('reconcile-storage-usage', true, '{"drift": 2}'::jsonb);
select is(app.cron_health(false) -> 'checks' ->> 'storageDrift', 'drift', 'unexplained drift in the last reconciliation is reported');
select app.record_job_run('reconcile-storage-usage', true, '{"drift": 0}'::jsonb);
select is(app.cron_health(false) -> 'checks' ->> 'storageDrift', 'ok', 'no drift: ok');

select app.record_job_run('purge-tombstones', false, '{}'::jsonb, 'XX000 boom');
select is(app.cron_health(false) -> 'checks' ->> 'jobs', 'failing', 'a job whose last run failed is reported');
select app.record_job_run('purge-tombstones', true, '{}'::jsonb);
select is(app.cron_health(false) -> 'checks' ->> 'jobs', 'ok', 'a later success clears it');

select ok(
  not exists (select 1 from jsonb_each_text(app.cron_health(true) -> 'checks') c where c.value ~ '[0-9]'),
  'checks carry state words only: no counts, keys or IDs');
select is(app.cron_health(true) ->> 'status', 'ok', 'all checks ok: ok');

select * from finish();
rollback;
