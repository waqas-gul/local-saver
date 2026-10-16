-- Phase 1 database tests (P1-02): structure, grants, network guards, quota, end_share,
-- jobs, realtime triggers and topic authorization. Test IDs refer to 09 §4.
begin;
create extension if not exists pgtap with schema extensions;

select plan(106);

-- ---------------------------------------------------------------------------
-- Structure and grants (DEC-006)
-- ---------------------------------------------------------------------------
select has_table('app', t, 'app.' || t || ' exists')
  from unnest(array[
    'devices', 'network_spaces', 'network_presence', 'network_egress_ranges', 'shares', 'files',
    'text_items', 'downloads', 'storage_usage', 'storage_reservations', 'object_deletions',
    'audit_events', 'idempotency_keys', 'user_flags'
  ]) as t;

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relkind in ('r', 'p') and not c.relrowsecurity),
  0, 'row level security is enabled on every app table');

select is(
  (select count(*)::int
     from pg_class c join pg_namespace n on n.oid = c.relnamespace,
          unnest(array['anon', 'authenticated']) as r(role),
          unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p(priv)
    where n.nspname = 'app' and c.relkind = 'r' and has_table_privilege(r.role, c.oid, p.priv)),
  0, 'client roles have no table privileges in app');

select is(
  (select count(*)::int
     from pg_class c join pg_namespace n on n.oid = c.relnamespace,
          unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p(priv)
    where n.nspname = 'app' and c.relkind = 'r' and not has_table_privilege('app_server', c.oid, p.priv)),
  0, 'app_server has DML on every app table');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app'
      and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
  0, 'client roles cannot execute app functions');

select ok(has_function_privilege('app_server', 'app.observe_network(uuid, uuid, bytea, integer, integer, text)', 'EXECUTE'),
  'app_server can call observe_network');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('app', 'app_realtime') and 'inet'::regtype::oid = any(p.proargtypes::oid[])),
  0, 'no app function takes a client address: raw IPs never reach the database (review L5)');
select ok(has_function_privilege('app_server', 'app.egress_ranges_overlapping(cidr)', 'EXECUTE'),
  'app_server can look up egress ranges by coarse prefix');
select ok(has_function_privilege('app_server', 'app.claim_object_deletions(uuid, integer)', 'EXECUTE'),
  'app_server can claim storage deletions');
select ok(has_function_privilege('authenticated', 'app_realtime.can_access_topic(text)', 'EXECUTE'),
  'authenticated can call can_access_topic (Realtime policies)');
select ok(not has_function_privilege('anon', 'app_realtime.can_access_topic(text)', 'EXECUTE'),
  'anon cannot call can_access_topic');

select is(
  (select count(*)::int from app.runtime_flags
    where key in ('local_sharing_enabled', 'uploads_enabled', 'anonymous_uploads_enabled') and enabled),
  3, 'kill switches exist and default to on');
select is((select (value ->> 'value')::int from app.runtime_flags where key = 'network_large_cap'), 50,
  'large-network cap defaults to 50 (Q-029, assumed)');
select is(
  (select count(*)::int from cron.job where jobname in (
    'expire-shares', 'fail-stale-uploads', 'refresh-network-status', 'purge-ephemeral',
    'release-stale-reservations', 'purge-idle-spaces')),
  6, 'Phase 1 cron jobs are scheduled');

-- ---------------------------------------------------------------------------
-- Fixtures: six anonymous users with one device each
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, is_anonymous, created_at, updated_at)
select ('00000000-0000-4000-8000-00000000000' || i)::uuid, '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated', true, now(), now()
  from generate_series(1, 6) as i;
insert into app.devices (id, user_id, label)
select ('d0000000-0000-4000-8000-00000000000' || i)::uuid, ('00000000-0000-4000-8000-00000000000' || i)::uuid, 'Device ' || i
  from generate_series(1, 6) as i;

-- Results of calls made as app_server or authenticated; assertions run as the owner.
create temp table obs (step text primary key, space_id uuid, status text, reason text, here int) on commit drop;
create temp table topic_checks (label text primary key, allowed boolean) on commit drop;
create temp table q (step text primary key, rid uuid, ok boolean) on commit drop;
create temp table eg (step text, cidr text, source text) on commit drop;
create temp table cl (step text, object_key text, hold_until timestamptz, tombstoned boolean) on commit drop;
grant select, insert on obs, q, eg, cl to app_server;
grant select on obs to authenticated;
grant insert on topic_checks to authenticated;
grant app_server to current_user;

