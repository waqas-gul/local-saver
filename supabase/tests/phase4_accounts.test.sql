-- Phase 4A database tests (P4-02, P4-03; phase 4 §17.5, §17.9, §17.12): device-session binding
-- and the net: fix (C4-2), registration hygiene and the device cap (C4-3), revocation, the
-- password pre-hijack defence (P4-00), profiles, merge intents and the merge (M1 … M16), the
-- anonymous-cleanup skip, end_share's Phase 4 reasons, the deletion functions and the purges.
begin;
create extension if not exists pgtap with schema extensions;

select plan(123);

-- ---------------------------------------------------------------------------
-- Structure and grants
-- ---------------------------------------------------------------------------
select has_table('app', 'profiles', 'app.profiles exists');
select has_table('app', 'merge_intents', 'app.merge_intents exists');
select has_column('app', 'devices', 'auth_session_id', 'devices are bound to an Auth session (C4-2)');
select has_column('app', 'devices', 'revoked_reason', 'devices record why they were revoked');

select is(
  (select count(*)::int
     from unnest(array[
       'app.register_device(uuid, uuid, uuid, integer, text, text)',
       'app.revoke_device(uuid, uuid, text, uuid)',
       'app.ensure_profile(uuid)',
       'app.mfa_enrolled(uuid)',
       'app.create_merge_intent(uuid, uuid, uuid, uuid, bytea, integer)',
       'app.merge_anonymous_user(uuid, bytea[], uuid, uuid, uuid, integer)',
       'app.request_account_deletion(uuid, interval)',
       'app.cancel_account_deletion(uuid)']) as f(sig)
    where has_function_privilege('app_server', f.sig, 'EXECUTE')),
  8, 'app_server can call the account functions');
select is(
  (select count(*)::int
     from unnest(array['app.delete_due_accounts(integer)', 'app.end_password_sign_in(uuid)']) as f(sig),
          unnest(array['app_server', 'app_janitor', 'app_egress_loader', 'anon', 'authenticated']) as r(role)
    where has_function_privilege(r.role, f.sig, 'EXECUTE')),
  0, 'the deletion job and the password clean-up are granted to nobody');
select ok(has_table_privilege('app_server', 'app.merge_intents', 'SELECT'), 'app_server may read merge intents (timing-safe pre-check)');
select is(
  (select count(*)::int from unnest(array['INSERT', 'UPDATE', 'DELETE']) as p(priv)
    where has_table_privilege('app_server', 'app.merge_intents', p.priv)),
  0, 'app_server cannot write merge intents: only the definer functions do (RISK-024)');
select is(
  (select count(*)::int from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p(priv)
    where has_table_privilege('app_server', 'app.profiles', p.priv)),
  4, 'app_server has DML on profiles');
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relname in ('profiles', 'merge_intents') and not c.relrowsecurity),
  0, 'row level security is on for the new tables');

-- ---------------------------------------------------------------------------
-- Fixtures
-- a1: anonymous (devices) · a2: anonymous, suspended · b1: account (cap, password) · b2: another account
-- a3 → b3: the merge · a4: suspended merge source · a5/a6: cleanup · b4/b5: deletion (b5 suspended)
-- ---------------------------------------------------------------------------
-- Other test data in the local database must not look inactive to the cleanup job below.
update auth.users set created_at = now(), last_sign_in_at = now();

insert into auth.users (id, instance_id, aud, role, email, is_anonymous, encrypted_password, created_at, updated_at)
select id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', email, anon, '', now(), now()
  from (values
    ('a4000000-0000-4000-8000-000000000001', null, true),
    ('a4000000-0000-4000-8000-000000000002', null, true),
    ('a4000000-0000-4000-8000-000000000003', null, true),
    ('a4000000-0000-4000-8000-000000000004', null, true),
    ('a4000000-0000-4000-8000-000000000005', null, true),
    ('a4000000-0000-4000-8000-000000000006', null, true),
    ('b4000000-0000-4000-8000-000000000001', 'b1@example.com', false),
    ('b4000000-0000-4000-8000-000000000002', 'b2@example.com', false),
    ('b4000000-0000-4000-8000-000000000003', 'b3@example.com', false),
    ('b4000000-0000-4000-8000-000000000004', 'b4@example.com', false),
    ('b4000000-0000-4000-8000-000000000005', 'b5@example.com', false)
  ) as u(id, email, anon);

-- Sessions c4…<user><n>: one row per browser sign-in.
insert into auth.sessions (id, user_id, created_at, updated_at)
select id::uuid, user_id::uuid, now(), now()
  from (values
    ('c4000000-0000-4000-8000-0000000000a1', 'a4000000-0000-4000-8000-000000000001'),
    ('c4000000-0000-4000-8000-0000000000a2', 'a4000000-0000-4000-8000-000000000001'),
    ('c4000000-0000-4000-8000-0000000000a9', 'a4000000-0000-4000-8000-000000000002'),
    ('c4000000-0000-4000-8000-0000000000b1', 'b4000000-0000-4000-8000-000000000001'),
    ('c4000000-0000-4000-8000-0000000000b2', 'b4000000-0000-4000-8000-000000000001'),
    ('c4000000-0000-4000-8000-0000000000b3', 'b4000000-0000-4000-8000-000000000001'),
    ('c4000000-0000-4000-8000-0000000000b4', 'b4000000-0000-4000-8000-000000000001'),
    ('c4000000-0000-4000-8000-0000000000b9', 'b4000000-0000-4000-8000-000000000002'),
    ('c4000000-0000-4000-8000-0000000000a3', 'a4000000-0000-4000-8000-000000000003'),
    ('c4000000-0000-4000-8000-0000000000c3', 'b4000000-0000-4000-8000-000000000003'),
    ('c4000000-0000-4000-8000-0000000000c4', 'b4000000-0000-4000-8000-000000000003'),
    ('c4000000-0000-4000-8000-0000000000a4', 'a4000000-0000-4000-8000-000000000004')
  ) as s(id, user_id);

insert into app.user_flags (user_id, suspended_at, reason)
values ('a4000000-0000-4000-8000-000000000002', now(), 'test'),
       ('a4000000-0000-4000-8000-000000000004', now(), 'test'),
       ('b4000000-0000-4000-8000-000000000005', now(), 'test');

insert into app.network_spaces (id, network_key, key_version, family)
values ('e4000000-0000-4000-8000-000000000001', decode(repeat('e4', 32), 'hex'), 1, 4);

create temp table r4 (step text primary key, val jsonb) on commit drop;
create temp table topic4 (label text primary key, allowed boolean) on commit drop;
grant select, insert on r4 to app_server;
grant insert on topic4 to authenticated;
grant app_server to current_user;

-- ---------------------------------------------------------------------------
-- register_device (P4-02, P4-07)
-- ---------------------------------------------------------------------------
set local role app_server;
insert into r4 select 'new', to_jsonb(x) from app.register_device('a4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-0000000000a1', null, 10, 'Blue Fox', 'Mac · Chrome') x;
insert into r4 select 'again', to_jsonb(x) from app.register_device('a4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-0000000000a1', null, 10, 'Red Fox', '') x;
reset role;
select is((select val ->> 'outcome' from r4 where step = 'new'), 'created', 'a first registration creates the device');
select is((select auth_session_id from app.devices where id = (select (val ->> 'device_id')::uuid from r4 where step = 'new')),
  'c4000000-0000-4000-8000-0000000000a1'::uuid, 'the new device is bound to the caller''s session');
select is((select val ->> 'outcome' from r4 where step = 'again'), 'refreshed', 'the same session gets its device back');
select is((select val ->> 'device_id' from r4 where step = 'again'), (select val ->> 'device_id' from r4 where step = 'new'),
  'one session, one device: no second row for the same session');

