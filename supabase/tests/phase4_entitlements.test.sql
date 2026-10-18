-- Phase 4B database tests (P4-09, P4-10; phase 4 §17.6, §17.12, §17.19.2): the read-only
-- subscriptions and overrides tables, the override whitelist and the operator functions, the
-- resolution input (every subscription status at its time boundaries, T4-EN1; overrides, T4-EN2;
-- the deletion grace, E30), and the daily-volume refund of shares that never became active (C4-6).
begin;
create extension if not exists pgtap with schema extensions;

select plan(73);

-- ---------------------------------------------------------------------------
-- Structure and grants (§17.12.4)
-- ---------------------------------------------------------------------------
select has_table('app', 'subscriptions', 'app.subscriptions exists');
select has_table('app', 'entitlement_overrides', 'app.entitlement_overrides exists');
select has_table('app', 'upload_volume_charges', 'app.upload_volume_charges exists');
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relname in ('subscriptions', 'entitlement_overrides', 'upload_volume_charges') and not c.relrowsecurity),
  0, 'row level security is on for the new tables');
select ok(has_table_privilege('app_server', 'app.subscriptions', 'SELECT') and has_table_privilege('app_server', 'app.entitlement_overrides', 'SELECT'),
  'app_server may read subscriptions and overrides (resolution)');
select is(
  (select count(*)::int
     from unnest(array['app.subscriptions', 'app.entitlement_overrides']) as t(tbl),
          unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p(priv)
    where has_table_privilege('app_server', t.tbl, p.priv)),
  0, 'app_server can''t write subscriptions or overrides: no client or app path can raise a plan (07 §2.2)');
select is(
  (select count(*)::int from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p(priv)
    where has_table_privilege('app_server', 'app.upload_volume_charges', p.priv)),
  4, 'app_server records volume charges');
select is(
  (select count(*)::int
     from unnest(array['app.subscriptions', 'app.entitlement_overrides', 'app.upload_volume_charges']) as t(tbl),
          unnest(array['anon', 'authenticated', 'app_janitor', 'app_egress_loader']) as r(role),
          unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p(priv)
    where has_table_privilege(r.role, t.tbl, p.priv)),
  0, 'no other role reaches the new tables');
select ok(has_function_privilege('app_server', 'app.entitlement_state(uuid)', 'EXECUTE'), 'app_server can read the resolution input');
select is(
  (select count(*)::int from unnest(array['anon', 'authenticated', 'app_janitor', 'app_egress_loader']) as r(role)
    where has_function_privilege(r.role, 'app.entitlement_state(uuid)', 'EXECUTE')
       or has_function_privilege(r.role, 'app.refund_upload_volume(uuid)', 'EXECUTE')),
  0, 'nobody else can read entitlements or refund volume');
select is(
  (select count(*)::int
     from unnest(array['app.admin_grant_override(uuid, text, jsonb, text, text, timestamptz)',
                       'app.admin_revoke_override(uuid, text, text)']) as f(sig),
          unnest(array['app_server', 'app_janitor', 'app_egress_loader', 'anon', 'authenticated']) as r(role)
    where has_function_privilege(r.role, f.sig, 'EXECUTE')),
  0, 'the override functions are for operators only (granted to nobody)');

