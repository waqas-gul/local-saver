-- Phase 2 database tests (P2-01): link tables and constraints, link-only shares, end_share and
-- links, purge clauses, takedown functions (T-036 database part), grants. Test IDs refer to 09 §4.
begin;
create extension if not exists pgtap with schema extensions;

select plan(55);

-- ---------------------------------------------------------------------------
-- Structure, kill switches and grants (DEC-006)
-- ---------------------------------------------------------------------------
select has_table('app', t, 'app.' || t || ' exists')
  from unnest(array['share_links', 'link_sessions', 'link_grants', 'abuse_reports']) as t;

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relname in ('share_links', 'link_sessions', 'link_grants', 'abuse_reports')
      and c.relrowsecurity),
  4, 'row level security is enabled on the Phase 2 tables');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'app' and tablename in ('share_links', 'link_sessions', 'link_grants', 'abuse_reports')
      and policyname = 'app_server_all' and roles = '{app_server}'),
  4, 'each Phase 2 table has only the app_server policy');
select is(
  (select count(*)::int
     from unnest(array['share_links', 'link_sessions', 'link_grants', 'abuse_reports']) as t(name),
          unnest(array['anon', 'authenticated']) as r(role),
          unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p(priv)
    where has_table_privilege(r.role, 'app.' || t.name, p.priv)),
  0, 'client roles have no privileges on the Phase 2 tables');

select is(
  (select count(*)::int from app.runtime_flags where key in ('remote_links_enabled', 'short_codes_enabled') and enabled),
  2, 'remote-link and short-code kill switches exist and default to on');

select ok(not has_function_privilege('app_server', 'app.admin_block_share(uuid, text, text, uuid)', 'EXECUTE'),
  'the app cannot run the share takedown (operators only, from the dashboard)');
select ok(not has_function_privilege('app_server', 'app.admin_block_link(text, text, text, uuid)', 'EXECUTE'),
  'the app cannot run the link takedown');
select ok(
  not has_function_privilege('anon', 'app.admin_block_share(uuid, text, text, uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app.admin_block_link(text, text, text, uuid)', 'EXECUTE'),
  'client roles cannot run takedowns');

-- ---------------------------------------------------------------------------
-- Fixtures: two anonymous users with one device each, one network space
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, is_anonymous, created_at, updated_at)
select ('10000000-0000-4000-8000-00000000000' || i)::uuid, '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated', true, now(), now()
  from generate_series(1, 2) as i;
insert into app.devices (id, user_id, label)
select ('d1000000-0000-4000-8000-00000000000' || i)::uuid, ('10000000-0000-4000-8000-00000000000' || i)::uuid, 'Device ' || i
  from generate_series(1, 2) as i;
insert into app.network_spaces (id, network_key, key_version, family)
values ('e1000000-0000-4000-8000-000000000001', decode(repeat('ab', 32), 'hex'), 1, 6);

-- ---------------------------------------------------------------------------
-- Link-only shares (DEC-033, T-012 database part)
-- ---------------------------------------------------------------------------
select lives_ok(
  $$insert into app.shares (id, scope, kind, created_by_user_id, created_by_device_id, billing_subject_type,
                            billing_subject_id, status, retention_class, expires_at, entitlement_snapshot)
    values ('b1000000-0000-4000-8000-000000000001', 'link_only', 'text', '10000000-0000-4000-8000-000000000001',
            'd1000000-0000-4000-8000-000000000001', 'user', '10000000-0000-4000-8000-000000000001', 'active', 'd7',
            now() + interval '1 day', '{"historyRetentionDays": 30}')$$,
  'a link-only share has no network space');
select throws_ok(
  $$insert into app.shares (scope, network_space_id, kind, billing_subject_type, billing_subject_id, status,
                            retention_class, expires_at, entitlement_snapshot)
    values ('link_only', 'e1000000-0000-4000-8000-000000000001', 'text', 'user',
            '10000000-0000-4000-8000-000000000001', 'active', 'd7', now() + interval '1 day', '{}')$$,
  '23514', null, 'a link-only share can never belong to a network space');