-- The device moves to a new session of the same user (an upgrade issues one): rebound, presence ended.
insert into app.network_presence (space_id, device_id, user_id, present_until)
values ('e4000000-0000-4000-8000-000000000001', (select (val ->> 'device_id')::uuid from r4 where step = 'new'),
        'a4000000-0000-4000-8000-000000000001', now() + interval '10 minutes');
set local role app_server;
insert into r4 select 'rebind', to_jsonb(x) from app.register_device('a4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-0000000000a2',
  (select (val ->> 'device_id')::uuid from r4 where step = 'new'), 10, 'Blue Fox', '') x;
reset role;
select is((select val ->> 'outcome' from r4 where step = 'rebind'), 'bound', 'an own device named by a new session is rebound to it');
select is((select auth_session_id from app.devices where id = (select (val ->> 'device_id')::uuid from r4 where step = 'new')),
  'c4000000-0000-4000-8000-0000000000a2'::uuid, 'the binding follows the session');
select ok((select present_until <= now() from app.network_presence where device_id = (select (val ->> 'device_id')::uuid from r4 where step = 'new')),
  'rebinding ends the device''s presence: the new session must observe from the network itself (C4-2)');

set local role app_server;
insert into r4 select 'gone', to_jsonb(x) from app.register_device('a4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-0000000000ff', null, 10, 'Blue Fox', '') x;
insert into r4 select 'suspended', to_jsonb(x) from app.register_device('a4000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-0000000000a9', null, 10, 'Blue Fox', '') x;
insert into r4 select 'foreign', to_jsonb(x) from app.register_device('b4000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-0000000000b9',
  (select (val ->> 'device_id')::uuid from r4 where step = 'new'), 10, 'Grey Owl', '') x;
reset role;
select is((select val ->> 'outcome' from r4 where step = 'gone'), 'session_ended', 'a token whose session no longer exists cannot register');
select is((select val ->> 'outcome' from r4 where step = 'suspended'), 'suspended', 'a suspended user cannot register a device (C4-3)');
select is((select count(*)::int from app.devices where user_id = 'a4000000-0000-4000-8000-000000000002'), 0, 'and no row is created for them');
select is((select val ->> 'outcome' from r4 where step = 'foreign'), 'created', 'another user''s device ID never binds: a new device is created');
select is((select user_id from app.devices where id = (select (val ->> 'device_id')::uuid from r4 where step = 'new')),
  'a4000000-0000-4000-8000-000000000001'::uuid, 'the named device still belongs to its owner');

-- The cap applies to accounts (D4-5), never to anonymous users (one browser each).
set local role app_server;
insert into r4 select 'cap1', to_jsonb(x) from app.register_device('b4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-0000000000b1', null, 2, 'Cap One', '') x;
insert into r4 select 'cap2', to_jsonb(x) from app.register_device('b4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-0000000000b2', null, 2, 'Cap Two', '') x;
insert into r4 select 'cap3', to_jsonb(x) from app.register_device('b4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-0000000000b3', null, 2, 'Cap Three', '') x;
insert into r4 select 'anon-cap', to_jsonb(x) from app.register_device('a4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-0000000000a1', null, 1, 'Over Cap', '') x;
reset role;
select is((select val ->> 'outcome' from r4 where step = 'cap3'), 'limit', 'an account at the device cap cannot add a device (409 DEVICE_LIMIT)');
select is((select (val ->> 'active_devices')::int from r4 where step = 'cap3'), 2, 'the refusal reports the active count');
select is((select count(*)::int from app.devices where user_id = 'b4000000-0000-4000-8000-000000000001'), 2, 'nothing was created over the cap');
select is((select val ->> 'outcome' from r4 where step = 'anon-cap'), 'created', 'anonymous users have no device cap');

-- ---------------------------------------------------------------------------
-- revoke_device (P4-07)
-- ---------------------------------------------------------------------------
insert into app.network_presence (space_id, device_id, user_id, present_until)
values ('e4000000-0000-4000-8000-000000000001', (select (val ->> 'device_id')::uuid from r4 where step = 'cap2'),
        'b4000000-0000-4000-8000-000000000001', now() + interval '10 minutes');
set local role app_server;
insert into r4 select 'revoke-other', to_jsonb(app.revoke_device('b4000000-0000-4000-8000-000000000002',
  (select (val ->> 'device_id')::uuid from r4 where step = 'cap2'), 'user', null));
insert into r4 select 'revoke', to_jsonb(app.revoke_device('b4000000-0000-4000-8000-000000000001',
  (select (val ->> 'device_id')::uuid from r4 where step = 'cap2'), 'user', (select (val ->> 'device_id')::uuid from r4 where step = 'cap1')));
insert into r4 select 'revoke-again', to_jsonb(app.revoke_device('b4000000-0000-4000-8000-000000000001',
  (select (val ->> 'device_id')::uuid from r4 where step = 'cap2'), 'user', null));
reset role;
select is((select val from r4 where step = 'revoke-other'), 'false'::jsonb, 'nobody can revoke another user''s device');
select is((select val from r4 where step = 'revoke'), 'true'::jsonb, 'an own device is revoked');
select is((select val from r4 where step = 'revoke-again'), 'false'::jsonb, 'revoking twice reports nothing to do');
select is(
  (select row(revoked_reason, revoked_by_device_id)::text from app.devices where id = (select (val ->> 'device_id')::uuid from r4 where step = 'cap2')),
  row('user', (select (val ->> 'device_id')::uuid from r4 where step = 'cap1'))::text, 'the revocation records why and by which device');
select is((select count(*)::int from auth.sessions where id = 'c4000000-0000-4000-8000-0000000000b2'), 0,
  'revoking deletes the device''s Auth session, so its refresh token dies (C4-3)');
select ok((select present_until <= now() from app.network_presence where device_id = (select (val ->> 'device_id')::uuid from r4 where step = 'cap2')),
  'revoking ends the device''s presence');
select is((select count(*)::int from app.audit_events where action = 'device.revoked'
             and target_id = (select val ->> 'device_id' from r4 where step = 'cap2')), 1, 'the revocation is audited');

-- The revoked device's access token stays valid until it expires: registration refuses it.
insert into auth.sessions (id, user_id, created_at, updated_at)
values ('c4000000-0000-4000-8000-0000000000b2', 'b4000000-0000-4000-8000-000000000001', now(), now());
set local role app_server;
insert into r4 select 'revoked-session', to_jsonb(x) from app.register_device('b4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-0000000000b2', null, 10, 'Again', '') x;
insert into r4 select 'revoked-header', to_jsonb(x) from app.register_device('b4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-0000000000b3',
  (select (val ->> 'device_id')::uuid from r4 where step = 'cap2'), 10, 'Again', '') x;
reset role;
select is((select val ->> 'outcome' from r4 where step = 'revoked-session'), 'revoked', 'a revoked device''s session cannot register a new device');
select is((select val ->> 'outcome' from r4 where step = 'revoked-header'), 'revoked', 'a revoked device ID is never re-created (401 DEVICE_REVOKED)');
delete from auth.sessions where id = 'c4000000-0000-4000-8000-0000000000b2';

-- ---------------------------------------------------------------------------
-- No passwords (D4-2, P4-00): a password set on an account, for example by someone who signed the
-- address up before its owner, is removed at the owner's next registration, with its sessions.
-- ---------------------------------------------------------------------------
update auth.users set encrypted_password = '$2a$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyzABCDEF'
 where id = 'b4000000-0000-4000-8000-000000000001';
insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method)
values (gen_random_uuid(), 'c4000000-0000-4000-8000-0000000000b4', now(), now(), 'password'),
       (gen_random_uuid(), 'c4000000-0000-4000-8000-0000000000b1', now(), now(), 'otp');
set local role app_server;
insert into r4 select 'clean', to_jsonb(x) from app.register_device('b4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-0000000000b1', null, 10, 'Cap One', '') x;
reset role;
select is((select encrypted_password from auth.users where id = 'b4000000-0000-4000-8000-000000000001'), '',
  'the account''s password is removed');