-- ---------------------------------------------------------------------------
-- observe_network: spaces, presence, leaving (DEC-032, 03 §3.6)
-- ---------------------------------------------------------------------------
set local role app_server;
insert into obs select 'a1', * from app.observe_network('d0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', decode(repeat('a1', 32), 'hex'), 1, 4, null);
insert into obs select 'a2', * from app.observe_network('d0000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', decode(repeat('a1', 32), 'hex'), 1, 4, null);
insert into obs select 'b1', * from app.observe_network('d0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', decode(repeat('b2', 32), 'hex'), 1, 4, null);
reset role;

select is((select status from obs where step = 'a1'), 'ok', 'first device on a network: ok');
select is((select here from obs where step = 'a2'), 2, 'second device on the same network sees 2 devices here');
select is((select space_id from obs where step = 'a1'), (select space_id from obs where step = 'a2'), 'same network key, same space');
select isnt((select space_id from obs where step = 'b1'), (select space_id from obs where step = 'a1'), 'different key, different space');
select ok(
  (select present_until <= now() from app.network_presence
    where space_id = (select space_id from obs where step = 'a1') and device_id = 'd0000000-0000-4000-8000-000000000001'),
  'observing from another network ends presence on the old one (G3)');
select is((select devices_24h from app.network_spaces where id = (select space_id from obs where step = 'a1')), 2,
  'devices_24h counts distinct devices');
select is((select count(*)::int from app.network_spaces where network_key = decode(repeat('a1', 32), 'hex')), 1,
  'raw IPs are never stored: one row keyed by the HMAC');

-- ---------------------------------------------------------------------------
-- Guards (DEC-032): shared_egress, too_large, blocked, sticky statuses
-- ---------------------------------------------------------------------------
set local role app_server;
insert into obs select 'relay', * from app.observe_network('d0000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000003', decode(repeat('c3', 32), 'hex'), 1, 4, 'private_relay');
reset role;
select is((select status from obs where step = 'relay'), 'shared_egress', 'an address the app found on the Private Relay list is shared_egress (T-005)');
select ok(
  (select status_until between now() + interval '6 days 23 hours' and now() + interval '7 days 1 hour'
     from app.network_spaces where id = (select space_id from obs where step = 'relay')),
  'shared_egress is sticky for 7 days');

update app.runtime_flags set value = '{"value": 3}' where key = 'network_large_cap';
set local role app_server;
insert into obs select 'big' || i, o.*
  from generate_series(3, 6) as i,
       lateral app.observe_network(('d0000000-0000-4000-8000-00000000000' || i)::uuid, ('00000000-0000-4000-8000-00000000000' || i)::uuid,
                                   decode(repeat('d4', 32), 'hex'), 1, 6, null) as o;
reset role;
select is((select status from obs where step = 'big5'), 'ok', 'at the cap (3 devices) the space stays ok');
select is((select status from obs where step = 'big6'), 'too_large', 'above the cap the space becomes too_large (T-004)');
select is(
  (select count(*)::int from app.audit_events
    where action = 'network.status_changed' and network_space_id = (select space_id from obs where step = 'big6')
      and metadata ->> 'to' = 'too_large'),
  1, 'the status change is audited');

update app.network_spaces set status = 'blocked', status_reason = 'operator'
 where id = (select space_id from obs where step = 'a1');
set local role app_server;
insert into obs select 'blocked', * from app.observe_network('d0000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', decode(repeat('a1', 32), 'hex'), 1, 4, null);
reset role;
select is((select status from obs where step = 'blocked'), 'blocked', 'observe never lifts a block');

update app.network_spaces set status_until = now() - interval '1 minute' where id = (select space_id from obs where step = 'big6');
do $$ begin perform app.refresh_network_status(1000); end $$;
select is((select status from app.network_spaces where id = (select space_id from obs where step = 'big6')), 'too_large',
  'still above the cap when the sticky period ends: stays too_large');