select throws_ok(
  $$insert into app.shares (scope, kind, billing_subject_type, billing_subject_id, status, retention_class,
                            expires_at, entitlement_snapshot)
    values ('room', 'text', 'user', '10000000-0000-4000-8000-000000000001', 'active', 'd7', now() + interval '1 day', '{}')$$,
  '23514', null, 'room shares do not exist before Phase 4');
select is(
  (select array_agg(topic order by topic) from realtime.messages
    where payload ->> 'shareId' = 'b1000000-0000-4000-8000-000000000001'),
  array['user:10000000-0000-4000-8000-000000000001'],
  'a link-only share signals only its creator, never a net: topic (T-012)');

insert into app.text_items (share_id, content, content_bytes)
values ('b1000000-0000-4000-8000-000000000001', 'remote hello', 12);
update app.text_items set content = 'remote edit', content_bytes = 11, version = 2
 where share_id = 'b1000000-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from realtime.messages
    where payload ->> 'shareId' = 'b1000000-0000-4000-8000-000000000001' and topic like 'net:%'),
  0, 'editing a link-only text never signals a net: topic (T-012)');

-- A local share (on the space) with a file, for links, end_share and takedown.
insert into app.shares (id, scope, network_space_id, kind, created_by_user_id, created_by_device_id, billing_subject_type,
                        billing_subject_id, status, retention_class, expires_at, file_count, total_bytes, entitlement_snapshot)
values ('b1000000-0000-4000-8000-000000000002', 'network', 'e1000000-0000-4000-8000-000000000001', 'files',
        '10000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000002', 'user',
        '10000000-0000-4000-8000-000000000002', 'active', 'd7', now() + interval '2 days', 1, 100, '{}');
insert into app.files (id, share_id, network_space_id, object_key, original_name, declared_mime, stored_content_type,
                       declared_size_bytes, size_bytes, upload_status, upload_expires_at)
values ('f1000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000001',
        'd7/2026/10/15/f1000000-0000-4000-8000-000000000002', 'evidence.bin', 'application/octet-stream',
        'application/octet-stream', 100, 100, 'verified', now() + interval '2 hours');

-- ---------------------------------------------------------------------------
-- share_links constraints (04 §7.4, DEC-013, DEC-014)
-- ---------------------------------------------------------------------------
insert into app.share_links (id, share_id, secret_hmac, pepper_version, short_code_hmac, short_code_pepper_version,
                             short_code_expires_at, created_by_user_id, expires_at, entitlement_snapshot)
values
  ('AAAAAAAAAAAAAAA1', 'b1000000-0000-4000-8000-000000000001', decode(repeat('01', 32), 'hex'), 1,
   decode(repeat('c1', 32), 'hex'), 1, now() + interval '1 hour', '10000000-0000-4000-8000-000000000001',
   now() + interval '1 day', '{}'),
  ('AAAAAAAAAAAAAAA2', 'b1000000-0000-4000-8000-000000000002', decode(repeat('02', 32), 'hex'), 1,
   decode(repeat('c2', 32), 'hex'), 1, now() + interval '1 hour', '10000000-0000-4000-8000-000000000002',
   now() + interval '1 day', '{}'),
  ('AAAAAAAAAAAAAAA3', 'b1000000-0000-4000-8000-000000000002', decode(repeat('03', 32), 'hex'), 1,
   null, null, null, '10000000-0000-4000-8000-000000000002', now() + interval '1 day', '{}');

select throws_ok(
  $$insert into app.share_links (id, share_id, secret_hmac, pepper_version, expires_at, entitlement_snapshot)
    values ('short', 'b1000000-0000-4000-8000-000000000001', decode(repeat('04', 32), 'hex'), 1, now() + interval '1 hour', '{}')$$,
  '23514', null, 'link IDs are 16 base64url characters (96 bits)');
select throws_ok(
  $$insert into app.share_links (id, share_id, secret_hmac, pepper_version, expires_at, entitlement_snapshot)
    values ('AAAAAAAAAAAAAAA5', 'b1000000-0000-4000-8000-000000000001', decode('0102', 'hex'), 1, now() + interval '1 hour', '{}')$$,
  '23514', null, 'the secret is stored only as a 32-byte HMAC');
