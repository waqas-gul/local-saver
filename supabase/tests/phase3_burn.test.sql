-- Phase 3 database tests (P3-01): burn-after-download schema, claim_burn_share, confirm_burn_received,
-- finalize_claims, the end_share margin for consumed shares, grants. Test IDs refer to 09 §4 and
-- phase 3 §17.15. The 50-concurrent claim test (T-037) needs separate connections:
-- tests/integration/burn-concurrency.test.ts.
begin;
create extension if not exists pgtap with schema extensions;

select plan(74);

-- ---------------------------------------------------------------------------
-- Structure, flags and grants
-- ---------------------------------------------------------------------------
select has_column('app', 'shares', c, 'shares.' || c || ' exists')
  from unnest(array['claimed_at', 'claimed_by_user_id', 'claimed_device_id', 'claimed_link_session_hash',
                    'claimed_link_id', 'claim_grace_until']) as c;
select is(
  (select count(*)::int from pg_constraint
    where conrelid = 'app.shares'::regclass
      and conname in ('shares_claim_columns', 'shares_claim_complete', 'shares_claim_grace', 'shares_consumed_requires_burn',
                      'shares_claim_requires_burn')),
  5, 'the claim checks exist');
select ok(exists (select 1 from pg_indexes where schemaname = 'app' and indexname = 'shares_claim_grace_idx'),
  'claimed shares are indexed by the end of their grace');

select is((select enabled from app.runtime_flags where key = 'burn_after_download_enabled'), true,
  'the burn kill switch exists and defaults to on');
select is((select enabled from app.runtime_flags where key = 'free_burn_after_download'), false,
  'Free burn after download is off by default (Q-008)');

select ok(has_function_privilege('app_server', 'app.claim_burn_share(uuid, uuid, text, uuid, uuid, bytea, text, integer, text)', 'EXECUTE'),
  'app_server can claim burn shares');
select ok(has_function_privilege('app_server', 'app.confirm_burn_received(uuid, uuid, uuid, bytea)', 'EXECUTE'),
  'app_server can confirm a claim');
select ok(not has_function_privilege('app_server', 'app.finalize_claims(integer)', 'EXECUTE'),
  'finalize_claims is a job: not callable by the app');
select ok(
  not has_function_privilege('anon', 'app.claim_burn_share(uuid, uuid, text, uuid, uuid, bytea, text, integer, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app.claim_burn_share(uuid, uuid, text, uuid, uuid, bytea, text, integer, text)', 'EXECUTE')
  and not has_function_privilege('app_janitor', 'app.claim_burn_share(uuid, uuid, text, uuid, uuid, bytea, text, integer, text)', 'EXECUTE'),
  'client roles and the janitor cannot claim');

-- ---------------------------------------------------------------------------
-- Grace window (03 §5.4, D-6)
-- ---------------------------------------------------------------------------
select is(app.burn_grace(0), interval '15 minutes', 'grace for no bytes (a text) is 15 minutes');
select is(app.burn_grace(1), interval '15 minutes 1 second', 'a started MiB adds a second');
select is(app.burn_grace(1048576), interval '15 minutes 1 second', '1 MiB adds one second');
select is(app.burn_grace(100 * 1048576), interval '16 minutes 40 seconds', '100 MiB adds 100 seconds');
select is(app.burn_grace(1048576::bigint * 1048576), interval '6 hours', 'grace never exceeds 6 hours');

-- ---------------------------------------------------------------------------
-- Fixtures: creator (1), devices 2–4, one network space
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, is_anonymous, created_at, updated_at)
select ('30000000-0000-4000-8000-00000000000' || i)::uuid, '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated', true, now(), now()
  from generate_series(1, 4) as i;
insert into app.devices (id, user_id, label)
select ('d3000000-0000-4000-8000-00000000000' || i)::uuid, ('30000000-0000-4000-8000-00000000000' || i)::uuid, 'Device ' || i
  from generate_series(1, 4) as i;
insert into app.network_spaces (id, network_key, key_version, family)
values ('e3000000-0000-4000-8000-000000000001', decode(repeat('cd', 32), 'hex'), 1, 6);

-- b…1 burn files share (2 files, 3 MiB), b…2 burn text, b…3 not burn, b…4 burn expiring in 5 min,
-- b…5 burn but already expired (not yet ended by the job), b…6 burn for a viewer claim.
insert into app.shares (id, scope, network_space_id, kind, created_by_user_id, created_by_device_id, billing_subject_type,
                        billing_subject_id, status, retention_class, expires_at, burn_after_download, file_count,
                        total_bytes, entitlement_snapshot)
