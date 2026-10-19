-- Phase 4D database tests (P4-16): link passwords (phase 4 §17.8.3, §17.12.2, 03 §4.7, DEC-021).
-- The password columns, the stored format (scrypt PHC only: D4-24, DV4-70), the version that every set,
-- change or removal bumps (a trigger, so no code path can forget to invalidate grants), and the grant's
-- password_verified_at, which can never predate its grant: a grant refreshed by a new unlock or code must
-- prove the password again. Test IDs refer to phase 4 §17.19.5.
begin;
create extension if not exists pgtap with schema extensions;

select plan(34);

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------
select has_column('app', 'share_links', 'password_hash', 'share_links.password_hash exists');
select col_type_is('app', 'share_links', 'password_hash', 'text', 'password_hash is text (a PHC string)');
select has_column('app', 'share_links', 'password_version', 'share_links.password_version exists');
select col_not_null('app', 'share_links', 'password_version', 'password_version is not null');
select col_default_is('app', 'share_links', 'password_version', '0', 'password_version starts at 0');
select has_column('app', 'share_links', 'password_set_at', 'share_links.password_set_at exists');
select has_column('app', 'share_links', 'password_locked_until', 'share_links.password_locked_until exists');
select has_column('app', 'link_grants', 'password_verified_at', 'link_grants.password_verified_at exists');
select ok(
  has_column_privilege('app_server', 'app.share_links', 'password_hash', 'UPDATE')
  and has_column_privilege('app_server', 'app.share_links', 'password_locked_until', 'UPDATE')
  and has_column_privilege('app_server', 'app.link_grants', 'password_verified_at', 'UPDATE')
  and not has_table_privilege('app_janitor', 'app.share_links', 'SELECT'),
  'the server writes the hash, the lock and the verification; the janitor sees none of it');
select ok(
  not (select prosecdef from pg_proc where oid = 'app.share_links_password_state()'::regprocedure),
  'the version is kept by an invoker trigger function, callable by no one directly');

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, is_anonymous, created_at, updated_at)
values ('46000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', true, now(), now());
insert into app.shares (id, scope, kind, created_by_user_id, billing_subject_type, billing_subject_id, status, retention_class,
                        expires_at, entitlement_snapshot)
values ('a4600000-0000-4000-8000-000000000001', 'link_only', 'text', '46000000-0000-4000-8000-000000000001', 'user',
        '46000000-0000-4000-8000-000000000001', 'active', 'd7', now() + interval '1 day', '{}');

create function pg_temp.hash(p_fill text) returns text language sql immutable as $$
  select '$scrypt$ln=17,r=8,p=1$' || repeat(p_fill, 22) || '$' || repeat(p_fill, 43) $$;
create function pg_temp.link(p_id text, p_hash text default null) returns void language sql as $$
  insert into app.share_links (id, share_id, secret_hmac, pepper_version, expires_at, entitlement_snapshot, password_hash)
  values (p_id, 'a4600000-0000-4000-8000-000000000001', decode(repeat('ab', 32), 'hex'), 1, now() + interval '1 hour', '{}', p_hash);
$$;
create function pg_temp.state(p_id text) returns text language sql stable as $$
  select password_version || ' ' || coalesce((password_set_at = now())::text, 'null') || ' ' || (password_hash is not null)::text
    from app.share_links where id = p_id $$;

-- ---------------------------------------------------------------------------
-- The stored format: scrypt PHC with this build's parameters, nothing else
-- ---------------------------------------------------------------------------
select lives_ok($$select pg_temp.link('PASSWORDLINK0001')$$, 'a link without a password');
select lives_ok($$select pg_temp.link('PASSWORDLINK0002', pg_temp.hash('A'))$$, 'a link with a scrypt hash');
select throws_ok($$select pg_temp.link('PASSWORDLINK0003', 'correct horse battery staple')$$, '23514', null,
  'plaintext is refused');
select throws_ok($$select pg_temp.link('PASSWORDLINK0004', replace(pg_temp.hash('A'), 'ln=17', 'ln=10'))$$, '23514', null,
  'weaker scrypt parameters are refused');
select throws_ok($$select pg_temp.link('PASSWORDLINK0005', '$argon2id$v=19$m=19456,t=2,p=1$' || repeat('A', 22) || '$' || repeat('A', 43))$$,
  '23514', null, 'a format this build cannot verify is refused');
select throws_ok($$select pg_temp.link('PASSWORDLINK0006', pg_temp.hash('A') || repeat('A', 480))$$, '23514', null,
  'at most 512 characters, and exactly one salt and one hash');