update app.runtime_flags set value = '{"value": 50}' where key = 'network_large_cap';
update app.network_spaces set status_until = now() - interval '1 minute' where id = (select space_id from obs where step = 'big6');
do $$ begin perform app.refresh_network_status(1000); end $$;
select is((select status from app.network_spaces where id = (select space_id from obs where step = 'big6')), 'ok',
  'below the cap when the sticky period ends: back to ok');
select is(
  (select count(*)::int from realtime.messages
    where topic = 'net:' || (select space_id from obs where step = 'big6') and event = 'network.changed'),
  2, 'status changes emit network.changed on the space topic');

-- shared_egress is lifted only by an observe, whose caller re-checks the lists, never by the job (M2).
update app.network_spaces set status_until = now() - interval '1 minute' where id = (select space_id from obs where step = 'relay');
do $$ begin perform app.refresh_network_status(1000); end $$;
select is((select status from app.network_spaces where id = (select space_id from obs where step = 'relay')), 'shared_egress',
  'the status job never lifts shared_egress');
set local role app_server;
insert into obs select 'relay-again', * from app.observe_network('d0000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000004', decode(repeat('c3', 32), 'hex'), 1, 4, 'private_relay');
reset role;
select is((select status from obs where step = 'relay-again'), 'shared_egress', 'still on the list after the sticky period: stays shared_egress');
select ok(
  (select status_until > now() + interval '6 days' from app.network_spaces where id = (select space_id from obs where step = 'relay')),
  'and the sticky period starts again');
update app.network_spaces set status_until = now() - interval '1 minute' where id = (select space_id from obs where step = 'relay');
set local role app_server;
insert into obs select 'relay-cleared', * from app.observe_network('d0000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000004', decode(repeat('c3', 32), 'hex'), 1, 4, null);
reset role;
select is((select status from obs where step = 'relay-cleared'), 'ok', 'off the list after the sticky period: back to ok on the next observe');
select is((select count(*)::int from app.runtime_flags where key = 'egress_ranges'), 1,
  'the egress list load time has a runtime flag (fail closed when stale, M2)');

-- Egress lookup by coarse prefix (review L5): the app sends only an IPv4 /24 or IPv6 /48 and
-- checks the exact address itself, so the database never receives the client address.
insert into app.network_egress_ranges (cidr, source) values
  ('192.0.2.0/27', 'private_relay'), ('198.51.100.77/32', 'tor'),
  ('2001:db8:5e00::/40', 'private_relay'), ('2001:db8:7000::/64', 'private_relay');
set local role app_server;
insert into eg select 'v4', cidr::text, source from app.egress_ranges_overlapping('192.0.2.0/24');
insert into eg select 'v6', cidr::text, source from app.egress_ranges_overlapping('2001:db8:5e1a::/48');
insert into eg select 'v6-narrow', cidr::text, source from app.egress_ranges_overlapping('2001:db8:7000::/48');
insert into eg select 'none', cidr::text, source from app.egress_ranges_overlapping('203.0.113.0/24');
reset role;
select is((select array_agg(cidr) from eg where step = 'v4'), array['192.0.2.0/27'], 'IPv4: ranges inside the /24 are returned');
select is((select array_agg(cidr) from eg where step = 'v6'), array['2001:db8:5e00::/40'], 'IPv6: a broader range covering the /48 is returned');
select is((select array_agg(cidr) from eg where step = 'v6-narrow'), array['2001:db8:7000::/64'], 'IPv6: narrower ranges inside the /48 are returned');
select is((select count(*)::int from eg where step = 'none'), 0, 'no overlapping range, no rows');
select throws_ok($q$select * from app.egress_ranges_overlapping('192.0.2.7/32')$q$, '22023', null,
  'refuses an IPv4 prefix longer than /24 (no full addresses)');
select throws_ok($q$select * from app.egress_ranges_overlapping('2001:db8:7000::/64')$q$, '22023', null,
  'refuses an IPv6 prefix longer than /48');
select throws_ok(
  $q$select * from app.observe_network('d0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', decode(repeat('a1', 32), 'hex'), 1, 4, 'somewhere')$q$,
  '22023', null, 'observe refuses an unknown egress source');
delete from app.network_egress_ranges where source in ('private_relay', 'tor');