-- ---------------------------------------------------------------------------
-- Fixtures. b5…01–b5…13: accounts with one subscription each; b5…20: overrides; b5…21: none;
-- b5…30: deletion; b5…40: refunds. a5…01: anonymous.
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, is_anonymous, encrypted_password, created_at, updated_at)
select id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', email, anon, '', now(), now()
  from (values
    ('a5000000-0000-4000-8000-000000000001', null, true),
    ('b5000000-0000-4000-8000-000000000001', 'e1@example.com', false),
    ('b5000000-0000-4000-8000-000000000002', 'e2@example.com', false),
    ('b5000000-0000-4000-8000-000000000003', 'e3@example.com', false),
    ('b5000000-0000-4000-8000-000000000004', 'e4@example.com', false),
    ('b5000000-0000-4000-8000-000000000005', 'e5@example.com', false),
    ('b5000000-0000-4000-8000-000000000006', 'e6@example.com', false),
    ('b5000000-0000-4000-8000-000000000007', 'e7@example.com', false),
    ('b5000000-0000-4000-8000-000000000008', 'e8@example.com', false),
    ('b5000000-0000-4000-8000-000000000009', 'e9@example.com', false),
    ('b5000000-0000-4000-8000-000000000010', 'e10@example.com', false),
    ('b5000000-0000-4000-8000-000000000011', 'e11@example.com', false),
    ('b5000000-0000-4000-8000-000000000012', 'e12@example.com', false),
    ('b5000000-0000-4000-8000-000000000013', 'e13@example.com', false),
    ('b5000000-0000-4000-8000-000000000020', 'e20@example.com', false),
    ('b5000000-0000-4000-8000-000000000021', 'e21@example.com', false),
    ('b5000000-0000-4000-8000-000000000030', 'e30@example.com', false),
    ('b5000000-0000-4000-8000-000000000040', 'e40@example.com', false)
  ) as u(id, email, anon);

-- One subscription per account, each at a boundary of §17.6.2. now() is this transaction's start.
insert into app.subscriptions (provider, provider_subscription_id, provider_customer_id, subject_type, subject_id, plan, billing_interval,
                               status, current_period_end, cancel_at_period_end, grace_until, provider_updated_at)
values
  ('fake', 's1', 'c1', 'user', 'b5000000-0000-4000-8000-000000000001', 'pro', 'month', 'active', now() + interval '20 days', false, null, now()),
  ('fake', 's2', 'c2', 'user', 'b5000000-0000-4000-8000-000000000002', 'pro', 'month', 'trialing', now() + interval '5 days', false, null, now()),
  ('fake', 's3', 'c3', 'user', 'b5000000-0000-4000-8000-000000000003', 'pro', 'month', 'paused', now() + interval '20 days', false, null, now()),
  ('fake', 's4', 'c4', 'user', 'b5000000-0000-4000-8000-000000000004', 'pro', 'month', 'expired', now() - interval '1 day', false, null, now()),
  ('fake', 's5', 'c5', 'user', 'b5000000-0000-4000-8000-000000000005', 'pro', 'month', 'past_due', now() - interval '1 day', false, now() + interval '1 second', now()),
  ('fake', 's6', 'c6', 'user', 'b5000000-0000-4000-8000-000000000006', 'pro', 'month', 'past_due', now() - interval '1 day', false, now() - interval '1 second', now()),
  ('fake', 's7', 'c7', 'user', 'b5000000-0000-4000-8000-000000000007', 'pro', 'month', 'past_due', now() - interval '1 day', false, now(), now()),
  ('fake', 's8', 'c8', 'user', 'b5000000-0000-4000-8000-000000000008', 'pro', 'year', 'canceled', now() + interval '1 second', false, null, now()),
  ('fake', 's9', 'c9', 'user', 'b5000000-0000-4000-8000-000000000009', 'pro', 'year', 'canceled', now() - interval '1 second', false, null, now()),
  ('fake', 's10', 'c10', 'user', 'b5000000-0000-4000-8000-000000000010', 'pro', 'year', 'canceled', null, false, null, now()),
  ('fake', 's11', 'c11', 'user', 'b5000000-0000-4000-8000-000000000011', 'pro', 'month', 'active', now() + interval '3 days', true, null, now()),
  -- b5…12: an old active subscription and a newer expired one (resubscribed elsewhere, or a stale row).
  ('fake', 's12a', 'c12', 'user', 'b5000000-0000-4000-8000-000000000012', 'pro', 'month', 'active', now() + interval '9 days', false, null, now() - interval '30 days'),
  ('fake', 's12b', 'c12', 'user', 'b5000000-0000-4000-8000-000000000012', 'pro', 'month', 'expired', now() - interval '1 day', false, null, now()),
  -- b5…13: two non-entitling ones; the latest is shown.
  ('fake', 's13a', 'c13', 'user', 'b5000000-0000-4000-8000-000000000013', 'pro', 'month', 'expired', now() - interval '40 days', false, null, now() - interval '40 days'),
  ('fake', 's13b', 'c13', 'user', 'b5000000-0000-4000-8000-000000000013', 'pro', 'month', 'paused', now() + interval '1 day', false, null, now());