select is((select count(*)::int from auth.sessions where id = 'c4000000-0000-4000-8000-0000000000b4'), 0, 'its password session is ended');
select is((select count(*)::int from auth.sessions where id = 'c4000000-0000-4000-8000-0000000000b1'), 1, 'the owner''s code session is kept');
select is((select count(*)::int from app.audit_events where action = 'account.password_removed'
             and target_id = 'b4000000-0000-4000-8000-000000000001'), 1, 'the removal is audited (a sign of a pre-hijack attempt)');

-- ---------------------------------------------------------------------------
-- Realtime topics (C4-2): net: needs presence of the device bound to the caller's session
-- ---------------------------------------------------------------------------
-- b1: device cap1 (session b1) present on the space; device cap3? none. Session b3 has no device.
insert into app.network_presence (space_id, device_id, user_id, present_until)
values ('e4000000-0000-4000-8000-000000000001', (select (val ->> 'device_id')::uuid from r4 where step = 'cap1'),
        'b4000000-0000-4000-8000-000000000001', now() + interval '10 minutes');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b4000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"c4000000-0000-4000-8000-0000000000b1","amr":[{"method":"otp","timestamp":1}]}', true);
insert into topic4 values
  ('bound present', app_realtime.can_access_topic('net:e4000000-0000-4000-8000-000000000001')),
  ('own user', app_realtime.can_access_topic('user:b4000000-0000-4000-8000-000000000001'));
select set_config('request.jwt.claims', '{"sub":"b4000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"c4000000-0000-4000-8000-0000000000b3"}', true);
insert into topic4 values ('other session', app_realtime.can_access_topic('net:e4000000-0000-4000-8000-000000000001'));
select set_config('request.jwt.claims', '{"sub":"b4000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
insert into topic4 values ('no session claim', app_realtime.can_access_topic('net:e4000000-0000-4000-8000-000000000001'));
select set_config('request.jwt.claims', '{"sub":"b4000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"c4000000-0000-4000-8000-0000000000b2"}', true);
insert into topic4 values
  ('revoked net', app_realtime.can_access_topic('net:e4000000-0000-4000-8000-000000000001')),
  ('revoked user', app_realtime.can_access_topic('user:b4000000-0000-4000-8000-000000000001'));
select set_config('request.jwt.claims', '{"sub":"b4000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"c4000000-0000-4000-8000-0000000000b1","amr":[{"method":"password","timestamp":1}]}', true);
insert into topic4 values
  ('password net', app_realtime.can_access_topic('net:e4000000-0000-4000-8000-000000000001')),
  ('password user', app_realtime.can_access_topic('user:b4000000-0000-4000-8000-000000000001'));
-- Another user's session bound to b1's present device would be a forged binding; the user must match too.
select set_config('request.jwt.claims', '{"sub":"b4000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"c4000000-0000-4000-8000-0000000000b1"}', true);
insert into topic4 values ('other user same session id', app_realtime.can_access_topic('net:e4000000-0000-4000-8000-000000000001'));
reset role;
insert into app.user_flags (user_id, suspended_at, reason) values ('b4000000-0000-4000-8000-000000000001', now(), 'test');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b4000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"c4000000-0000-4000-8000-0000000000b1"}', true);
insert into topic4 values ('suspended net', app_realtime.can_access_topic('net:e4000000-0000-4000-8000-000000000001'));
reset role;
delete from app.user_flags where user_id = 'b4000000-0000-4000-8000-000000000001';

select is((select allowed from topic4 where label = 'bound present'), true, 'the device bound to this session is present: net: is open');
select is((select allowed from topic4 where label = 'own user'), true, 'user:{id} stays open to the user''s sessions');
select is((select allowed from topic4 where label = 'other session'), false,
  'another session of the same account cannot join net: on the strength of the first device''s presence (C4-2, T4-A10)');
select is((select allowed from topic4 where label = 'no session claim'), false, 'a token without a session_id gets no net: access');
select is((select allowed from topic4 where label = 'revoked net'), false, 'a revoked device''s token cannot join net:');
select is((select allowed from topic4 where label = 'revoked user'), false, 'a revoked device''s token cannot (re)join user: either');
select is((select allowed from topic4 where label = 'password net'), false, 'password sessions are refused on net: (D4-2)');
select is((select allowed from topic4 where label = 'password user'), false, 'password sessions are refused on user: (D4-2)');
select is((select allowed from topic4 where label = 'other user same session id'), false, 'the session''s device must belong to the caller');
select is((select allowed from topic4 where label = 'suspended net'), false, 'a suspended user cannot join net:');

-- ---------------------------------------------------------------------------
-- Profiles and MFA (P4-03, P4-05)
-- ---------------------------------------------------------------------------
set local role app_server;
insert into r4 select 'profile', to_jsonb(app.ensure_profile('b4000000-0000-4000-8000-000000000002'));
insert into r4 select 'profile-again', to_jsonb(app.ensure_profile('b4000000-0000-4000-8000-000000000002'));
insert into r4 select 'profile-anon', to_jsonb(app.ensure_profile('a4000000-0000-4000-8000-000000000001'));
reset role;
select is((select val ->> 'user_id' from r4 where step = 'profile'), 'b4000000-0000-4000-8000-000000000002', 'an account gets a profile');
select is((select count(*)::int from app.profiles where user_id = 'b4000000-0000-4000-8000-000000000002'), 1, 'ensure_profile is idempotent');
select is((select val ->> 'user_id' from r4 where step = 'profile-anon'), null, 'anonymous users have no profile');
select throws_ok(
  $q$insert into app.profiles (user_id, display_name) values ('b4000000-0000-4000-8000-000000000003', repeat('x', 61))$q$,
  '23514', null, 'display names are at most 60 characters');

insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
values (gen_random_uuid(), 'b4000000-0000-4000-8000-000000000002', 'totp', 'verified', now(), now()),
       (gen_random_uuid(), 'b4000000-0000-4000-8000-000000000003', 'totp', 'unverified', now(), now());
set local role app_server;
insert into r4 select 'mfa-yes', to_jsonb(app.mfa_enrolled('b4000000-0000-4000-8000-000000000002'));
insert into r4 select 'mfa-unverified', to_jsonb(app.mfa_enrolled('b4000000-0000-4000-8000-000000000003'));
reset role;
select is((select val from r4 where step = 'mfa-yes'), 'true'::jsonb, 'a verified TOTP factor counts as enrolled');
select is((select val from r4 where step = 'mfa-unverified'), 'false'::jsonb, 'an unverified factor does not');

-- ---------------------------------------------------------------------------
-- Merge intents (P4-06, §17.5.4)
-- ---------------------------------------------------------------------------
insert into app.devices (id, user_id, label, auth_session_id) values
  ('d4000000-0000-4000-8000-0000000000a3', 'a4000000-0000-4000-8000-000000000003', 'Merge Me', 'c4000000-0000-4000-8000-0000000000a3'),
  ('d4000000-0000-4000-8000-0000000000a4', 'a4000000-0000-4000-8000-000000000004', 'Suspended', 'c4000000-0000-4000-8000-0000000000a4'),
  ('d4000000-0000-4000-8000-0000000000c1', 'b4000000-0000-4000-8000-000000000003', 'Target One', 'c4000000-0000-4000-8000-0000000000c4'),
  ('d4000000-0000-4000-8000-0000000000c2', 'b4000000-0000-4000-8000-000000000003', 'Target Here', 'c4000000-0000-4000-8000-0000000000c3');
set local role app_server;
insert into r4 select 'intent-old', to_jsonb(x) from app.create_merge_intent('a4000000-0000-4000-8000-000000000003', 'c4000000-0000-4000-8000-0000000000a3',
  'd4000000-0000-4000-8000-0000000000a3', 'f4000000-0000-4000-8000-000000000001', decode(repeat('01', 32), 'hex'), 1) x;