-- ---------------------------------------------------------------------------
-- Realtime topic authorization (T-015, T-016)
-- d1 is present on space B (ok); d2 is present on space A (blocked).
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
insert into topic_checks values
  ('present on ok space', app_realtime.can_access_topic('net:' || (select space_id from obs where step = 'b1'))),
  ('own user topic', app_realtime.can_access_topic('user:00000000-0000-4000-8000-000000000001')),
  ('other user topic', app_realtime.can_access_topic('user:00000000-0000-4000-8000-000000000002')),
  ('malformed id', app_realtime.can_access_topic('net:not-a-uuid')),
  ('extra segment', app_realtime.can_access_topic('net:' || (select space_id from obs where step = 'b1') || ':x')),
  ('unknown kind', app_realtime.can_access_topic('room:' || (select space_id from obs where step = 'b1')));
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
insert into topic_checks values
  ('not present', app_realtime.can_access_topic('net:' || (select space_id from obs where step = 'b1'))),
  ('present on blocked space', app_realtime.can_access_topic('net:' || (select space_id from obs where step = 'a1')));
select set_config('request.jwt.claims', '', true);
insert into topic_checks values
  ('no claims', app_realtime.can_access_topic('user:00000000-0000-4000-8000-000000000001'));
reset role;
update app.network_presence set present_until = now() - interval '1 second'
 where device_id = 'd0000000-0000-4000-8000-000000000001' and space_id = (select space_id from obs where step = 'b1');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
insert into topic_checks values
  ('presence expired', app_realtime.can_access_topic('net:' || (select space_id from obs where step = 'b1')));
reset role;
update app.network_presence set present_until = now() + interval '10 minutes'
 where device_id = 'd0000000-0000-4000-8000-000000000001' and space_id = (select space_id from obs where step = 'b1');

select is((select allowed from topic_checks where label = 'present on ok space'), true, 'a present device may join net:{space} (T-015)');
select is((select allowed from topic_checks where label = 'not present'), false, 'a device without presence may not join net:{space} (T-015)');
select is((select allowed from topic_checks where label = 'presence expired'), false, 'expired presence loses net:{space}');
select is((select allowed from topic_checks where label = 'present on blocked space'), false, 'net:{space} is closed while the space is not ok (G5)');
select is((select allowed from topic_checks where label = 'own user topic'), true, 'user:{id} is open to that user (T-016)');
select is((select allowed from topic_checks where label = 'other user topic'), false, 'user:{id} is closed to other users (T-016)');
select is((select allowed from topic_checks where label = 'malformed id'), false, 'malformed topics are refused');
select is((select allowed from topic_checks where label = 'extra segment'), false, 'topics with extra segments are refused');
select is((select allowed from topic_checks where label = 'unknown kind'), false, 'unknown topic kinds are refused');
select is((select allowed from topic_checks where label = 'no claims'), false, 'no JWT claims, no access');

-- ---------------------------------------------------------------------------
-- Storage quota ledger (DEC-019, T-026 serial part)
-- ---------------------------------------------------------------------------
set local role app_server;
insert into q select 'r1', app.reserve_storage('user', '00000000-0000-4000-8000-000000000005', null, 60, 100, interval '1 hour'), null;
insert into q select 'r2', app.reserve_storage('user', '00000000-0000-4000-8000-000000000005', null, 50, 100, interval '1 hour'), null;
insert into q select 'rel', null, app.release_reservation((select rid from q where step = 'r1'));
insert into q select 'r3', app.reserve_storage('user', '00000000-0000-4000-8000-000000000005', null, 50, 100, interval '1 hour'), null;
insert into q select 'c3', null, app.commit_reservation((select rid from q where step = 'r3'), 50);
insert into q select 'c3again', null, app.commit_reservation((select rid from q where step = 'r3'), 50);
reset role;
select isnt((select rid from q where step = 'r1'), null, 'a reservation within quota succeeds');
select is((select rid from q where step = 'r2'), null, 'a reservation that would exceed the quota is refused');
select isnt((select rid from q where step = 'r3'), null, 'releasing a reservation frees its bytes');
select is((select ok from q where step = 'c3again'), false, 'commit is idempotent');
select is(
  (select array[bytes_committed, bytes_reserved, files_committed::bigint] from app.storage_usage
    where subject_type = 'user' and subject_id = '00000000-0000-4000-8000-000000000005'),
  array[50, 0, 1]::bigint[], 'committed and reserved bytes add up');