values
  ('b3000000-0000-4000-8000-000000000001', 'network', 'e3000000-0000-4000-8000-000000000001', 'files',
   '30000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'user',
   '30000000-0000-4000-8000-000000000001', 'active', 'd7', now() + interval '1 day', true, 2, 3145728,
   '{"historyRetentionDays": 30}'),
  ('b3000000-0000-4000-8000-000000000002', 'network', 'e3000000-0000-4000-8000-000000000001', 'text',
   '30000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'user',
   '30000000-0000-4000-8000-000000000001', 'active', 'd7', now() + interval '1 day', true, 0, 0,
   '{"historyRetentionDays": 30}'),
  ('b3000000-0000-4000-8000-000000000003', 'network', 'e3000000-0000-4000-8000-000000000001', 'files',
   '30000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'user',
   '30000000-0000-4000-8000-000000000001', 'active', 'd7', now() + interval '1 day', false, 1, 10,
   '{"historyRetentionDays": 30}'),
  ('b3000000-0000-4000-8000-000000000004', 'network', 'e3000000-0000-4000-8000-000000000001', 'files',
   '30000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'user',
   '30000000-0000-4000-8000-000000000001', 'active', 'd7', now() + interval '5 minutes', true, 1, 104857600,
   '{"historyRetentionDays": 30}'),
  ('b3000000-0000-4000-8000-000000000005', 'network', 'e3000000-0000-4000-8000-000000000001', 'files',
   '30000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'user',
   '30000000-0000-4000-8000-000000000001', 'active', 'd7', now() - interval '1 second', true, 1, 10,
   '{"historyRetentionDays": 30}'),
  ('b3000000-0000-4000-8000-000000000006', 'link_only', null, 'files',
   '30000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'user',
   '30000000-0000-4000-8000-000000000001', 'active', 'd7', now() + interval '1 day', true, 1, 10,
   '{"historyRetentionDays": 30}');
insert into app.files (id, share_id, network_space_id, object_key, original_name, declared_mime, stored_content_type,
                       declared_size_bytes, size_bytes, upload_status, upload_expires_at)
values
  ('f3000000-0000-4000-8000-000000000011', 'b3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001',
   'd7/2026/10/16/f3000000-0000-4000-8000-000000000011', 'a.bin', 'application/octet-stream', 'application/octet-stream',
   2097152, 2097152, 'verified', now() + interval '2 hours'),
  ('f3000000-0000-4000-8000-000000000012', 'b3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001',
   'd7/2026/10/16/f3000000-0000-4000-8000-000000000012', 'b.bin', 'application/octet-stream', 'application/octet-stream',
   1048576, 1048576, 'verified', now() + interval '2 hours'),
  ('f3000000-0000-4000-8000-000000000031', 'b3000000-0000-4000-8000-000000000003', 'e3000000-0000-4000-8000-000000000001',
   'd7/2026/10/16/f3000000-0000-4000-8000-000000000031', 'c.bin', 'application/octet-stream', 'application/octet-stream',
   10, 10, 'verified', now() + interval '2 hours'),
  ('f3000000-0000-4000-8000-000000000041', 'b3000000-0000-4000-8000-000000000004', 'e3000000-0000-4000-8000-000000000001',
   'd7/2026/10/16/f3000000-0000-4000-8000-000000000041', 'd.bin', 'application/octet-stream', 'application/octet-stream',
   104857600, 104857600, 'verified', now() + interval '2 hours'),
  ('f3000000-0000-4000-8000-000000000051', 'b3000000-0000-4000-8000-000000000005', 'e3000000-0000-4000-8000-000000000001',
   'd7/2026/10/16/f3000000-0000-4000-8000-000000000051', 'e.bin', 'application/octet-stream', 'application/octet-stream',
   10, 10, 'verified', now() + interval '2 hours'),
  ('f3000000-0000-4000-8000-000000000061', 'b3000000-0000-4000-8000-000000000006', null,
   'd7/2026/10/16/f3000000-0000-4000-8000-000000000061', 'f.bin', 'application/octet-stream', 'application/octet-stream',
   10, 10, 'verified', now() + interval '2 hours');
insert into app.text_items (share_id, network_space_id, content, content_bytes)
values ('b3000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000001', 'burn me', 7);
insert into app.share_links (id, share_id, secret_hmac, pepper_version, expires_at, entitlement_snapshot)
values ('L3linkAAAAAAAAA1', 'b3000000-0000-4000-8000-000000000006', decode(repeat('01', 32), 'hex'), 1,
        now() + interval '1 day', '{}');