-- ---------------------------------------------------------------------------
-- Resolution input: subscriptions (T4-EN1)
-- ---------------------------------------------------------------------------
select is((select row(subscription, entitled, overrides, deletion_pending)::text from app.entitlement_state('b5000000-0000-4000-8000-000000000021')),
  row(null::jsonb, false, '[]'::jsonb, false)::text, 'an account with nothing: no subscription, not entitled, no overrides');
select is((select entitled from app.entitlement_state('b5000000-0000-4000-8000-000000000001')), true, 'active entitles');
select is((select entitled from app.entitlement_state('b5000000-0000-4000-8000-000000000002')), true, 'trialing entitles');
select is((select entitled from app.entitlement_state('b5000000-0000-4000-8000-000000000003')), false, 'paused does not');
select is((select entitled from app.entitlement_state('b5000000-0000-4000-8000-000000000004')), false, 'expired does not');
select is((select entitled from app.entitlement_state('b5000000-0000-4000-8000-000000000005')), true, 'past_due entitles until grace_until (1 s left)');
select is((select entitled from app.entitlement_state('b5000000-0000-4000-8000-000000000006')), false, 'past_due 1 s after grace_until does not');
select is((select entitled from app.entitlement_state('b5000000-0000-4000-8000-000000000007')), false, 'past_due exactly at grace_until does not');
select is((select entitled from app.entitlement_state('b5000000-0000-4000-8000-000000000008')), true, 'canceled entitles until the paid period ends (1 s left)');
select is((select entitled from app.entitlement_state('b5000000-0000-4000-8000-000000000009')), false, 'canceled 1 s after the period does not');
select is((select entitled from app.entitlement_state('b5000000-0000-4000-8000-000000000010')), false, 'canceled with no period end does not');
select is((select entitled from app.entitlement_state('b5000000-0000-4000-8000-000000000011')), true,
  'active with cancel_at_period_end still entitles (Free comes with the provider''s next state)');
select is((select subscription ->> 'status' from app.entitlement_state('b5000000-0000-4000-8000-000000000012')), 'active',
  'with several subscriptions, the entitling one is shown');
select is((select entitled from app.entitlement_state('b5000000-0000-4000-8000-000000000012')), true, 'and entitles');
select is((select subscription ->> 'status' from app.entitlement_state('b5000000-0000-4000-8000-000000000013')), 'paused',
  'with none entitling, the latest is shown');
select is(
  (select array(select jsonb_object_keys(subscription) order by 1) from app.entitlement_state('b5000000-0000-4000-8000-000000000011')),
  array['cancelAtPeriodEnd', 'currentPeriodEnd', 'graceUntil', 'status'],
  'the subscription summary carries only status, period end, cancel flag and grace (no provider IDs)');
select is((select (subscription ->> 'cancelAtPeriodEnd')::boolean from app.entitlement_state('b5000000-0000-4000-8000-000000000011')), true,
  'cancelAtPeriodEnd is reported');
select is((select row(subscription, entitled)::text from app.entitlement_state('a5000000-0000-4000-8000-000000000001')),
  row(null::jsonb, false)::text, 'another user''s subscriptions never show (subject filter)');

-- ---------------------------------------------------------------------------
-- Overrides: whitelist, validation, audit (T4-EN2)
-- ---------------------------------------------------------------------------
select throws_ok($q$insert into app.entitlement_overrides (subject_type, subject_id, key, value, reason, created_by)
                    values ('user', 'b5000000-0000-4000-8000-000000000020', 'limits.maxFilesPerShare', '500', 'x', 'ops')$q$,
  '23514', null, 'a limit outside the whitelist is refused by the table');
select throws_ok($q$insert into app.entitlement_overrides (subject_type, subject_id, key, value, reason, created_by)
                    values ('user', 'b5000000-0000-4000-8000-000000000020', 'features.everything', 'true', 'x', 'ops')$q$,
  '23514', null, 'an unknown feature is refused by the table');