select throws_ok(
  $$insert into app.share_links (id, share_id, secret_hmac, pepper_version, short_code_hmac, expires_at, entitlement_snapshot)
    values ('AAAAAAAAAAAAAAA6', 'b1000000-0000-4000-8000-000000000001', decode(repeat('06', 32), 'hex'), 1,
            decode(repeat('c6', 32), 'hex'), now() + interval '1 hour', '{}')$$,
  '23514', null, 'a short code needs its expiry and pepper version');
select throws_ok(
  $$insert into app.share_links (id, share_id, secret_hmac, pepper_version, expires_at, entitlement_snapshot)
    values ('AAAAAAAAAAAAAAA7', 'b1000000-0000-4000-8000-000000000001', decode(repeat('07', 32), 'hex'), 1,
            now() + interval '2 days', '{}')$$,
  '23514', null, 'a link cannot outlive its share (07 §3 database backstop)');
select throws_ok(
  $$insert into app.share_links (id, share_id, secret_hmac, pepper_version, short_code_hmac, short_code_pepper_version,
                                 short_code_expires_at, expires_at, entitlement_snapshot)
    values ('AAAAAAAAAAAAAAA8', 'b1000000-0000-4000-8000-000000000001', decode(repeat('08', 32), 'hex'), 1,
            decode(repeat('c1', 32), 'hex'), 1, now() + interval '1 hour', now() + interval '1 hour', '{}')$$,
  '23505', null, 'two active links can never share a short code');
select throws_ok(
  $$insert into app.share_links (id, target_type, share_id, secret_hmac, pepper_version, expires_at, entitlement_snapshot)
    values ('AAAAAAAAAAAAAAA9', 'room', 'b1000000-0000-4000-8000-000000000001', decode(repeat('09', 32), 'hex'), 1,
            now() + interval '1 hour', '{}')$$,
  '23514', null, 'a link targets one share: no room or network-feed links (Q-028)');

-- ---------------------------------------------------------------------------
-- Viewer sessions and grants (04 §7.5)
-- ---------------------------------------------------------------------------
insert into app.link_sessions (id_hash, expires_at) values
  (decode(repeat('5a', 32), 'hex'), now() + interval '12 hours'),
  (decode(repeat('5b', 32), 'hex'), now() + interval '12 hours'),
  (decode(repeat('5c', 32), 'hex'), now() - interval '25 hours'),
  (decode(repeat('5d', 32), 'hex'), now() - interval '1 hour');
insert into app.link_grants (session_id_hash, link_id, granted_via, expires_at) values
  (decode(repeat('5a', 32), 'hex'), 'AAAAAAAAAAAAAAA1', 'secret', now() + interval '12 hours'),
  (decode(repeat('5b', 32), 'hex'), 'AAAAAAAAAAAAAAA2', 'code', now() + interval '1 hour');

select throws_ok(
  $$insert into app.link_grants (session_id_hash, link_id, granted_via, expires_at)
    values (decode(repeat('5a', 32), 'hex'), 'AAAAAAAAAAAAAAA2', 'secret', now() + interval '13 hours')$$,
  '23514', null, 'a grant lives at most 12 hours');
select throws_ok(
  $$insert into app.link_grants (session_id_hash, link_id, granted_via, expires_at)
    values (decode(repeat('5a', 32), 'hex'), 'AAAAAAAAAAAAAAA3', 'password', now() + interval '1 hour')$$,
  '23514', null, 'grants come from a secret or a code only');
select throws_ok(
  $$insert into app.link_sessions (id_hash, expires_at) values (decode('00', 'hex'), now() + interval '1 hour')$$,
  '23514', null, 'sessions are stored as 32-byte hashes of the cookie');

-- ---------------------------------------------------------------------------
-- end_share invalidates links (04 §7.4, 03 §4.8)
-- ---------------------------------------------------------------------------
do $$ begin perform app.end_share('b1000000-0000-4000-8000-000000000001', 'deleted_by_creator'); end $$;
select is(
  (select array[revoke_reason, (revoked_at is not null)::text] from app.share_links where id = 'AAAAAAAAAAAAAAA1'),
  array['share_ended', 'true'], 'ending a share revokes its links');