insert into r4 select 'intent', to_jsonb(x) from app.create_merge_intent('a4000000-0000-4000-8000-000000000003', 'c4000000-0000-4000-8000-0000000000a3',
  'd4000000-0000-4000-8000-0000000000a3', 'f4000000-0000-4000-8000-000000000003', decode(repeat('a3', 32), 'hex'), 1) x;
insert into r4 select 'intent-account', to_jsonb(x) from app.create_merge_intent('b4000000-0000-4000-8000-000000000003', 'c4000000-0000-4000-8000-0000000000c3',
  'd4000000-0000-4000-8000-0000000000c2', 'f4000000-0000-4000-8000-0000000000b3', decode(repeat('b3', 32), 'hex'), 1) x;
insert into r4 select 'intent-suspended', to_jsonb(x) from app.create_merge_intent('a4000000-0000-4000-8000-000000000004', 'c4000000-0000-4000-8000-0000000000a4',
  'd4000000-0000-4000-8000-0000000000a4', 'f4000000-0000-4000-8000-0000000000a4', decode(repeat('a4', 32), 'hex'), 1) x;
insert into r4 select 'intent-wrong-session', to_jsonb(x) from app.create_merge_intent('a4000000-0000-4000-8000-000000000003', 'c4000000-0000-4000-8000-0000000000a1',
  'd4000000-0000-4000-8000-0000000000a3', 'f4000000-0000-4000-8000-0000000000a9', decode(repeat('a9', 32), 'hex'), 1) x;
reset role;
select is((select val ->> 'outcome' from r4 where step = 'intent'), 'created', 'an anonymous device creates a merge intent');
select is((select status from app.merge_intents where id = 'f4000000-0000-4000-8000-000000000001'), 'revoked', 'a new intent revokes the previous one');
select is((select count(*)::int from app.merge_intents where anon_user_id = 'a4000000-0000-4000-8000-000000000003' and status = 'open'), 1,
  'one open intent per anonymous user');
select ok((select expires_at between now() + interval '23 hours 59 minutes' and now() + interval '24 hours' from app.merge_intents
            where id = 'f4000000-0000-4000-8000-000000000003'), 'intents last 24 hours');
select is((select val ->> 'outcome' from r4 where step = 'intent-account'), 'not_anonymous', 'an account cannot create an intent (403 NOT_ANONYMOUS)');
select is((select val ->> 'outcome' from r4 where step = 'intent-suspended'), 'suspended', 'a suspended user cannot create an intent');
select is((select val ->> 'outcome' from r4 where step = 'intent-wrong-session'), 'device', 'the device must be bound to the caller''s session');
-- The suspended source still gets an intent row for the redemption test (as if it was created before the suspension).
insert into app.merge_intents (id, anon_user_id, anon_device_id, secret_hmac, pepper_version, expires_at)
values ('f4000000-0000-4000-8000-0000000000a4', 'a4000000-0000-4000-8000-000000000004', 'd4000000-0000-4000-8000-0000000000a4',
        decode(repeat('a4', 32), 'hex'), 1, now() + interval '1 hour');

-- ---------------------------------------------------------------------------
-- What a3 owns before the merge (every column of the coverage list)
-- ---------------------------------------------------------------------------
insert into app.network_presence (space_id, device_id, user_id, present_until)
values ('e4000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-0000000000a3', 'a4000000-0000-4000-8000-000000000003', now() + interval '10 minutes');
insert into app.shares (id, scope, network_space_id, kind, created_by_user_id, created_by_device_id, billing_subject_type, billing_subject_id,
                        status, retention_class, expires_at, file_count, total_bytes, entitlement_snapshot)
values
  ('94000000-0000-4000-8000-000000000001', 'network', 'e4000000-0000-4000-8000-000000000001', 'files', 'a4000000-0000-4000-8000-000000000003',
   'd4000000-0000-4000-8000-0000000000a3', 'user', 'a4000000-0000-4000-8000-000000000003', 'pending_upload', 'd7', now() + interval '1 day', 2, 150, '{}'),
  ('94000000-0000-4000-8000-000000000002', 'link_only', null, 'text', 'a4000000-0000-4000-8000-000000000003',
   'd4000000-0000-4000-8000-0000000000a3', 'user', 'a4000000-0000-4000-8000-000000000003', 'active', 'd7', now() + interval '1 day', 0, 0, '{}');
-- Someone else's burn share that a3 claimed (DEC-015).
insert into app.shares (id, scope, network_space_id, kind, created_by_user_id, billing_subject_type, billing_subject_id, status, retention_class,
                        expires_at, burn_after_download, entitlement_snapshot, claimed_at, claimed_by_user_id, claimed_device_id, claim_grace_until)
values ('94000000-0000-4000-8000-000000000003', 'network', 'e4000000-0000-4000-8000-000000000001', 'text', 'b4000000-0000-4000-8000-000000000002',
        'user', 'b4000000-0000-4000-8000-000000000002', 'claimed', 'd7', now() + interval '1 day', true, '{}',
        now(), 'a4000000-0000-4000-8000-000000000003', 'd4000000-0000-4000-8000-0000000000a3', now() + interval '15 minutes');
insert into app.files (id, share_id, object_key, original_name, declared_mime, stored_content_type, declared_size_bytes, size_bytes,
                       upload_status, upload_expires_at)
values ('84000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', 'd7/2026/10/16/84000000-0000-4000-8000-000000000001',
        'a.bin', 'application/octet-stream', 'application/octet-stream', 100, 100, 'verified', now() + interval '2 hours'),
       ('84000000-0000-4000-8000-000000000002', '94000000-0000-4000-8000-000000000001', 'd7/2026/10/16/84000000-0000-4000-8000-000000000002',
        'b.bin', 'application/octet-stream', 'application/octet-stream', 50, null, 'pending', now() + interval '2 hours');
insert into app.storage_usage (subject_type, subject_id, bytes_committed, bytes_reserved, files_committed)
values ('user', 'a4000000-0000-4000-8000-000000000003', 100, 50, 1),
       ('user', 'b4000000-0000-4000-8000-000000000003', 10, 0, 1);
insert into app.storage_reservations (id, subject_type, subject_id, file_id, bytes, expires_at)
values ('74000000-0000-4000-8000-000000000001', 'user', 'a4000000-0000-4000-8000-000000000003', '84000000-0000-4000-8000-000000000002', 50, now() + interval '3 hours');
insert into app.share_links (id, share_id, secret_hmac, pepper_version, created_by_user_id, expires_at, entitlement_snapshot)
values ('MergeLinkAAAAAA1', '94000000-0000-4000-8000-000000000002', decode(repeat('11', 32), 'hex'), 1, 'a4000000-0000-4000-8000-000000000003', now() + interval '1 hour', '{}'),
       ('MergeLinkAAAAAA2', '94000000-0000-4000-8000-000000000002', decode(repeat('12', 32), 'hex'), 1, 'a4000000-0000-4000-8000-000000000003', now() + interval '1 hour', '{}');
update app.share_links set revoked_at = now(), revoke_reason = 'creator', revoked_by_user_id = 'a4000000-0000-4000-8000-000000000003'
 where id = 'MergeLinkAAAAAA2';
insert into app.downloads (share_id, actor_kind, user_id, device_id, event, retention_until)
values ('94000000-0000-4000-8000-000000000003', 'network_device', 'a4000000-0000-4000-8000-000000000003', 'd4000000-0000-4000-8000-0000000000a3',
        'burn_claimed', now() + interval '30 days');