select throws_ok($q$select app.admin_grant_override('a5000000-0000-4000-8000-000000000001', 'plan', '"pro"', 'beta', 'ops')$q$,
  '22023', 'overrides are for permanent accounts only', 'anonymous users can''t be given a plan');
select throws_ok($q$select app.admin_grant_override(gen_random_uuid(), 'plan', '"pro"', 'beta', 'ops')$q$,
  '22023', 'overrides are for permanent accounts only', 'an unknown user is refused');
select throws_ok($q$select app.admin_grant_override('b5000000-0000-4000-8000-000000000020', 'plan', '"team"', 'beta', 'ops')$q$,
  '22023', null, 'plan must be free or pro');
select throws_ok($q$select app.admin_grant_override('b5000000-0000-4000-8000-000000000020', 'plan', '1', 'beta', 'ops')$q$,
  '22023', null, 'plan must be a string');
select throws_ok($q$select app.admin_grant_override('b5000000-0000-4000-8000-000000000020', 'limits.maxFileBytes', '1.5', 'beta', 'ops')$q$,
  '22023', null, 'limits must be whole numbers');
select throws_ok($q$select app.admin_grant_override('b5000000-0000-4000-8000-000000000020', 'limits.activeStorageBytes', '0', 'beta', 'ops')$q$,
  '22023', null, 'limits must be positive');
select throws_ok($q$select app.admin_grant_override('b5000000-0000-4000-8000-000000000020', 'limits.historyRetentionDays', '40000', 'beta', 'ops')$q$,
  '22023', null, 'retention is bounded');
select throws_ok($q$select app.admin_grant_override('b5000000-0000-4000-8000-000000000020', 'features.linkPasswords', '"yes"', 'beta', 'ops')$q$,
  '22023', null, 'features must be booleans');
select throws_ok($q$select app.admin_grant_override('b5000000-0000-4000-8000-000000000020', 'plan', '"pro"', ' ', 'ops')$q$,
  '22023', null, 'a reason is required');
select throws_ok($q$select app.admin_grant_override('b5000000-0000-4000-8000-000000000020', 'plan', '"pro"', 'beta', '')$q$,
  '22023', null, 'the operator''s name is required');
select throws_ok($q$select app.admin_grant_override('b5000000-0000-4000-8000-000000000020', 'plan', '"pro"', 'beta', 'ops', now() - interval '1 minute')$q$,
  '22023', null, 'an expiry in the past is refused');

create temp table o5 (step text primary key, id uuid) on commit drop;
insert into o5 select 'pro', app.admin_grant_override('b5000000-0000-4000-8000-000000000020', 'plan', '"pro"', 'beta tester', 'ops-alice');
select isnt((select id from o5 where step = 'pro'), null, 'an operator grants Pro by override');
select is(
  (select metadata - 'overrideId' - 'expiresAt' from app.audit_events where action = 'admin.override_granted' and target_id = 'b5000000-0000-4000-8000-000000000020'),
  '{"key": "plan", "value": "pro", "operator": "ops-alice", "reason": "beta tester"}'::jsonb,
  'the grant is audited with the operator and the reason');
select is((select actor_kind from app.audit_events where action = 'admin.override_granted' and target_id = 'b5000000-0000-4000-8000-000000000020'),
  'operator', 'as an operator action');

-- Order and validity: an older and a newer limit override, an expired one and a revoked one.
insert into app.entitlement_overrides (subject_type, subject_id, key, value, reason, created_by, created_at, expires_at, revoked_at)
values
  ('user', 'b5000000-0000-4000-8000-000000000020', 'limits.activeStorageBytes', '1000', 'older', 'ops', now() - interval '2 days', null, null),
  ('user', 'b5000000-0000-4000-8000-000000000020', 'limits.activeStorageBytes', '2000', 'newer', 'ops', now() - interval '1 day', null, null),
  ('user', 'b5000000-0000-4000-8000-000000000020', 'features.linkPasswords', 'false', 'expired', 'ops', now() - interval '3 days', now() - interval '1 second', null),
  ('user', 'b5000000-0000-4000-8000-000000000020', 'features.transferHistory', 'false', 'revoked', 'ops', now() - interval '3 days', null, now() - interval '1 hour');