select is(
  (select short_code_hmac from app.share_links where id = 'AAAAAAAAAAAAAAA1'), null,
  'ending a share clears its links'' short codes');
select is(
  (select count(*)::int from app.share_links where share_id = 'b1000000-0000-4000-8000-000000000002' and revoked_at is not null),
  0, 'other shares'' links are untouched');

-- ---------------------------------------------------------------------------
-- purge-ephemeral: grants, sessions and short codes (04 §9.2)
-- ---------------------------------------------------------------------------
update app.link_grants set expires_at = now() - interval '1 minute'
 where session_id_hash = decode(repeat('5b', 32), 'hex');
update app.share_links set short_code_expires_at = now() - interval '1 minute' where id = 'AAAAAAAAAAAAAAA2';
insert into app.share_links (id, share_id, secret_hmac, pepper_version, short_code_hmac, short_code_pepper_version,
                             short_code_expires_at, expires_at, entitlement_snapshot)
values ('AAAAAAAAAAAAAA10', 'b1000000-0000-4000-8000-000000000002', decode(repeat('10', 32), 'hex'), 1,
        decode(repeat('d0', 32), 'hex'), 1, now() + interval '10 minutes', now() + interval '1 day', '{}');
do $$ begin perform app.purge_ephemeral(); end $$;
select is((select count(*)::int from app.link_grants where session_id_hash = decode(repeat('5b', 32), 'hex')), 0,
  'expired grants are deleted');
select is((select count(*)::int from app.link_grants where session_id_hash = decode(repeat('5a', 32), 'hex')), 1,
  'live grants are kept');
select is((select count(*)::int from app.link_sessions where id_hash = decode(repeat('5c', 32), 'hex')), 0,
  'sessions are deleted 24 h after they expire');
select is((select count(*)::int from app.link_sessions where id_hash = decode(repeat('5d', 32), 'hex')), 1,
  'recently expired sessions are kept until then');
select is(
  (select array[(short_code_hmac is null)::text, (short_code_expires_at is null)::text] from app.share_links where id = 'AAAAAAAAAAAAAAA2'),
  array['true', 'true'], 'expired short codes are cleared');
select isnt((select short_code_hmac from app.share_links where id = 'AAAAAAAAAAAAAA10'), null,
  'live short codes are kept');
select is((select revoked_at from app.share_links where id = 'AAAAAAAAAAAAAAA2'), null,
  'clearing an expired code leaves its link working');

-- ---------------------------------------------------------------------------
-- Abuse reports (04 §10.4)
-- ---------------------------------------------------------------------------
insert into app.abuse_reports (id, link_id, share_id, category, details, reporter_kind)
values
  ('a1000000-0000-4000-8000-000000000001', 'AAAAAAAAAAAAAAA2', 'b1000000-0000-4000-8000-000000000002', 'malware',
   'looks like malware', 'link_viewer'),
  ('a1000000-0000-4000-8000-000000000002', null, 'b1000000-0000-4000-8000-000000000002', 'spam', null, 'device'),
  ('a1000000-0000-4000-8000-000000000003', 'AAAAAAAAAAAAAAA3', 'b1000000-0000-4000-8000-000000000002', 'phishing', null, 'link_viewer');
select throws_ok(
  $$insert into app.abuse_reports (share_id, category, reporter_kind) values ('b1000000-0000-4000-8000-000000000002', 'boring', 'device')$$,
  '23514', null, 'report categories are a fixed list');
select throws_ok(
  $$insert into app.abuse_reports (share_id, category, details, reporter_kind)
    values ('b1000000-0000-4000-8000-000000000002', 'other', repeat('x', 2001), 'device')$$,
  '23514', null, 'report details are at most 2,000 characters');
select throws_ok(
  $$insert into app.abuse_reports (share_id, category, reporter_kind, status) values ('b1000000-0000-4000-8000-000000000002', 'spam', 'device', 'actioned')$$,
  '23514', null, 'a resolved report records when it was resolved');