insert into app.abuse_reports (share_id, category, reporter_kind, reporter_user_id)
values ('94000000-0000-4000-8000-000000000003', 'spam', 'device', 'a4000000-0000-4000-8000-000000000003');
insert into app.audit_events (actor_kind, actor_user_id, action) values ('device', 'a4000000-0000-4000-8000-000000000003', 'share.created');
insert into app.user_flags (user_id, upload_restricted) values ('a4000000-0000-4000-8000-000000000003', true);
insert into app.idempotency_keys (user_id, endpoint, key_hash, response)
values ('a4000000-0000-4000-8000-000000000003', 'POST /shares', decode(repeat('aa', 32), 'hex'), '{}');
insert into app.rate_counters (key, window_start, value, expires_at)
values ('upload_kib:user:a4000000-0000-4000-8000-000000000003', date_bin('1 day', now(), timestamptz '2000-01-01'), 7,
        date_bin('1 day', now(), timestamptz '2000-01-01') + interval '1 day'),
       ('upload_kib:user:b4000000-0000-4000-8000-000000000003', date_bin('1 day', now(), timestamptz '2000-01-01'), 3,
        date_bin('1 day', now(), timestamptz '2000-01-01') + interval '1 day');

-- Everything a merge may touch, as one value: compared after each refused or failed attempt.
create function pg_temp.merge_state() returns jsonb language sql as $$
  select jsonb_build_object(
    'source', (select count(*) from auth.users where id = 'a4000000-0000-4000-8000-000000000003'),
    'intent', (select status from app.merge_intents where id = 'f4000000-0000-4000-8000-000000000003'),
    'shares', (select jsonb_agg(jsonb_build_array(id, created_by_user_id, billing_subject_id, claimed_by_user_id) order by id) from app.shares
                where id::text like '94000000%'),
    'links', (select jsonb_agg(jsonb_build_array(id, created_by_user_id, revoked_by_user_id) order by id) from app.share_links where id like 'MergeLink%'),
    'devices', (select jsonb_agg(jsonb_build_array(id, user_id, auth_session_id, revoked_at is null) order by id) from app.devices
                 where id::text like 'd4000000%'),
    'presence', (select jsonb_agg(user_id) from app.network_presence where device_id = 'd4000000-0000-4000-8000-0000000000a3'),
    'downloads', (select jsonb_agg(user_id) from app.downloads where share_id = '94000000-0000-4000-8000-000000000003'),
    'reports', (select jsonb_agg(reporter_user_id) from app.abuse_reports where share_id = '94000000-0000-4000-8000-000000000003'),
    'ledger', (select jsonb_agg(jsonb_build_array(subject_id, bytes_committed, bytes_reserved, files_committed) order by subject_id)
                 from app.storage_usage where subject_id in ('a4000000-0000-4000-8000-000000000003', 'b4000000-0000-4000-8000-000000000003')),
    'reservation', (select subject_id from app.storage_reservations where id = '74000000-0000-4000-8000-000000000001'),
    'counters', (select jsonb_agg(jsonb_build_array(key, value) order by key) from app.rate_counters where key like 'upload_kib:user:%4000000-0000-4000-8000-000000000003'),
    'flags', (select jsonb_agg(jsonb_build_array(user_id, upload_restricted) order by user_id) from app.user_flags
               where user_id in ('a4000000-0000-4000-8000-000000000003', 'b4000000-0000-4000-8000-000000000003')),
    'merged', (select count(*) from app.audit_events where action = 'account.merged'));
$$;
insert into r4 select 'before', pg_temp.merge_state();

-- ---------------------------------------------------------------------------
-- Refusals: nothing changes (M1, M2, M11, M12, M13)
-- ---------------------------------------------------------------------------
set local role app_server;
insert into r4 select 'm-wrong-secret', app.merge_anonymous_user('f4000000-0000-4000-8000-000000000003', array[decode(repeat('00', 32), 'hex')],
  'b4000000-0000-4000-8000-000000000003', 'c4000000-0000-4000-8000-0000000000c3', 'd4000000-0000-4000-8000-0000000000a3', 10);
insert into r4 select 'm-wrong-device', app.merge_anonymous_user('f4000000-0000-4000-8000-000000000003', array[decode(repeat('a3', 32), 'hex')],
  'b4000000-0000-4000-8000-000000000003', 'c4000000-0000-4000-8000-0000000000c3', 'd4000000-0000-4000-8000-0000000000c1', 10);
insert into r4 select 'm-unknown', app.merge_anonymous_user('f4000000-0000-4000-8000-0000000000ff', array[decode(repeat('a3', 32), 'hex')],
  'b4000000-0000-4000-8000-000000000003', 'c4000000-0000-4000-8000-0000000000c3', 'd4000000-0000-4000-8000-0000000000a3', 10);
insert into r4 select 'm-revoked-intent', app.merge_anonymous_user('f4000000-0000-4000-8000-000000000001', array[decode(repeat('01', 32), 'hex')],
  'b4000000-0000-4000-8000-000000000003', 'c4000000-0000-4000-8000-0000000000c3', 'd4000000-0000-4000-8000-0000000000a3', 10);
insert into r4 select 'm-anon-target', app.merge_anonymous_user('f4000000-0000-4000-8000-000000000003', array[decode(repeat('a3', 32), 'hex')],
  'a4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-0000000000a1', 'd4000000-0000-4000-8000-0000000000a3', 10);
insert into r4 select 'm-foreign-session', app.merge_anonymous_user('f4000000-0000-4000-8000-000000000003', array[decode(repeat('a3', 32), 'hex')],
  'b4000000-0000-4000-8000-000000000003', 'c4000000-0000-4000-8000-0000000000b1', 'd4000000-0000-4000-8000-0000000000a3', 10);
insert into r4 select 'm-suspended', app.merge_anonymous_user('f4000000-0000-4000-8000-0000000000a4', array[decode(repeat('a4', 32), 'hex')],
  'b4000000-0000-4000-8000-000000000003', 'c4000000-0000-4000-8000-0000000000c3', 'd4000000-0000-4000-8000-0000000000a4', 10);
-- Target devices: c1 (another browser) and c2 (bound to the merging browser's new session, replaced
-- by the merging device and not counted). Cap 1: c1 + the incoming device = 2 > 1.
insert into r4 select 'm-cap', app.merge_anonymous_user('f4000000-0000-4000-8000-000000000003', array[decode(repeat('a3', 32), 'hex')],
  'b4000000-0000-4000-8000-000000000003', 'c4000000-0000-4000-8000-0000000000c3', 'd4000000-0000-4000-8000-0000000000a3', 1);
reset role;
select is((select val ->> 'outcome' from r4 where step = 'm-wrong-secret'), 'unavailable', 'a wrong secret is refused (M2: 404 MERGE_UNAVAILABLE)');
select is((select val ->> 'outcome' from r4 where step = 'm-wrong-device'), 'unavailable',
  'the redemption must come from the intent''s device (M1: a stolen secret alone is not enough)');
select is((select val ->> 'outcome' from r4 where step = 'm-unknown'), 'unavailable', 'an unknown intent looks the same');
select is((select val ->> 'outcome' from r4 where step = 'm-revoked-intent'), 'unavailable', 'a revoked intent looks the same');
select is((select val ->> 'outcome' from r4 where step = 'm-anon-target'), 'invalid', 'the target must be a permanent account');
select is((select val ->> 'outcome' from r4 where step = 'm-foreign-session'), 'invalid', 'the target session must belong to the target (M13)');
select is((select val ->> 'outcome' from r4 where step = 'm-suspended'), 'suspended', 'a suspended source is refused (M11, D4-4)');
select is((select val ->> 'outcome' from r4 where step = 'm-cap'), 'device_limit', 'the device cap applies to merges (M12)');
select is(pg_temp.merge_state(), (select val from r4 where step = 'before'), 'no refused merge changed anything; the intent stays open');

-- ---------------------------------------------------------------------------
-- Fault injection (M5): a failure at any step leaves no partial state
-- ---------------------------------------------------------------------------
create function app.test_fault() returns trigger language plpgsql as $$
begin
  if current_setting('test.fault', true) = tg_table_schema || '.' || tg_table_name then
    raise exception 'injected fault in %', tg_table_name using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end