select throws_ok(
  $$select app.commit_reservation(app.reserve_storage('user', '00000000-0000-4000-8000-000000000005', null, 10, 100, interval '1 hour'), 11)$$,
  '22023', null, 'commit refuses a size different from the reservation');

-- ---------------------------------------------------------------------------
-- Shares, realtime triggers (T-018) and end_share (T-042)
-- Space B is ok; device 1 is present there.
-- ---------------------------------------------------------------------------
insert into app.shares (id, scope, network_space_id, kind, created_by_user_id, created_by_device_id,
                        billing_subject_type, billing_subject_id, status, retention_class, expires_at, entitlement_snapshot)
values ('a0000000-0000-4000-8000-000000000001', 'network', (select space_id from obs where step = 'b1'), 'text',
        '00000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'user',
        '00000000-0000-4000-8000-000000000001', 'active', 'd7', now() + interval '1 day', '{"historyRetentionDays": 30}');
insert into app.text_items (share_id, network_space_id, content, content_bytes)
values ('a0000000-0000-4000-8000-000000000001', (select space_id from obs where step = 'b1'), 'hello', 5);

select is(
  (select array_agg(topic order by topic) from realtime.messages
    where payload ->> 'shareId' = 'a0000000-0000-4000-8000-000000000001'),
  array['net:' || (select space_id from obs where step = 'b1'), 'user:00000000-0000-4000-8000-000000000001'],
  'a local share emits only to its space topic and its creator topic (T-018)');
select ok(
  (select bool_and(private) from realtime.messages where payload ->> 'shareId' = 'a0000000-0000-4000-8000-000000000001'),
  'share signals are private messages');

update app.text_items set content = 'hello again', content_bytes = 11, version = 2
 where share_id = 'a0000000-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from realtime.messages
    where payload ->> 'shareId' = 'a0000000-0000-4000-8000-000000000001' and payload ->> 'version' = '2'),
  2, 'a text edit emits share.changed with the new version');

set local role app_server;
insert into q select 'end1', null, app.end_share('a0000000-0000-4000-8000-000000000001', 'deleted_by_creator');
insert into q select 'end2', null, app.end_share('a0000000-0000-4000-8000-000000000001', 'deleted_by_creator');
reset role;
select is((select ok from q where step = 'end1'), true, 'end_share ends an active share');
select is((select ok from q where step = 'end2'), false, 'end_share is idempotent (T-042)');
select is(
  (select array[status, end_reason] from app.shares where id = 'a0000000-0000-4000-8000-000000000001'),
  array['deleted', 'deleted_by_creator'], 'status and reason recorded');
select is((select content from app.text_items where share_id = 'a0000000-0000-4000-8000-000000000001'), null,
  'end_share erases text content');
select ok(
  (select metadata_purge_after between now() + interval '29 days' and now() + interval '31 days'
     from app.shares where id = 'a0000000-0000-4000-8000-000000000001'),
  'the tombstone is purged after the snapshot retention');
select is(
  (select count(*)::int from realtime.messages
    where payload ->> 'shareId' = 'a0000000-0000-4000-8000-000000000001' and payload ->> 'status' = 'deleted'),
  2, 'ending a share emits share.changed');
select is(
  (select count(*)::int
     from realtime.messages m, jsonb_object_keys(m.payload) as k
    where (m.topic like 'net:%' or m.topic like 'user:%')
      and k not in ('v', 'type', 'shareId', 'status', 'version', 'spaceId', 'id')),
  0, 'signal payloads contain only IDs and state (T-018)');

-- A file share: ending it releases committed bytes and queues the object for deletion.
insert into app.storage_usage (subject_type, subject_id, bytes_committed, files_committed)
values ('user', '00000000-0000-4000-8000-000000000001', 1000, 1);
insert into app.shares (id, scope, network_space_id, kind, created_by_user_id, billing_subject_type, billing_subject_id,
                        status, retention_class, expires_at, file_count, total_bytes, entitlement_snapshot)