select is((select overrides from app.entitlement_state('b5000000-0000-4000-8000-000000000020')),
  '[{"key": "limits.activeStorageBytes", "value": 1000}, {"key": "limits.activeStorageBytes", "value": 2000}, {"key": "plan", "value": "pro"}]'::jsonb,
  'live overrides, oldest first (a later one of a key wins); expired and revoked ones are left out');
select is((select overrides from app.entitlement_state('b5000000-0000-4000-8000-000000000021')), '[]'::jsonb,
  'another account''s overrides never show');

select ok(app.admin_revoke_override((select id from o5 where step = 'pro'), 'beta over', 'ops-bob'), 'an operator revokes the override');
select ok(not app.admin_revoke_override((select id from o5 where step = 'pro'), 'again', 'ops-bob'), 'revoking twice does nothing');
select is((select count(*)::int from app.audit_events where action = 'admin.override_revoked' and target_id = 'b5000000-0000-4000-8000-000000000020'), 1,
  'the revocation is audited once');
select is((select jsonb_array_length(overrides) from app.entitlement_state('b5000000-0000-4000-8000-000000000020')), 2,
  'a revoked plan override no longer applies');
select throws_ok($q$select app.admin_revoke_override(gen_random_uuid(), '', 'ops')$q$, '22023', null, 'revoking needs a reason');

-- ---------------------------------------------------------------------------
-- Deletion grace (E30, D4-6)
-- ---------------------------------------------------------------------------
insert into app.profiles (user_id) values ('b5000000-0000-4000-8000-000000000030');
select is((select deletion_pending from app.entitlement_state('b5000000-0000-4000-8000-000000000030')), false, 'not pending by default');
select isnt(app.request_account_deletion('b5000000-0000-4000-8000-000000000030', interval '7 days'), null, 'deletion requested');
select is((select deletion_pending from app.entitlement_state('b5000000-0000-4000-8000-000000000030')), true, 'pending during the grace');
select ok(app.cancel_account_deletion('b5000000-0000-4000-8000-000000000030'), 'deletion cancelled');
select is((select deletion_pending from app.entitlement_state('b5000000-0000-4000-8000-000000000030')), false, 'writable again after cancelling');

-- ---------------------------------------------------------------------------
-- Daily volume refunds (C4-6, D4-26)
-- ---------------------------------------------------------------------------
insert into app.network_spaces (id, network_key, key_version, family)
values ('e5000000-0000-4000-8000-000000000001', decode(repeat('e5', 32), 'hex'), 1, 4);
insert into app.shares (id, scope, network_space_id, kind, created_by_user_id, billing_subject_type, billing_subject_id,
                        status, retention_class, expires_at, file_count, total_bytes, entitlement_snapshot)
select id::uuid, 'network', 'e5000000-0000-4000-8000-000000000001', 'files', 'b5000000-0000-4000-8000-000000000040',
       'user', 'b5000000-0000-4000-8000-000000000040', status, 'd7', now() + interval '1 day', 1, 1024, '{}'
  from (values
    ('95000000-0000-4000-8000-000000000001', 'pending_upload'),  -- fails at completion
    ('95000000-0000-4000-8000-000000000002', 'active'),          -- became active, then deleted
    ('95000000-0000-4000-8000-000000000003', 'pending_upload'),  -- taken down
    ('95000000-0000-4000-8000-000000000004', 'pending_upload'),  -- charged yesterday
    ('95000000-0000-4000-8000-000000000005', 'pending_upload'),  -- Pro: not charged per network
    ('95000000-0000-4000-8000-000000000006', 'pending_upload'),  -- cancelled by its creator
    ('95000000-0000-4000-8000-000000000007', 'pending_upload')   -- expires before the upload ends
  ) as s(id, status);