-- ---------------------------------------------------------------------------
-- Takedown: admin_block_link, then admin_block_share (T-036 database part)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$select app.admin_block_link('AAAAAAAAAAAAAAA3', '', 'ops', null)$$,
  '22023', null, 'a takedown needs a reason');
select throws_ok(
  $$select app.admin_block_share('b1ffffff-0000-4000-8000-000000000000', 'abuse', 'ops', null)$$,
  '22023', null, 'blocking an unknown share is refused');

do $$ begin perform app.admin_block_link('AAAAAAAAAAAAAAA3', 'phishing page', 'ops-alice', 'a1000000-0000-4000-8000-000000000003'); end $$;
select is((select revoke_reason from app.share_links where id = 'AAAAAAAAAAAAAAA3'), 'blocked',
  'blocking a link revokes it');
select is((select status from app.shares where id = 'b1000000-0000-4000-8000-000000000002'), 'active',
  'blocking a link leaves its share and other links alone');
select is((select status from app.abuse_reports where id = 'a1000000-0000-4000-8000-000000000003'), 'actioned',
  'the link''s report is resolved');
select is(
  (select metadata ->> 'operator' from app.audit_events where action = 'admin.block' and target_type = 'link' and target_id = 'AAAAAAAAAAAAAAA3'),
  'ops-alice', 'the link takedown is audited with the operator');

create temp table blk (result jsonb) on commit drop;
insert into blk select app.admin_block_share('b1000000-0000-4000-8000-000000000002', 'malware', 'ops-bob', 'a1000000-0000-4000-8000-000000000001');
select is(
  (select array[status, end_reason] from app.shares where id = 'b1000000-0000-4000-8000-000000000002'),
  array['blocked', 'blocked'], 'blocking a share ends it as blocked');
select is(
  (select count(*)::int from app.share_links where share_id = 'b1000000-0000-4000-8000-000000000002' and revoked_at is null),
  0, 'every link of a blocked share is revoked');
select is((select revoke_reason from app.share_links where id = 'AAAAAAAAAAAAAAA2'), 'blocked',
  'links revoked by a block say so');
select is(
  (select count(*)::int from app.object_deletions
    where object_key = 'd7/2026/10/15/f1000000-0000-4000-8000-000000000002' and completed_at is null),
  1, 'the blocked share''s objects are queued for deletion');
select is(
  (select result -> 'objects' -> 0 ->> 'objectKey' from blk),
  'd7/2026/10/15/f1000000-0000-4000-8000-000000000002', 'the result lists the queued object keys for the runbook');
select is(
  (select count(*)::int from app.abuse_reports where share_id = 'b1000000-0000-4000-8000-000000000002' and status = 'open'),
  0, 'every open report on the share is resolved');
select is(
  (select array[actor_kind, metadata ->> 'operator', metadata ->> 'reason'] from app.audit_events
    where action = 'admin.block' and target_type = 'share' and target_id = 'b1000000-0000-4000-8000-000000000002'),
  array['operator', 'ops-bob', 'malware'], 'the share takedown is audited');
select is(
  (select count(*)::int from realtime.messages
    where payload ->> 'shareId' = 'b1000000-0000-4000-8000-000000000002' and payload ->> 'status' = 'blocked'),
  2, 'devices on the network and the creator are signalled');
select lives_ok(
  $$select app.admin_block_share('b1000000-0000-4000-8000-000000000002', 'repeat', 'ops-bob', null)$$,
  'blocking twice is harmless');

-- ---------------------------------------------------------------------------
-- Columns for link viewers in downloads and audit events
-- ---------------------------------------------------------------------------
select lives_ok(
  $$insert into app.downloads (share_id, actor_kind, link_id, event, retention_until)
    values ('b1000000-0000-4000-8000-000000000002', 'link_viewer', 'AAAAAAAAAAAAAAA2', 'url_issued', now() + interval '30 days')$$,
  'download issuances can be logged for link viewers, with the link');
select lives_ok(
  $$insert into app.audit_events (actor_kind, action, target_type, target_id) values ('link_viewer', 'report.created', 'share', 'x')$$,
  'audit events can name a link viewer as the actor');

select * from finish();
rollback;