values ('a0000000-0000-4000-8000-000000000002', 'network', (select space_id from obs where step = 'b1'), 'files',
        '00000000-0000-4000-8000-000000000001', 'user', '00000000-0000-4000-8000-000000000001', 'active', 'd7',
        now() + interval '1 day', 1, 1000, '{}');
insert into app.files (id, share_id, object_key, original_name, declared_mime, stored_content_type,
                       declared_size_bytes, size_bytes, upload_status, upload_expires_at)
values ('f0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002',
        'd7/2026/10/15/f0000000-0000-4000-8000-000000000002', 'a.txt', 'text/plain', 'application/octet-stream',
        1000, 1000, 'verified', now() + interval '2 hours');
do $$ begin perform app.end_share('a0000000-0000-4000-8000-000000000002', 'expired'); end $$;
select is(
  (select array[bytes_committed, files_committed::bigint] from app.storage_usage
    where subject_type = 'user' and subject_id = '00000000-0000-4000-8000-000000000001'),
  array[0, 0]::bigint[], 'ending a file share releases its committed bytes');
select is(
  (select count(*)::int from app.object_deletions
    where object_key = 'd7/2026/10/15/f0000000-0000-4000-8000-000000000002' and completed_at is null),
  1, 'ending a file share queues its object for deletion');
select is((select upload_status from app.files where id = 'f0000000-0000-4000-8000-000000000002'), 'deleted',
  'the file is marked deleted');

-- Storage deletions (review M1 residual). An upload URL can't be revoked, so while one may still
-- be live, the executor holds the key with a tombstone until the URL expiry plus 5 minutes.
insert into app.shares (id, scope, network_space_id, kind, created_by_user_id, billing_subject_type, billing_subject_id,
                        status, retention_class, expires_at, file_count, total_bytes, entitlement_snapshot)
values ('a0000000-0000-4000-8000-000000000006', 'network', (select space_id from obs where step = 'b1'), 'files',
        '00000000-0000-4000-8000-000000000001', 'user', '00000000-0000-4000-8000-000000000001', 'pending_upload', 'd7',
        now() + interval '1 day', 2, 20, '{}');
insert into app.files (id, share_id, object_key, original_name, declared_mime, stored_content_type,
                       declared_size_bytes, upload_status, upload_expires_at, upload_url_expires_at)
values
  ('f0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000006',
   'd7/2026/10/15/f0000000-0000-4000-8000-000000000006', 'live.bin', 'application/octet-stream',
   'application/octet-stream', 10, 'pending', now() + interval '2 hours', now() + interval '10 minutes'),
  ('f0000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000006',
   'd7/2026/10/15/f0000000-0000-4000-8000-000000000007', 'old.bin', 'application/octet-stream',
   'application/octet-stream', 10, 'pending', now() + interval '2 hours', now() - interval '6 minutes');
do $$ begin perform app.end_share('a0000000-0000-4000-8000-000000000006', 'deleted_by_creator'); end $$;
set local role app_server;
insert into cl select 'first', object_key, hold_until, tombstoned from app.claim_object_deletions('a0000000-0000-4000-8000-000000000006', 10);
insert into cl select 'again', object_key, hold_until, tombstoned from app.claim_object_deletions('a0000000-0000-4000-8000-000000000006', 10);
reset role;
select is((select count(*)::int from cl where step = 'first'), 2, 'claims the share''s due deletions');
select is(
  (select hold_until from cl where step = 'first' and object_key = 'd7/2026/10/15/f0000000-0000-4000-8000-000000000006'),
  (select upload_url_expires_at + interval '5 minutes' from app.files where id = 'f0000000-0000-4000-8000-000000000006'),
  'an object whose upload URL may still be live is held until the URL expiry plus 5 minutes');
select is(
  (select hold_until from cl where step = 'first' and object_key = 'd7/2026/10/15/f0000000-0000-4000-8000-000000000007'),
  null, 'an object whose upload URLs have all expired is deleted outright');
select is((select count(*)::int from cl where step = 'again'), 0, 'claimed rows are locked against a second executor');
select ok(
  (select bool_and(locked_until > now()) from app.object_deletions
    where source_file_id in ('f0000000-0000-4000-8000-000000000006', 'f0000000-0000-4000-8000-000000000007')),
  'claiming sets locked_until');