create temp table day5 as select date_bin('1 day', now(), timestamptz '2000-01-01 00:00:00+00') as today;
insert into app.upload_volume_charges (share_id, window_start, kib, network_key)
select share_id::uuid, case when yesterday then (select today from day5) - interval '1 day' else (select today from day5) end, kib, net
  from (values
    ('95000000-0000-4000-8000-000000000001', false, 300, 'e5000000-0000-4000-8000-000000000001'),
    ('95000000-0000-4000-8000-000000000002', false, 100, 'e5000000-0000-4000-8000-000000000001'),
    ('95000000-0000-4000-8000-000000000003', false, 100, 'e5000000-0000-4000-8000-000000000001'),
    ('95000000-0000-4000-8000-000000000004', true, 200, 'e5000000-0000-4000-8000-000000000001'),
    ('95000000-0000-4000-8000-000000000005', false, 50, null),
    ('95000000-0000-4000-8000-000000000006', false, 25, 'e5000000-0000-4000-8000-000000000001'),
    ('95000000-0000-4000-8000-000000000007', false, 5000, 'e5000000-0000-4000-8000-000000000001')
  ) as c(share_id, yesterday, kib, net);
insert into app.rate_counters (key, window_start, value, expires_at)
values
  ('upload_kib:user:b5000000-0000-4000-8000-000000000040', (select today from day5), 1000, (select today from day5) + interval '1 day'),
  ('upload_kib:net:e5000000-0000-4000-8000-000000000001', (select today from day5), 1000, (select today from day5) + interval '1 day'),
  ('upload_kib:user:b5000000-0000-4000-8000-000000000040', (select today from day5) - interval '1 day', 500, (select today from day5));

create function pg_temp.used5(p_scope text, p_yesterday boolean default false) returns bigint language sql as $$
  select value from app.rate_counters
   where key = case p_scope when 'user' then 'upload_kib:user:b5000000-0000-4000-8000-000000000040'
                            else 'upload_kib:net:e5000000-0000-4000-8000-000000000001' end
     and window_start = (select today from day5) - case when p_yesterday then interval '1 day' else interval '0' end
$$;

select ok(app.end_share('95000000-0000-4000-8000-000000000001', 'upload_failed'), 'a rejected upload ends its share');
select is(pg_temp.used5('user'), 700::bigint, 'its volume is refunded to the user''s counter');
select is(pg_temp.used5('net'), 700::bigint, 'and to the network''s');
select isnt((select refunded_at from app.upload_volume_charges where share_id = '95000000-0000-4000-8000-000000000001'), null, 'the charge is marked refunded');
select ok(not app.refund_upload_volume('95000000-0000-4000-8000-000000000001'), 'a second refund does nothing');
select is(pg_temp.used5('user'), 700::bigint, 'and changes no counter');

select ok(app.end_share('95000000-0000-4000-8000-000000000002', 'deleted_by_creator'), 'an active share is deleted');
select is(row(pg_temp.used5('user'), (select refunded_at from app.upload_volume_charges where share_id = '95000000-0000-4000-8000-000000000002'))::text,
  row(700::bigint, null::timestamptz)::text, 'its upload happened: no refund');

select ok(app.end_share('95000000-0000-4000-8000-000000000003', 'blocked'), 'a pending share is taken down');
select is(row(pg_temp.used5('user'), (select refunded_at from app.upload_volume_charges where share_id = '95000000-0000-4000-8000-000000000003'))::text,
  row(700::bigint, null::timestamptz)::text, 'a takedown is never refunded');

select ok(app.end_share('95000000-0000-4000-8000-000000000004', 'upload_failed'), 'yesterday''s upload fails today');
select is(row(pg_temp.used5('user'), pg_temp.used5('user', true))::text, row(700::bigint, 300::bigint)::text,
  'only the charge''s own window is refunded: today''s budget is unchanged');

select ok(app.end_share('95000000-0000-4000-8000-000000000005', 'upload_failed'), 'a Pro upload fails');
select is(row(pg_temp.used5('user'), pg_temp.used5('net'))::text, row(650::bigint, 700::bigint)::text,
  'it is refunded to the user only: it was never charged to the network (D4-10)');

select ok(app.end_share('95000000-0000-4000-8000-000000000006', 'deleted_by_creator') and app.end_share('95000000-0000-4000-8000-000000000007', 'expired'),
  'an upload cancelled by its creator, and one whose share expired first');
select is(row(pg_temp.used5('user'), pg_temp.used5('net'))::text, row(0::bigint, 0::bigint)::text,
  'both are refunded, and a counter never goes below zero');

select * from finish();
rollback;