-- ---------------------------------------------------------------------------
-- The version: +1 on every set, change or removal, whoever writes (T4-P5)
-- ---------------------------------------------------------------------------
select is(pg_temp.state('PASSWORDLINK0001'), '0 null false', 'no password: version 0, never set');
select is(pg_temp.state('PASSWORDLINK0002'), '1 true true', 'created with a password: version 1, set now');
select lives_ok($$insert into app.share_links (id, share_id, secret_hmac, pepper_version, expires_at, entitlement_snapshot,
                                              password_hash, password_version, password_set_at)
                  values ('PASSWORDLINK0007', 'a4600000-0000-4000-8000-000000000001', decode(repeat('ab', 32), 'hex'), 1,
                          now() + interval '1 hour', '{}', null, 9, now() - interval '1 day')$$,
  'an insert that names its own version and time');
select is(pg_temp.state('PASSWORDLINK0007'), '0 null false', 'gets the trigger''s: the version follows the hash alone');

update app.share_links set password_hash = pg_temp.hash('B') where id = 'PASSWORDLINK0001';
select is(pg_temp.state('PASSWORDLINK0001'), '1 true true', 'setting a password bumps the version');
update app.share_links set password_hash = pg_temp.hash('C') where id = 'PASSWORDLINK0001';
select is(pg_temp.state('PASSWORDLINK0001'), '2 true true', 'changing it bumps the version again');
update app.share_links set password_hash = null where id = 'PASSWORDLINK0001';
select is(pg_temp.state('PASSWORDLINK0001'), '3 null false', 'removing it bumps the version and clears the time');
update app.share_links set password_hash = null where id = 'PASSWORDLINK0001';
select is(pg_temp.state('PASSWORDLINK0001'), '3 null false', 'removing an absent password changes nothing');
update app.share_links set unlock_count = unlock_count + 1, password_locked_until = now() + interval '15 minutes' where id = 'PASSWORDLINK0002';
select is(pg_temp.state('PASSWORDLINK0002'), '1 true true', 'other columns (the lock, counters) leave the version alone');

-- PostgreSQL 16+: the role that created app_server may grant itself membership (rolled back below).
grant app_server to current_user;
set local role app_server;
update app.share_links set password_version = 0, password_set_at = null where id = 'PASSWORDLINK0002';
reset role;
select is(pg_temp.state('PASSWORDLINK0002'), '1 true true',
  'the server cannot wind the version back to revive old grants: a direct write is ignored');
set local role app_server;
update app.share_links set password_hash = pg_temp.hash('D') where id = 'PASSWORDLINK0002';
reset role;
select is(pg_temp.state('PASSWORDLINK0002'), '2 true true', 'a change by the server bumps it like any other');
select col_has_check('app', 'share_links', 'password_version', 'password_version is checked >= 0');

-- ---------------------------------------------------------------------------
-- Grants: a password proof never predates its grant, nor outlives it (C4-8, T4-P5)
-- ---------------------------------------------------------------------------
insert into app.link_sessions (id_hash, expires_at) values (decode(repeat('6a', 32), 'hex'), now() + interval '12 hours');
insert into app.link_grants (session_id_hash, link_id, password_version, granted_via, granted_at, expires_at, password_verified_at)
values (decode(repeat('6a', 32), 'hex'), 'PASSWORDLINK0002', 2, 'secret', now() - interval '1 hour', now() + interval '11 hours',
        now() - interval '30 minutes');
select is((select password_verified_at = now() - interval '30 minutes' from app.link_grants where link_id = 'PASSWORDLINK0002'), true,
  'a grant verified after it was granted');
select throws_ok(
  $$update app.link_grants set granted_at = now(), expires_at = now() + interval '12 hours' where link_id = 'PASSWORDLINK0002'$$,
  '23514', null, 'a new unlock or code that refreshes the grant cannot keep the old proof (T4-P5)');
select lives_ok(
  $$update app.link_grants set granted_at = now(), expires_at = now() + interval '12 hours', password_verified_at = null
     where link_id = 'PASSWORDLINK0002'$$,
  'a refresh starts unverified');
select throws_ok(
  $$update app.link_grants set password_verified_at = now() - interval '1 second' where link_id = 'PASSWORDLINK0002'$$,
  '23514', null, 'a proof cannot be dated before its grant');
select throws_ok(
  $$update app.link_grants set password_verified_at = expires_at + interval '1 second' where link_id = 'PASSWORDLINK0002'$$,
  '23514', null, 'nor after the grant has expired');
select throws_ok(
  $$insert into app.link_grants (session_id_hash, link_id, granted_via, expires_at)
    values (decode(repeat('6a', 32), 'hex'), 'PASSWORDLINK0001', 'password', now() + interval '1 hour')$$,
  '23514', null, 'the password is a state of a grant (password_verified_at), never a way to get one');

select * from finish();
rollback;
