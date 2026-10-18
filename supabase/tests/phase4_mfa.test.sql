-- Phase 4D, P4-24: MFA on Realtime (phase 4 §17.5.9, D4-30). An account with a verified authenticator joins no topic
-- below aal2, as the API refuses it (403 MFA_REQUIRED); without one, or with an unverified one, nothing changes.
begin;
create extension if not exists pgtap with schema extensions;

select plan(16);

-- ---------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------
select ok(has_function_privilege('app_owner', 'app.mfa_enrolled(uuid)', 'EXECUTE'), 'the topic check''s owner may ask whether an account has an authenticator');
select is(
  (select count(*)::int from unnest(array['anon', 'authenticated', 'app_janitor', 'app_egress_loader']) as r(role)
    where has_function_privilege(r.role, 'app.mfa_enrolled(uuid)', 'EXECUTE')),
  0, 'no client role may ask it');
select is(
  (select pg_get_userbyid(p.proowner) || ' ' || p.prosecdef::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_realtime' and p.proname = 'can_access_topic'),
  'app_owner true', 'the topic check is still app_owner''s, security definer');
select is(
  (select count(*)::int from unnest(array['anon', 'app_server']) as r(role)
    where has_function_privilege(r.role, 'app_realtime.can_access_topic(text)', 'EXECUTE')),
  0, 'only authenticated callers run the topic check');

-- ---------------------------------------------------------------------------
-- Fixtures (4e…): m1 has a verified authenticator, m2 none, m3 an unverified one; each has one session and a device
-- bound to it, present on one network.
-- ---------------------------------------------------------------------------
update auth.users set created_at = now(), last_sign_in_at = now();

insert into auth.users (id, instance_id, aud, role, email, is_anonymous, encrypted_password, created_at, updated_at)
select id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', email, false, '', now(), now()
  from (values
    ('4e000000-0000-4000-8000-000000000001', 'm1@example.com'),
    ('4e000000-0000-4000-8000-000000000002', 'm2@example.com'),
    ('4e000000-0000-4000-8000-000000000003', 'm3@example.com')
  ) as u(id, email);
insert into auth.sessions (id, user_id, created_at, updated_at)
values ('4e000000-0000-4000-8000-0000000000a1', '4e000000-0000-4000-8000-000000000001', now(), now()),
       ('4e000000-0000-4000-8000-0000000000a2', '4e000000-0000-4000-8000-000000000002', now(), now()),
       ('4e000000-0000-4000-8000-0000000000a3', '4e000000-0000-4000-8000-000000000003', now(), now());
insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
values ('4e000000-0000-4000-8000-0000000000f1', '4e000000-0000-4000-8000-000000000001', 'totp', 'verified', now(), now()),
       ('4e000000-0000-4000-8000-0000000000f3', '4e000000-0000-4000-8000-000000000003', 'totp', 'unverified', now(), now());
insert into app.network_spaces (id, network_key, key_version, family)
values ('4e000000-0000-4000-8000-0000000000e1', decode(repeat('4e', 32), 'hex'), 1, 4);
insert into app.devices (id, user_id, label, auth_session_id)
values ('4e000000-0000-4000-8000-0000000000d1', '4e000000-0000-4000-8000-000000000001', 'With App', '4e000000-0000-4000-8000-0000000000a1'),
       ('4e000000-0000-4000-8000-0000000000d2', '4e000000-0000-4000-8000-000000000002', 'Without', '4e000000-0000-4000-8000-0000000000a2'),
       ('4e000000-0000-4000-8000-0000000000d3', '4e000000-0000-4000-8000-000000000003', 'Unverified', '4e000000-0000-4000-8000-0000000000a3');
insert into app.network_presence (space_id, device_id, user_id, present_until)
select '4e000000-0000-4000-8000-0000000000e1', d.id, d.user_id, now() + interval '10 minutes'
  from app.devices d where d.id::text like '4e000000-%';

create temp table topic4e (label text primary key, allowed boolean) on commit drop;
grant insert on topic4e to authenticated;

create function pg_temp.claims(p_user text, p_session text, p_aal text) returns text
language sql as $$
  select json_build_object('sub', p_user, 'role', 'authenticated', 'session_id', p_session, 'is_anonymous', false,
                           'amr', json_build_array(json_build_object('method', 'otp', 'timestamp', 1)))::jsonb
         || case when p_aal is null then '{}'::jsonb else jsonb_build_object('aal', p_aal) end
$$;

set local role authenticated;
select set_config('request.jwt.claims', pg_temp.claims('4e000000-0000-4000-8000-000000000001', '4e000000-0000-4000-8000-0000000000a1', 'aal1'), true);
insert into topic4e values
  ('m1 aal1 user', app_realtime.can_access_topic('user:4e000000-0000-4000-8000-000000000001')),
  ('m1 aal1 net', app_realtime.can_access_topic('net:4e000000-0000-4000-8000-0000000000e1'));
select set_config('request.jwt.claims', pg_temp.claims('4e000000-0000-4000-8000-000000000001', '4e000000-0000-4000-8000-0000000000a1', null), true);
insert into topic4e values ('m1 no aal user', app_realtime.can_access_topic('user:4e000000-0000-4000-8000-000000000001'));
select set_config('request.jwt.claims', pg_temp.claims('4e000000-0000-4000-8000-000000000001', '4e000000-0000-4000-8000-0000000000a1', 'aal2'), true);
insert into topic4e values
  ('m1 aal2 user', app_realtime.can_access_topic('user:4e000000-0000-4000-8000-000000000001')),
  ('m1 aal2 net', app_realtime.can_access_topic('net:4e000000-0000-4000-8000-0000000000e1'));
select set_config('request.jwt.claims', pg_temp.claims('4e000000-0000-4000-8000-000000000002', '4e000000-0000-4000-8000-0000000000a2', 'aal1'), true);
insert into topic4e values
  ('m2 aal1 user', app_realtime.can_access_topic('user:4e000000-0000-4000-8000-000000000002')),
  ('m2 aal1 net', app_realtime.can_access_topic('net:4e000000-0000-4000-8000-0000000000e1'));
select set_config('request.jwt.claims', pg_temp.claims('4e000000-0000-4000-8000-000000000003', '4e000000-0000-4000-8000-0000000000a3', 'aal1'), true);
insert into topic4e values ('m3 aal1 user', app_realtime.can_access_topic('user:4e000000-0000-4000-8000-000000000003'));
-- aal2 for one user's token never opens another user's topic.
select set_config('request.jwt.claims', pg_temp.claims('4e000000-0000-4000-8000-000000000001', '4e000000-0000-4000-8000-0000000000a1', 'aal2'), true);
insert into topic4e values ('m1 aal2 on m2', app_realtime.can_access_topic('user:4e000000-0000-4000-8000-000000000002'));
reset role;

-- The authenticator removed (Supabase Auth's unenroll): aal1 joins again.
delete from auth.mfa_factors where id = '4e000000-0000-4000-8000-0000000000f1';
set local role authenticated;
select set_config('request.jwt.claims', pg_temp.claims('4e000000-0000-4000-8000-000000000001', '4e000000-0000-4000-8000-0000000000a1', 'aal1'), true);
insert into topic4e values ('m1 aal1 after removal', app_realtime.can_access_topic('user:4e000000-0000-4000-8000-000000000001'));
reset role;

select is((select allowed from topic4e where label = 'm1 aal1 user'), false, 'with an authenticator, aal1 can''t join its user: topic');
select is((select allowed from topic4e where label = 'm1 aal1 net'), false, 'nor net:, its bound and present device notwithstanding');
select is((select allowed from topic4e where label = 'm1 no aal user'), false, 'a token without an aal claim counts as aal1');
select is((select allowed from topic4e where label = 'm1 aal2 user'), true, 'at aal2 it joins user:');
select is((select allowed from topic4e where label = 'm1 aal2 net'), true, 'and net:');
select is((select allowed from topic4e where label = 'm2 aal1 user'), true, 'without an authenticator, aal1 joins user: as before');
select is((select allowed from topic4e where label = 'm2 aal1 net'), true, 'and net: as before');
select is((select allowed from topic4e where label = 'm3 aal1 user'), true, 'an unverified authenticator changes nothing');
select is((select allowed from topic4e where label = 'm1 aal2 on m2'), false, 'aal2 never opens another user''s topic');
select is((select allowed from topic4e where label = 'm1 aal1 after removal'), true, 'once the authenticator is removed, aal1 joins again');
select is(app.mfa_enrolled('4e000000-0000-4000-8000-000000000001'), false, 'and the account no longer counts as enrolled');
select is(app.mfa_enrolled('4e000000-0000-4000-8000-000000000003'), false, 'an unverified factor never counted');

select * from finish();
rollback;