create temp table c (step text primary key, outcome text, grace timestamptz, issuance int, by_you boolean) on commit drop;
grant select, insert on c to app_server;
grant app_server to current_user;

-- ---------------------------------------------------------------------------
-- Constraints (phase 3 §17.8.1)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$update app.shares set status = 'claimed', claimed_at = now(), claim_grace_until = now() + interval '1 minute'
     where id = 'b3000000-0000-4000-8000-000000000003'$$,
  '23514', null, 'only burn shares can be claimed');
select throws_ok(
  $$update app.shares set status = 'claimed', claimed_at = now(), claim_grace_until = now() + interval '1 minute'
     where id = 'b3000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'a claimed share names its claimant');
select throws_ok(
  $$update app.shares set status = 'claimed', claimed_at = now(), claim_grace_until = now() + interval '1 minute',
                          claimed_by_user_id = '30000000-0000-4000-8000-000000000002',
                          claimed_device_id = 'd3000000-0000-4000-8000-000000000002',
                          claimed_link_session_hash = decode(repeat('02', 32), 'hex')
     where id = 'b3000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'a claim has exactly one claimant kind');
select throws_ok(
  $$update app.shares set status = 'claimed', claimed_at = now(), claim_grace_until = now() + interval '7 hours',
                          claimed_link_session_hash = decode(repeat('02', 32), 'hex')
     where id = 'b3000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'grace never exceeds 6 hours');
select throws_ok(
  $$update app.shares set status = 'claimed', claimed_at = now(), claim_grace_until = now() + interval '10 minutes',
                          claimed_link_session_hash = decode(repeat('02', 32), 'hex')
     where id = 'b3000000-0000-4000-8000-000000000004'$$,
  '23514', null, 'grace never outlasts the share (D-6)');
select throws_ok(
  $$update app.shares set claimed_at = now() where id = 'b3000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'an active share has no claim columns');
select throws_ok(
  $$update app.shares set status = 'consumed', ended_at = now(), end_reason = 'consumed'
     where id = 'b3000000-0000-4000-8000-000000000003'$$,
  '23514', null, 'only burn shares can be consumed');

-- ---------------------------------------------------------------------------
-- claim_burn_share (T-037 single-session part, T-038, T-039)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$select * from app.claim_burn_share('b3000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000011', 'file',
       '30000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000002', decode(repeat('02', 32), 'hex'),
       'L3linkAAAAAAAAA1', 60, null)$$,
  '22023', null, 'a claim names one claimant kind, not two');
select throws_ok(
  $$select * from app.claim_burn_share('b3000000-0000-4000-8000-000000000001', null, 'file',
       '30000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000002', null, null, 60, null)$$,
  '22023', null, 'a file claim names the file');
select throws_ok(
  $$select * from app.claim_burn_share('b3000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000031', 'file',
       '30000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000002', null, null, 60, null)$$,
  '22023', 'the file is not a file of this share', 'the file must belong to the share');
select throws_ok(
  $$select * from app.claim_burn_share('b3000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000011', 'file',
       '30000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', null, null, 60, null)$$,
  '22023', 'creators never claim their own share', 'creators never claim (DEC-015, T-039)');
select is((select status from app.shares where id = 'b3000000-0000-4000-8000-000000000001'), 'active',
  'a refused creator claim changes nothing');

set local role app_server;
insert into c select 'win', * from app.claim_burn_share('b3000000-0000-4000-8000-000000000001',
  'f3000000-0000-4000-8000-000000000011', 'file', '30000000-0000-4000-8000-000000000002',
  'd3000000-0000-4000-8000-000000000002', null, null, 60, 'Chrome');
insert into c select 'other', * from app.claim_burn_share('b3000000-0000-4000-8000-000000000001',
  'f3000000-0000-4000-8000-000000000011', 'file', '30000000-0000-4000-8000-000000000003',
  'd3000000-0000-4000-8000-000000000003', null, null, 60, null);
insert into c select 'same-user-other-device', * from app.claim_burn_share('b3000000-0000-4000-8000-000000000001',
  'f3000000-0000-4000-8000-000000000011', 'file', '30000000-0000-4000-8000-000000000002',
  'd3000000-0000-4000-8000-000000000004', null, null, 60, null);
insert into c select 'retry2', * from app.claim_burn_share('b3000000-0000-4000-8000-000000000001',
  'f3000000-0000-4000-8000-000000000011', 'file', '30000000-0000-4000-8000-000000000002',
  'd3000000-0000-4000-8000-000000000002', null, null, 60, null);
insert into c select 'retry3', * from app.claim_burn_share('b3000000-0000-4000-8000-000000000001',
  'f3000000-0000-4000-8000-000000000011', 'file', '30000000-0000-4000-8000-000000000002',
  'd3000000-0000-4000-8000-000000000002', null, null, 60, null);
insert into c select 'retry4', * from app.claim_burn_share('b3000000-0000-4000-8000-000000000001',
  'f3000000-0000-4000-8000-000000000011', 'file', '30000000-0000-4000-8000-000000000002',
  'd3000000-0000-4000-8000-000000000002', null, null, 60, null);
insert into c select 'file2', * from app.claim_burn_share('b3000000-0000-4000-8000-000000000001',
  'f3000000-0000-4000-8000-000000000012', 'file', '30000000-0000-4000-8000-000000000002',
  'd3000000-0000-4000-8000-000000000002', null, null, 60, null);
insert into c select 'not-burn', * from app.claim_burn_share('b3000000-0000-4000-8000-000000000003',
  'f3000000-0000-4000-8000-000000000031', 'file', '30000000-0000-4000-8000-000000000002',
  'd3000000-0000-4000-8000-000000000002', null, null, 60, null);
insert into c select 'expired', * from app.claim_burn_share('b3000000-0000-4000-8000-000000000005',
  'f3000000-0000-4000-8000-000000000051', 'file', '30000000-0000-4000-8000-000000000002',
  'd3000000-0000-4000-8000-000000000002', null, null, 60, null);
insert into c select 'capped', * from app.claim_burn_share('b3000000-0000-4000-8000-000000000004',
  'f3000000-0000-4000-8000-000000000041', 'file', '30000000-0000-4000-8000-000000000002',
  'd3000000-0000-4000-8000-000000000002', null, null, 60, null);
insert into c select 'viewer', * from app.claim_burn_share('b3000000-0000-4000-8000-000000000006',
  'f3000000-0000-4000-8000-000000000061', 'file', null, null, decode(repeat('0a', 32), 'hex'), 'L3linkAAAAAAAAA1', 60, null);
insert into c select 'viewer-other', * from app.claim_burn_share('b3000000-0000-4000-8000-000000000006',
  'f3000000-0000-4000-8000-000000000061', 'file', null, null, decode(repeat('0b', 32), 'hex'), 'L3linkAAAAAAAAA1', 60, null);
insert into c select 'device-after-viewer', * from app.claim_burn_share('b3000000-0000-4000-8000-000000000006',
  'f3000000-0000-4000-8000-000000000061', 'file', '30000000-0000-4000-8000-000000000003',
  'd3000000-0000-4000-8000-000000000003', null, null, 60, null);
insert into c select 'viewer-retry', * from app.claim_burn_share('b3000000-0000-4000-8000-000000000006',
  'f3000000-0000-4000-8000-000000000061', 'file', null, null, decode(repeat('0a', 32), 'hex'), 'L3linkAAAAAAAAA1', 60, null);
insert into c select 'text', * from app.claim_burn_share('b3000000-0000-4000-8000-000000000002', null, 'text',
  '30000000-0000-4000-8000-000000000003', 'd3000000-0000-4000-8000-000000000003', null, null, null, null);
insert into c select 'text2', * from app.claim_burn_share('b3000000-0000-4000-8000-000000000002', null, 'text',
  '30000000-0000-4000-8000-000000000003', 'd3000000-0000-4000-8000-000000000003', null, null, null, null);
insert into c select 'text3', * from app.claim_burn_share('b3000000-0000-4000-8000-000000000002', null, 'text',
  '30000000-0000-4000-8000-000000000003', 'd3000000-0000-4000-8000-000000000003', null, null, null, null);
insert into c select 'text4', * from app.claim_burn_share('b3000000-0000-4000-8000-000000000002', null, 'text',
  '30000000-0000-4000-8000-000000000003', 'd3000000-0000-4000-8000-000000000003', null, null, null, null);
insert into c select 'text-as-file', * from app.claim_burn_share('b3000000-0000-4000-8000-000000000001', null, 'text',
  '30000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000002', null, null, null, null);
reset role;

select is((select array[outcome, issuance::text, by_you::text] from c where step = 'win'), array['claimed', '1', 'true'],
  'the first download claims the share (issuance 1)');
select is((select status from app.shares where id = 'b3000000-0000-4000-8000-000000000001'), 'claimed',
  'the share is claimed');
select is(
  (select array[claimed_by_user_id::text, claimed_device_id::text] from app.shares where id = 'b3000000-0000-4000-8000-000000000001'),
  array['30000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000002'],
  'the claimant is the verified user and their device');
select is((select grace from c where step = 'win'), now() + interval '15 minutes 3 seconds',
  'grace is 15 minutes plus a second per MiB (3 MiB)');
select is((select array[outcome, by_you::text] from c where step = 'other'), array['already_downloaded', 'false'],
  'anyone else gets already_downloaded (T-038)');
select is((select array[outcome, by_you::text] from c where step = 'same-user-other-device'), array['already_downloaded', 'false'],
  'the claim is tied to the device, not only the user');
select is((select array[outcome, issuance::text] from c where step = 'retry2'), array['retry', '2'],
  'the claimant may retry within grace (issuance 2)');
select is((select array[outcome, issuance::text] from c where step = 'retry3'), array['retry', '3'], 'issuance 3');
select is((select array[outcome, issuance::text] from c where step = 'retry4'), array['retry_limit', '3'],
  'a fourth URL for the same file is refused (≤ 3 per file)');
select is((select array[outcome, issuance::text] from c where step = 'file2'), array['retry', '1'],
  'each file of the share has its own count');
select is(
  (select array_agg(event order by id) from app.downloads where share_id = 'b3000000-0000-4000-8000-000000000001'),
  array['burn_claimed', 'burn_retry', 'burn_retry', 'burn_retry'],
  'one burn_claimed row, then a burn_retry row per later issuance; refusals write nothing');
select is(
  (select array[actor_kind, user_agent_family, (url_expires_at = now() + interval '60 seconds')::text,
                (retention_until = now() + interval '30 days')::text]
     from app.downloads where share_id = 'b3000000-0000-4000-8000-000000000001' and event = 'burn_claimed'),
  array['network_device', 'Chrome', 'true', 'true'],
  'the download row records the actor, URL lifetime and retention');
select is((select outcome from c where step = 'not-burn'), 'not_claimable', 'a share that is not burn is not claimable');
select is((select outcome from c where step = 'expired'), 'not_claimable', 'an expired burn share is not claimable');
select is((select grace from c where step = 'capped'), (select expires_at from app.shares where id = 'b3000000-0000-4000-8000-000000000004'),
  'grace stops at the share''s expiry (D-6)');
select is((select array[outcome, by_you::text] from c where step = 'viewer'), array['claimed', 'true'],
  'a link viewer session can claim');
select is((select claimed_link_session_hash from app.shares where id = 'b3000000-0000-4000-8000-000000000006'),
  decode(repeat('0a', 32), 'hex'), 'the viewer claimant is the session hash');
select is((select claimed_link_id from app.shares where id = 'b3000000-0000-4000-8000-000000000006'), 'L3linkAAAAAAAAA1',
  'the link used is recorded');
select is((select outcome from c where step = 'viewer-other'), 'already_downloaded', 'another viewer session loses');
select is((select outcome from c where step = 'device-after-viewer'), 'already_downloaded',
  'a device loses to a viewer claimant (mixed claimants)');
select is((select array[outcome, issuance::text] from c where step = 'viewer-retry'), array['retry', '2'],
  'the viewer claimant may retry');
select is(
  (select array_agg(outcome || ':' || issuance order by step) from c where step like 'text%' and step <> 'text-as-file'),
  array['claimed:1', 'retry:2', 'retry:3', 'retry_limit:3'], 'a text can be revealed 3 times (T-040)');
select is((select count(*)::int from app.downloads where share_id = 'b3000000-0000-4000-8000-000000000002' and event = 'text_revealed'),
  3, 'each reveal is logged as text_revealed');
select is((select outcome from c where step = 'text-as-file'), 'not_claimable',
  'a reveal of a files share is not claimable');
select is(
  (select count(*)::int from realtime.messages
    where payload ->> 'shareId' = 'b3000000-0000-4000-8000-000000000001' and payload ->> 'status' = 'claimed'),
  2, 'a claim emits share.changed to the space and creator topics');

-- After grace (or past expiry), even the claimant gets already_downloaded (by_you).
update app.shares set claimed_at = now() - interval '2 hours', claim_grace_until = now() - interval '1 hour'
 where id = 'b3000000-0000-4000-8000-000000000006';
set local role app_server;
insert into c select 'after-grace', * from app.claim_burn_share('b3000000-0000-4000-8000-000000000006',
  'f3000000-0000-4000-8000-000000000061', 'file', null, null, decode(repeat('0a', 32), 'hex'), 'L3linkAAAAAAAAA1', 60, null);
reset role;
select is((select array[outcome, by_you::text] from c where step = 'after-grace'), array['already_downloaded', 'true'],
  'after grace the claimant is told it is gone, and that they had it');

-- ---------------------------------------------------------------------------
-- confirm_burn_received and the 5-minute deletion margin (phase 3 §17.8.6)
-- ---------------------------------------------------------------------------
create temp table cf (step text primary key, result text) on commit drop;
grant select, insert on cf to app_server;
set local role app_server;
insert into cf select 'other', app.confirm_burn_received('b3000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000003', 'd3000000-0000-4000-8000-000000000003', null);
insert into cf select 'claimant', app.confirm_burn_received('b3000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000002', null);
insert into cf select 'again', app.confirm_burn_received('b3000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000002', null);
insert into cf select 'creator', app.confirm_burn_received('b3000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', null);
reset role;
select is((select result from cf where step = 'other'), 'not_claimant', 'only the claimant can confirm');
select is((select result from cf where step = 'claimant'), 'consumed', 'the claimant''s confirmation consumes the share');
select is((select result from cf where step = 'again'), 'already_consumed', 'confirming twice is idempotent');
select is((select result from cf where step = 'creator'), 'not_claimant', 'the creator is not the claimant');
select is(
  (select array[status, end_reason] from app.shares where id = 'b3000000-0000-4000-8000-000000000001'),
  array['consumed', 'consumed'], 'the share is consumed');
select is(
  (select array_agg(not_before = now() + interval '5 minutes' order by object_key) from app.object_deletions
    where source_file_id in ('f3000000-0000-4000-8000-000000000011', 'f3000000-0000-4000-8000-000000000012')),
  array[true, true], 'a consumed share''s objects are deleted 5 minutes later, not at once');
select is(
  (select array[claimed_by_user_id::text, claimed_device_id::text] from app.shares where id = 'b3000000-0000-4000-8000-000000000001'),
  array['30000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000002'],
  'a consumed share keeps its claim for audit');
select is((select count(*)::int from realtime.messages
            where payload ->> 'shareId' = 'b3000000-0000-4000-8000-000000000001' and payload ->> 'status' = 'consumed'),
  2, 'consuming emits share.changed');
set local role app_server;
insert into c select 'after-confirm', * from app.claim_burn_share('b3000000-0000-4000-8000-000000000001',
  'f3000000-0000-4000-8000-000000000012', 'file', '30000000-0000-4000-8000-000000000002',
  'd3000000-0000-4000-8000-000000000002', null, null, 60, null);
reset role;
select is((select array[outcome, by_you::text] from c where step = 'after-confirm'), array['already_downloaded', 'true'],
  'after "I''ve got it" no more URLs are issued');

-- ---------------------------------------------------------------------------
-- finalize_claims (finalize-burn-claims job)
-- ---------------------------------------------------------------------------
-- b…6: grace over (set above). b…2: text claimed, inside grace. b…4: claimed, capped at expiry.
select is(app.finalize_claims(500), 1, 'finalize ends claimed shares whose grace is over');
select is((select status from app.shares where id = 'b3000000-0000-4000-8000-000000000006'), 'consumed',
  'the claimed share past grace is consumed');
select is((select status from app.shares where id = 'b3000000-0000-4000-8000-000000000002'), 'claimed',
  'a claim inside grace is untouched');
select is((select content from app.text_items where share_id = 'b3000000-0000-4000-8000-000000000002'), 'burn me',
  'the text stays while the claimant''s grace runs');
select is(app.finalize_claims(500), 0, 'finalize is idempotent');
select is(
  (select array[revoked_at is not null, revoke_reason = 'share_ended'] from app.share_links where id = 'L3linkAAAAAAAAA1'),
  array[true, true], 'consuming revokes the share''s links (Phase 2 end_share behaviour)');

-- Ending a claimed share for another reason works: claimed is still open.
select is(app.end_share('b3000000-0000-4000-8000-000000000002', 'deleted_by_creator'), true,
  'a claimed share can still be deleted by its creator');
select is((select content from app.text_items where share_id = 'b3000000-0000-4000-8000-000000000002'), null,
  'and its text is erased');

select * from finish();
rollback;