update app.object_deletions set locked_until = null, not_before = now() + interval '1 hour'
 where source_file_id = 'f0000000-0000-4000-8000-000000000006';
update app.object_deletions set locked_until = null where source_file_id = 'f0000000-0000-4000-8000-000000000007';
set local role app_server;
insert into cl select 'other', object_key, hold_until, tombstoned from app.claim_object_deletions('a0000000-0000-4000-8000-000000000002', 10);
insert into cl select 'later', object_key, hold_until, tombstoned from app.claim_object_deletions('a0000000-0000-4000-8000-000000000006', 10);
reset role;
select is((select array_agg(object_key) from cl where step = 'other'), array['d7/2026/10/15/f0000000-0000-4000-8000-000000000002'],
  'a share filter claims only that share''s deletions');
select is((select array_agg(object_key) from cl where step = 'later'), array['d7/2026/10/15/f0000000-0000-4000-8000-000000000007'],
  'deletions are not claimed before not_before');

-- ---------------------------------------------------------------------------
-- Jobs: expire-shares (T-041 job part), fail-stale-uploads (T-022), purges
-- ---------------------------------------------------------------------------
insert into app.shares (id, scope, network_space_id, kind, created_by_user_id, billing_subject_type, billing_subject_id,
                        status, retention_class, expires_at, entitlement_snapshot)
values
  ('a0000000-0000-4000-8000-000000000003', 'network', (select space_id from obs where step = 'b1'), 'text',
   '00000000-0000-4000-8000-000000000001', 'user', '00000000-0000-4000-8000-000000000001', 'active', 'd7',
   now() - interval '1 minute', '{}'),
  ('a0000000-0000-4000-8000-000000000005', 'network', (select space_id from obs where step = 'b1'), 'text',
   '00000000-0000-4000-8000-000000000001', 'user', '00000000-0000-4000-8000-000000000001', 'active', 'd7',
   now() + interval '1 hour', '{}');
do $$ begin perform app.expire_due_shares(500); end $$;
select is((select status from app.shares where id = 'a0000000-0000-4000-8000-000000000003'), 'expired',
  'expire-shares ends shares past expires_at');
select is((select status from app.shares where id = 'a0000000-0000-4000-8000-000000000005'), 'active',
  'expire-shares leaves unexpired shares alone');

insert into app.shares (id, scope, network_space_id, kind, created_by_user_id, billing_subject_type, billing_subject_id,
                        status, retention_class, expires_at, file_count, total_bytes, entitlement_snapshot)
values ('a0000000-0000-4000-8000-000000000004', 'network', (select space_id from obs where step = 'b1'), 'files',
        '00000000-0000-4000-8000-000000000006', 'user', '00000000-0000-4000-8000-000000000006', 'pending_upload', 'd7',
        now() + interval '1 day', 1, 500, '{}');
insert into app.files (id, share_id, object_key, original_name, declared_mime, stored_content_type,
                       declared_size_bytes, upload_status, upload_expires_at)
values ('f0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000004',
        'd7/2026/10/15/f0000000-0000-4000-8000-000000000004', 'b.bin', 'application/octet-stream',
        'application/octet-stream', 500, 'pending', now() - interval '1 minute');
do $$ begin perform app.reserve_storage('user', '00000000-0000-4000-8000-000000000006', 'f0000000-0000-4000-8000-000000000004', 500, 10000, interval '3 hours'); end $$;
do $$ begin perform app.fail_stale_uploads(500); end $$;
select is(
  (select array[upload_status, rejection_reason] from app.files where id = 'f0000000-0000-4000-8000-000000000004'),
  array['rejected', 'upload_timeout'], 'a stale pending upload is rejected (T-022)');
select is(
  (select bytes_reserved from app.storage_usage where subject_type = 'user' and subject_id = '00000000-0000-4000-8000-000000000006'),
  0::bigint, 'its reservation is released (T-022)');
select is(
  (select count(*)::int from app.object_deletions where source_file_id = 'f0000000-0000-4000-8000-000000000004'),
  1, 'its object is queued for deletion (T-022)');
select is(
  (select array[status, end_reason] from app.shares where id = 'a0000000-0000-4000-8000-000000000004'),
  array['failed', 'upload_failed'], 'the share fails as a whole (DV1-10)');