$$;
do $$
declare
  t text;
begin
  foreach t in array array['app.shares', 'app.share_links', 'app.devices', 'app.network_presence', 'app.downloads', 'app.abuse_reports',
                           'app.user_flags', 'app.storage_usage', 'app.storage_reservations', 'app.rate_counters', 'app.merge_intents',
                           'app.audit_events'] loop
    execute format('create trigger test_fault before insert or update or delete on %s for each row execute function app.test_fault()', t);
  end loop;
end
$$;
grant execute on function app.test_fault() to app_server;

create temp table faults (tbl text primary key, raised boolean, unchanged boolean) on commit drop;
do $$
declare
  t text;
  v_raised boolean;
begin
  foreach t in array array['app.shares', 'app.share_links', 'app.devices', 'app.network_presence', 'app.downloads', 'app.abuse_reports',
                           'app.user_flags', 'app.storage_usage', 'app.storage_reservations', 'app.rate_counters', 'app.merge_intents',
                           'app.audit_events'] loop
    perform set_config('test.fault', t, true);
    begin
      perform app.merge_anonymous_user('f4000000-0000-4000-8000-000000000003', array[decode(repeat('a3', 32), 'hex')],
        'b4000000-0000-4000-8000-000000000003', 'c4000000-0000-4000-8000-0000000000c3', 'd4000000-0000-4000-8000-0000000000a3', 10);
      v_raised := false;
    exception when sqlstate 'P0001' then
      v_raised := true;
    end;
    perform set_config('test.fault', '', true);
    insert into faults values (t, v_raised, pg_temp.merge_state() = (select val from r4 where step = 'before'));
  end loop;
end
$$;
select is((select count(*)::int from faults where raised), 12, 'the merge writes to every listed table (each injected fault fired)');
select is((select array_agg(tbl order by tbl) from faults where not unchanged), null,
  'a failure at any step rolls the whole merge back: ownership, ledger, counters, flags, the user and the intent (M5)');

do $$
declare
  t text;
begin
  foreach t in array array['app.shares', 'app.share_links', 'app.devices', 'app.network_presence', 'app.downloads', 'app.abuse_reports',
                           'app.user_flags', 'app.storage_usage', 'app.storage_reservations', 'app.rate_counters', 'app.merge_intents',
                           'app.audit_events'] loop
    execute format('drop trigger test_fault on %s', t);
  end loop;
end
$$;
drop function app.test_fault();

-- A source that became an account itself after making its intent (it signed up in another tab):
-- its data is its own now, and it must never be merged away or deleted.
insert into auth.users (id, instance_id, aud, role, is_anonymous, encrypted_password, created_at, updated_at)
values ('a4000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', true, '', now(), now());
insert into auth.sessions (id, user_id, created_at, updated_at) values ('c4000000-0000-4000-8000-0000000000a7', 'a4000000-0000-4000-8000-000000000007', now(), now());
insert into app.devices (id, user_id, label, auth_session_id)
values ('d4000000-0000-4000-8000-0000000000a7', 'a4000000-0000-4000-8000-000000000007', 'Upgraded', 'c4000000-0000-4000-8000-0000000000a7');
insert into app.merge_intents (id, anon_user_id, anon_device_id, secret_hmac, pepper_version, expires_at)
values ('f4000000-0000-4000-8000-0000000000a7', 'a4000000-0000-4000-8000-000000000007', 'd4000000-0000-4000-8000-0000000000a7',
        decode(repeat('a7', 32), 'hex'), 1, now() + interval '1 hour');
update auth.users set is_anonymous = false, email = 'a7@example.com' where id = 'a4000000-0000-4000-8000-000000000007';
set local role app_server;
insert into r4 select 'm-source-upgraded', app.merge_anonymous_user('f4000000-0000-4000-8000-0000000000a7', array[decode(repeat('a7', 32), 'hex')],
  'b4000000-0000-4000-8000-000000000003', 'c4000000-0000-4000-8000-0000000000c3', 'd4000000-0000-4000-8000-0000000000a7', 10);
reset role;
select is((select val ->> 'outcome' from r4 where step = 'm-source-upgraded'), 'invalid', 'a source that became an account itself is never merged');
select is((select row(u.is_anonymous, d.user_id)::text from auth.users u join app.devices d on d.user_id = u.id
             where u.id = 'a4000000-0000-4000-8000-000000000007'),
  row(false, 'a4000000-0000-4000-8000-000000000007'::uuid)::text, 'it keeps its device and is not deleted');

-- ---------------------------------------------------------------------------
-- The merge (T-053.3)
-- ---------------------------------------------------------------------------
set local role app_server;
insert into r4 select 'merged', app.merge_anonymous_user('f4000000-0000-4000-8000-000000000003', array[decode(repeat('ff', 32), 'hex'), decode(repeat('a3', 32), 'hex')],
  'b4000000-0000-4000-8000-000000000003', 'c4000000-0000-4000-8000-0000000000c3', 'd4000000-0000-4000-8000-0000000000a3', 10);
reset role;
select is((select val ->> 'outcome' from r4 where step = 'merged'), 'merged', 'the merge succeeds with the secret under any configured pepper');
select is((select val - 'outcome' from r4 where step = 'merged'), '{"shares": 2, "links": 2, "devices": 1, "memberships": 0, "bytes": 100}'::jsonb,
  'the result counts what moved');
select is((select count(*)::int from app.shares where created_by_user_id = 'a4000000-0000-4000-8000-000000000003' or billing_subject_id = 'a4000000-0000-4000-8000-000000000003'
             or claimed_by_user_id = 'a4000000-0000-4000-8000-000000000003'), 0, 'no share references the anonymous user any more');
select is((select array_agg(created_by_user_id::text || '/' || billing_subject_id::text order by id) from app.shares where id::text like '94000000%' and id <> '94000000-0000-4000-8000-000000000003'),
  array['b4000000-0000-4000-8000-000000000003/b4000000-0000-4000-8000-000000000003', 'b4000000-0000-4000-8000-000000000003/b4000000-0000-4000-8000-000000000003'],
  'the shares belong to the account, billed to it');
select is((select row(claimed_by_user_id, claimed_device_id)::text from app.shares where id = '94000000-0000-4000-8000-000000000003'),
  row('b4000000-0000-4000-8000-000000000003'::uuid, 'd4000000-0000-4000-8000-0000000000a3'::uuid)::text, 'a burn claim moves with its device (M15)');
select is((select array_agg(coalesce(created_by_user_id::text, '-') || '/' || coalesce(revoked_by_user_id::text, '-') order by id) from app.share_links where id like 'MergeLink%'),
  array['b4000000-0000-4000-8000-000000000003/-', 'b4000000-0000-4000-8000-000000000003/b4000000-0000-4000-8000-000000000003'],
  'links (and who revoked them) move to the account');
select is((select row(user_id, auth_session_id, revoked_at is null)::text from app.devices where id = 'd4000000-0000-4000-8000-0000000000a3'),
  row('b4000000-0000-4000-8000-000000000003'::uuid, 'c4000000-0000-4000-8000-0000000000c3'::uuid, true)::text,
  'the merging device moves and is bound to the account session in this browser');
select is((select revoked_reason from app.devices where id = 'd4000000-0000-4000-8000-0000000000c2'), 'merge',
  'a device the new session already had is replaced by the merging device');
select is((select user_id from app.network_presence where device_id = 'd4000000-0000-4000-8000-0000000000a3'), 'b4000000-0000-4000-8000-000000000003'::uuid,
  'presence follows the device (net: checks it)');
select is((select user_id from app.downloads where share_id = '94000000-0000-4000-8000-000000000003'), 'b4000000-0000-4000-8000-000000000003'::uuid, 'download history moves');
select is((select reporter_user_id from app.abuse_reports where share_id = '94000000-0000-4000-8000-000000000003'), 'b4000000-0000-4000-8000-000000000003'::uuid,
  'reports stay attributable');