do $$ begin perform app.reserve_storage('user', '00000000-0000-4000-8000-000000000004', null, 10, 100, interval '1 second'); end $$;
update app.storage_reservations set expires_at = now() - interval '1 minute'
 where subject_id = '00000000-0000-4000-8000-000000000004';
do $$ begin perform app.release_stale_reservations(500); end $$;
select is(
  (select bytes_reserved from app.storage_usage where subject_type = 'user' and subject_id = '00000000-0000-4000-8000-000000000004'),
  0::bigint, 'release-stale-reservations frees abandoned reservations');

update app.network_presence set last_seen_at = now() - interval '25 hours'
 where device_id = 'd0000000-0000-4000-8000-000000000006';
do $$ begin perform app.purge_ephemeral(); end $$;
select is((select count(*)::int from app.network_presence where device_id = 'd0000000-0000-4000-8000-000000000006'), 0,
  'presence rows are deleted 24 h after last seen');

insert into app.network_spaces (id, network_key, key_version, family, last_seen_at)
values ('e0000000-0000-4000-8000-000000000001', decode(repeat('e5', 32), 'hex'), 1, 4, now() - interval '31 days');
update app.network_spaces set last_seen_at = now() - interval '31 days' where id = (select space_id from obs where step = 'b1');
do $$ begin perform app.purge_idle_spaces(1000); end $$;
select is((select count(*)::int from app.network_spaces where id = 'e0000000-0000-4000-8000-000000000001'), 0,
  'idle spaces without shares are purged after 30 days');
select is((select count(*)::int from app.network_spaces where id = (select space_id from obs where step = 'b1')), 1,
  'spaces that still hold shares are kept');

-- ---------------------------------------------------------------------------
-- Key rotation (03 §3.2): a space is re-keyed the first time it is seen under the new version
-- ---------------------------------------------------------------------------
insert into app.network_spaces (id, network_key, key_version, family)
values ('e0000000-0000-4000-8000-000000000002', decode(repeat('f6', 32), 'hex'), 1, 4);
set local role app_server;
insert into q select 'rekey', null, app.rekey_network_space(decode(repeat('f6', 32), 'hex'), 1, decode(repeat('f7', 32), 'hex'), 2);
insert into q select 'rekey-again', null, app.rekey_network_space(decode(repeat('f6', 32), 'hex'), 1, decode(repeat('f7', 32), 'hex'), 2);
reset role;
select is(
  (select array[key_version::text, encode(network_key, 'hex')] from app.network_spaces where id = 'e0000000-0000-4000-8000-000000000002'),
  array['2', repeat('f7', 32)], 'a space keeps its id (and content) when re-keyed to the new secret version');
select is((select ok from q where step = 'rekey-again'), false, 're-keying is idempotent');

-- ---------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------
select throws_ok(
  $$insert into app.shares (scope, kind, billing_subject_type, billing_subject_id, status, retention_class, expires_at, entitlement_snapshot)
    values ('network', 'text', 'user', '00000000-0000-4000-8000-000000000001', 'active', 'd7', now() + interval '1 day', '{}')$$,
  '23514', null, 'a network share needs a network space');
-- Phase 2 added the link_only scope (never visible on a network); it can still never carry a space.
select throws_ok(
  $$insert into app.shares (scope, network_space_id, kind, billing_subject_type, billing_subject_id, status, retention_class, expires_at, entitlement_snapshot)
    values ('link_only', (select space_id from obs where step = 'b1'), 'text', 'user', '00000000-0000-4000-8000-000000000001', 'active', 'd7', now() + interval '1 day', '{}')$$,
  '23514', null, 'a link_only share can never belong to a network space');
select throws_ok(
  $$insert into app.files (share_id, object_key, original_name, declared_mime, stored_content_type, declared_size_bytes, upload_expires_at)
    values ('a0000000-0000-4000-8000-000000000005', 'uploads/report.pdf', 'report.pdf', 'application/pdf', 'application/pdf', 1, now())$$,
  '23514', null, 'object keys must follow {class}/{yyyy}/{mm}/{dd}/{uuid} (DEC-010)');

select * from finish();
rollback;