select is((select row(bytes_committed, bytes_reserved, files_committed)::text from app.storage_usage where subject_type = 'user' and subject_id = 'b4000000-0000-4000-8000-000000000003'),
  row(110::bigint, 50::bigint, 2)::text, 'the ledger adds the anonymous user''s committed and reserved bytes (M8)');
select is((select count(*)::int from app.storage_usage where subject_id = 'a4000000-0000-4000-8000-000000000003'), 0, 'and drops its row');
select is((select subject_id from app.storage_reservations where id = '74000000-0000-4000-8000-000000000001'), 'b4000000-0000-4000-8000-000000000003'::uuid,
  'an in-flight upload''s reservation now belongs to the account');
select is((select value from app.rate_counters where key = 'upload_kib:user:b4000000-0000-4000-8000-000000000003'), 10::bigint,
  'today''s upload volume is summed: a merge can''t reset the daily budget (M11)');
select is((select count(*)::int from app.rate_counters where key = 'upload_kib:user:a4000000-0000-4000-8000-000000000003'), 0, 'the anonymous counter is gone');
select is((select upload_restricted from app.user_flags where user_id = 'b4000000-0000-4000-8000-000000000003'), true, 'an upload restriction carries over (M11)');
select is((select count(*)::int from auth.users where id = 'a4000000-0000-4000-8000-000000000003'), 0, 'the anonymous user is deleted');
select is((select count(*)::int from auth.sessions where user_id = 'a4000000-0000-4000-8000-000000000003'), 0, 'with its sessions');
select is((select count(*)::int from app.idempotency_keys where user_id = 'a4000000-0000-4000-8000-000000000003'), 0, 'and its idempotency keys');
select is((select actor_user_id from app.audit_events where action = 'share.created' and actor_user_id = 'a4000000-0000-4000-8000-000000000003' limit 1),
  'a4000000-0000-4000-8000-000000000003'::uuid, 'old audit events keep the anonymous ID: history stays truthful');
select is((select row(status, target_user_id)::text from app.merge_intents where id = 'f4000000-0000-4000-8000-000000000003'),
  row('completed', 'b4000000-0000-4000-8000-000000000003'::uuid)::text, 'the intent is completed for the account');
select is((select metadata ->> 'anonUserId' from app.audit_events where action = 'account.merged' and actor_user_id = 'b4000000-0000-4000-8000-000000000003'),
  'a4000000-0000-4000-8000-000000000003', 'account.merged links the two IDs (M16)');

-- Replays (M4, M6)
set local role app_server;
insert into r4 select 'replay', app.merge_anonymous_user('f4000000-0000-4000-8000-000000000003', array[decode(repeat('a3', 32), 'hex')],
  'b4000000-0000-4000-8000-000000000003', 'c4000000-0000-4000-8000-0000000000c3', 'd4000000-0000-4000-8000-0000000000a3', 10);
insert into r4 select 'replay-other', app.merge_anonymous_user('f4000000-0000-4000-8000-000000000003', array[decode(repeat('a3', 32), 'hex')],
  'b4000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-0000000000b9', 'd4000000-0000-4000-8000-0000000000a3', 10);
reset role;
select is((select val from r4 where step = 'replay'), (select val from r4 where step = 'merged') || '{"replayed": true}',
  'a replay for the same account returns the stored result (idempotent)');
select is((select val ->> 'outcome' from r4 where step = 'replay-other'), 'conflict', 'a replay for another account is a conflict (409)');
select is((select count(*)::int from app.audit_events where action = 'account.merged' and actor_user_id = 'b4000000-0000-4000-8000-000000000003'), 1,
  'replays change nothing');

-- Coverage (M10): every app column that holds a user ID is handled by the merge. A new one fails here
-- until merge_anonymous_user handles it (re-point, keep or cascade) and this list says how.
select set_eq(
  $q$select table_name::text || '.' || column_name::text from information_schema.columns
      where table_schema = 'app' and data_type = 'uuid'
        and (column_name like '%user_id%' or column_name in ('billing_subject_id', 'subject_id'))$q$,
  array[
    'shares.created_by_user_id',          -- re-pointed
    'shares.billing_subject_id',          -- re-pointed (type user)
    'shares.claimed_by_user_id',          -- re-pointed
    'share_links.created_by_user_id',     -- re-pointed
    'share_links.revoked_by_user_id',     -- re-pointed
    'devices.user_id',                    -- the merging device moves; the source's others cascade
    'network_presence.user_id',           -- re-pointed with the device
    'downloads.user_id',                  -- re-pointed (history)
    'abuse_reports.reporter_user_id',     -- re-pointed
    'storage_usage.subject_id',           -- summed into the target, source row deleted
    'storage_reservations.subject_id',    -- active rows re-pointed
    'user_flags.user_id',                 -- upload_restricted ORed; source row cascades
    'idempotency_keys.user_id',           -- cascades with the source
    'audit_events.actor_user_id',         -- kept: history stays truthful
    'profiles.user_id',                   -- an anonymous source has none
    'merge_intents.anon_user_id',         -- the intent itself
    'merge_intents.target_user_id',       -- the intent itself
    -- Phase 4B (deviation DV4-18): an anonymous source has neither. Checkout needs an account (E31);
    -- admin_grant_override refuses anonymous users, and resolution ignores any row for one.
    'subscriptions.subject_id',
    'entitlement_overrides.subject_id',
    -- Phase 4C (deviation DV4-35): billing rows exist only for accounts (checkout needs one, and the
    -- webhook attaches subscriptions through our checkouts and customers), so an anonymous source has none.
    'billing_customers.subject_id',
    'billing_checkouts.subject_id',
    'billing_events.subject_id',
    'billing_disputes.subject_id',
    -- Phase 4D (P4-17, deviation DV4-88): room memberships move with the source (D4-19); supabase/tests/phase4_rooms.test.sql
    -- covers how. An anonymous source owns no room and made no invite: rooms are Pro, and Pro needs an account.
    'room_members.user_id',               -- re-pointed, or merged into the target's row in that room
    'room_members.removed_by_user_id',    -- re-pointed
    'rooms.owner_user_id',                -- an anonymous source has none
    'room_invites.created_by_user_id'     -- an anonymous source has none
  ],
  'every column holding a user ID is on the merge''s list (M10 coverage)');

-- ---------------------------------------------------------------------------
-- Anonymous cleanup skips open intents (RISK-043, M14)
-- ---------------------------------------------------------------------------
update auth.users set created_at = now() - interval '40 days', last_sign_in_at = now() - interval '40 days'
 where id in ('a4000000-0000-4000-8000-000000000005', 'a4000000-0000-4000-8000-000000000006');
insert into app.merge_intents (id, anon_user_id, anon_device_id, secret_hmac, pepper_version, expires_at)
values ('f4000000-0000-4000-8000-000000000005', 'a4000000-0000-4000-8000-000000000005', gen_random_uuid(), decode(repeat('a5', 32), 'hex'), 1, now() + interval '1 hour');
do $$ begin perform app.cleanup_anonymous_users(1000); end $$;
select is((select count(*)::int from auth.users where id = 'a4000000-0000-4000-8000-000000000006'), 0, 'an inactive empty anonymous user is cleaned up');
select is((select count(*)::int from auth.users where id = 'a4000000-0000-4000-8000-000000000005'), 1,
  'but not while a merge intent is open: its data may be on its way to an account');
update app.merge_intents set created_at = now() - interval '2 days', expires_at = now() - interval '1 day' where id = 'f4000000-0000-4000-8000-000000000005';
do $$ begin perform app.cleanup_anonymous_users(1000); end $$;
select is((select count(*)::int from auth.users where id = 'a4000000-0000-4000-8000-000000000005'), 0, 'an expired intent no longer protects it');

-- ---------------------------------------------------------------------------
-- end_share: the Phase 4 reasons (§17.5.7)
-- ---------------------------------------------------------------------------
insert into app.shares (id, scope, network_space_id, kind, created_by_user_id, billing_subject_type, billing_subject_id, status, retention_class,
                        expires_at, entitlement_snapshot)
values ('94000000-0000-4000-8000-000000000010', 'network', 'e4000000-0000-4000-8000-000000000001', 'text', 'b4000000-0000-4000-8000-000000000002',
        'user', 'b4000000-0000-4000-8000-000000000002', 'active', 'd7', now() + interval '1 day', '{}');
select ok(app.end_share('94000000-0000-4000-8000-000000000010', 'room_deleted'), 'end_share accepts room_deleted');
select is((select row(status, end_reason)::text from app.shares where id = '94000000-0000-4000-8000-000000000010'),
  row('deleted', 'room_deleted')::text, 'room_deleted ends the share as deleted');
select throws_ok($q$select app.end_share('94000000-0000-4000-8000-000000000010', 'whatever')$q$, '22023', null, 'unknown reasons are still refused');

-- ---------------------------------------------------------------------------
-- Account deletion functions (P4-03; the flow, job schedule and UI are P4-22)
-- ---------------------------------------------------------------------------
insert into app.profiles (user_id) values ('b4000000-0000-4000-8000-000000000004'), ('b4000000-0000-4000-8000-000000000005');
set local role app_server;
insert into r4 select 'del-req', to_jsonb(app.request_account_deletion('b4000000-0000-4000-8000-000000000004', interval '7 days'));
insert into r4 select 'del-req-again', to_jsonb(app.request_account_deletion('b4000000-0000-4000-8000-000000000004', interval '7 days'));
insert into r4 select 'del-anon', to_jsonb(app.request_account_deletion('a4000000-0000-4000-8000-000000000001', interval '7 days'));
insert into r4 select 'del-cancel', to_jsonb(app.cancel_account_deletion('b4000000-0000-4000-8000-000000000004'));
insert into r4 select 'del-cancel-again', to_jsonb(app.cancel_account_deletion('b4000000-0000-4000-8000-000000000004'));
reset role;
select ok((select (val #>> '{}')::timestamptz between now() + interval '6 days 23 hours' and now() + interval '7 days' from r4 where step = 'del-req'),
  'a deletion request is scheduled after the grace period');
select is((select val from r4 where step = 'del-req-again'), null, 'a second request while one is pending changes nothing');
select is((select val from r4 where step = 'del-anon'), null, 'anonymous users have no account to delete');
select is((select val from r4 where step = 'del-cancel'), 'true'::jsonb, 'a pending deletion can be cancelled');
select is((select val from r4 where step = 'del-cancel-again'), 'false'::jsonb, 'cancelling twice reports nothing to cancel');
select throws_ok($q$select app.request_account_deletion('b4000000-0000-4000-8000-000000000004', interval '-1 day')$q$, '22023', null,
  'a negative grace is refused');

-- b4 is due now, with an open share, a device and a ledger row; b5 is due but suspended.
insert into app.devices (id, user_id, label) values ('d4000000-0000-4000-8000-0000000000b4', 'b4000000-0000-4000-8000-000000000004', 'Leaving');
insert into app.shares (id, scope, network_space_id, kind, created_by_user_id, billing_subject_type, billing_subject_id, status, retention_class,
                        expires_at, file_count, total_bytes, entitlement_snapshot)
values ('94000000-0000-4000-8000-000000000020', 'network', 'e4000000-0000-4000-8000-000000000001', 'files', 'b4000000-0000-4000-8000-000000000004',
        'user', 'b4000000-0000-4000-8000-000000000004', 'active', 'd7', now() + interval '1 day', 1, 20, '{}');
insert into app.files (id, share_id, object_key, original_name, declared_mime, stored_content_type, declared_size_bytes, size_bytes,
                       upload_status, upload_expires_at)
values ('84000000-0000-4000-8000-000000000020', '94000000-0000-4000-8000-000000000020', 'd7/2026/10/16/84000000-0000-4000-8000-000000000020',
        'c.bin', 'application/octet-stream', 'application/octet-stream', 20, 20, 'verified', now() + interval '2 hours');
insert into app.storage_usage (subject_type, subject_id, bytes_committed, files_committed) values ('user', 'b4000000-0000-4000-8000-000000000004', 20, 1);
update app.profiles set deletion_requested_at = now(), deletion_scheduled_for = now()
 where user_id in ('b4000000-0000-4000-8000-000000000004', 'b4000000-0000-4000-8000-000000000005');
select is(app.delete_due_accounts(10), 1, 'one due account is deleted; the suspended one waits for an operator (D4-6 pending)');
select is((select row(status, end_reason, created_by_user_id)::text from app.shares where id = '94000000-0000-4000-8000-000000000020'),
  row('deleted', 'account_deleted', null::uuid)::text, 'its open shares end as account_deleted; the tombstone stays until its date');
select is((select count(*)::int from app.object_deletions where object_key = 'd7/2026/10/16/84000000-0000-4000-8000-000000000020' and completed_at is null), 1,
  'their objects are queued for the janitor');
select is(
  (select count(*)::int from app.devices where user_id = 'b4000000-0000-4000-8000-000000000004')
  + (select count(*)::int from app.profiles where user_id = 'b4000000-0000-4000-8000-000000000004')
  + (select count(*)::int from app.storage_usage where subject_id = 'b4000000-0000-4000-8000-000000000004')
  + (select count(*)::int from auth.users where id = 'b4000000-0000-4000-8000-000000000004'), 0,
  'devices, profile, ledger row and the Auth user are gone');
select is((select count(*)::int from auth.users where id = 'b4000000-0000-4000-8000-000000000005'), 1, 'the suspended account is kept (evidence, D-3)');
select is((select count(*)::int from app.audit_events where action = 'account.deleted' and target_id = 'b4000000-0000-4000-8000-000000000004'), 1,
  'the deletion is audited, by the system');

-- ---------------------------------------------------------------------------
-- purge_ephemeral: intents and revoked devices
-- ---------------------------------------------------------------------------
insert into app.merge_intents (id, anon_user_id, anon_device_id, secret_hmac, pepper_version, status, target_user_id, created_at, expires_at, completed_at, result)
values ('f4000000-0000-4000-8000-000000000020', gen_random_uuid(), gen_random_uuid(), decode(repeat('20', 32), 'hex'), 1, 'completed', gen_random_uuid(),
        now() - interval '32 days', now() - interval '31 days', now() - interval '31 days', '{}'),
       ('f4000000-0000-4000-8000-000000000021', gen_random_uuid(), gen_random_uuid(), decode(repeat('21', 32), 'hex'), 1, 'open', null,
        now() - interval '25 hours', now() - interval '1 hour', null, null);
insert into app.devices (id, user_id, label, revoked_at, revoked_reason) values
  ('d4000000-0000-4000-8000-0000000000e1', 'b4000000-0000-4000-8000-000000000002', 'Old', now() - interval '31 days', 'user'),
  ('d4000000-0000-4000-8000-0000000000e2', 'b4000000-0000-4000-8000-000000000002', 'Recent', now() - interval '1 day', 'user');
do $$ begin perform app.purge_ephemeral(); end $$;
select is((select count(*)::int from app.merge_intents where id = 'f4000000-0000-4000-8000-000000000020'), 0, 'intents are purged 30 days after they end');
select is((select status from app.merge_intents where id = 'f4000000-0000-4000-8000-000000000021'), 'expired', 'open intents past their expiry are marked expired');
select is((select array_agg(label order by label) from app.devices where id in ('d4000000-0000-4000-8000-0000000000e1', 'd4000000-0000-4000-8000-0000000000e2')),
  array['Recent'], 'revoked devices are purged 30 days after revocation (04 §3.2)');

select * from finish();
rollback;
