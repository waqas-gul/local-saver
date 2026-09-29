-- Phase 0 database baseline (AC-0.6): deny-by-default access and the rate-limit function.
begin;
create extension if not exists pgtap with schema extensions;

select plan(28);

-- Schemas and roles
select has_schema('app', 'app schema exists');
select has_schema('app_realtime', 'app_realtime schema exists');
select has_role('app_owner', 'app_owner role exists');
select has_role('app_server', 'app_server role exists');
select is((select rolcanlogin from pg_roles where rolname = 'app_owner'), false, 'app_owner cannot log in');
select is(
  (select nspowner::regrole::text from pg_namespace where nspname = 'app'),
  'app_owner',
  'app schema is owned by app_owner'
);

-- Client roles get nothing on app (DEC-006)
select ok(not has_schema_privilege('anon', 'app', 'USAGE'), 'anon has no usage on app');
select ok(not has_schema_privilege('authenticated', 'app', 'USAGE'), 'authenticated has no usage on app');
select ok(not has_schema_privilege('public', 'app', 'USAGE'), 'public has no usage on app');
select ok(has_schema_privilege('app_server', 'app', 'USAGE'), 'app_server can use app');
select ok(has_schema_privilege('app_server', 'extensions', 'USAGE'), 'app_server can resolve extension types and operators');
select is(
  (select array_to_string(setconfig, ',') from pg_db_role_setting
    where setrole = 'app_server'::regrole and setdatabase = 0),
  'search_path="$user", public, extensions',
  'app_server logs in with extensions on its search_path'
);
select ok(not has_table_privilege('authenticated', 'app.rate_counters', 'SELECT'), 'authenticated cannot read rate_counters');
select ok(not has_table_privilege('anon', 'app.runtime_flags', 'SELECT'), 'anon cannot read runtime_flags');
-- One privilege per check: a comma-separated list passes if any single privilege is held.
select ok(has_table_privilege('app_server', 'app.runtime_flags', 'SELECT'), 'app_server can read runtime_flags');
select ok(has_table_privilege('app_server', 'app.rate_counters', 'INSERT'), 'app_server can insert rate_counters');
select ok(has_table_privilege('app_server', 'app.rate_counters', 'UPDATE'), 'app_server can update rate_counters');
select ok(not has_table_privilege('app_server', 'app.rate_counters', 'TRUNCATE'), 'app_server cannot truncate');
select ok(
  not has_function_privilege('authenticated', 'app.rate_limit_hit(text, integer, interval, integer)', 'EXECUTE'),
  'authenticated cannot call rate_limit_hit'
);
select ok(
  has_function_privilege('app_server', 'app.rate_limit_hit(text, integer, interval, integer)', 'EXECUTE'),
  'app_server can call rate_limit_hit'
);

-- RLS is on for every table in app
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relkind = 'r' and not c.relrowsecurity),
  0,
  'row level security is enabled on every app table'
);

-- rate_limit_hit allows exactly `limit` calls per window (runs as app_server).
-- PostgreSQL 16+: the role that created app_server may grant itself membership (rolled back below).
-- pgTAP lives in the extensions schema, which app_server cannot use, so the calls run as
-- app_server and store their results; the assertions run afterwards as the owner.
create temp table rl_calls (n int primary key, allowed boolean, current_value bigint) on commit drop;
grant insert on rl_calls to app_server;
-- citext operators live in extensions: without USAGE there, app_server silently compares as text.
create temp table ci_probe (c extensions.citext, matched boolean) on commit drop;
insert into ci_probe (c) values ('ABC');
grant select, update on ci_probe to app_server;
grant app_server to current_user;
set local role app_server;
-- SET ROLE does not apply role-level settings, so use app_server's login search_path explicitly.
set local search_path = "$user", public, extensions;
update ci_probe set matched = (c = 'abc');
insert into rl_calls select 1, allowed, current_value from app.rate_limit_hit('test:window', 3, interval '1 minute');
insert into rl_calls select 2, allowed, current_value from app.rate_limit_hit('test:window', 3, interval '1 minute');
insert into rl_calls select 3, allowed, current_value from app.rate_limit_hit('test:window', 3, interval '1 minute');
insert into rl_calls select 4, allowed, current_value from app.rate_limit_hit('test:window', 3, interval '1 minute');
insert into rl_calls select 5, allowed, current_value from app.rate_limit_hit('test:cost', 10, interval '1 hour', 4);
reset role;

select is((select allowed from rl_calls where n = 1), true, 'call 1 allowed');
select is((select allowed from rl_calls where n = 2), true, 'call 2 allowed');
select is((select allowed from rl_calls where n = 3), true, 'call 3 allowed');
select is((select allowed from rl_calls where n = 4), false, 'call 4 denied');
select is((select current_value from rl_calls where n = 5), 4::bigint, 'cost adds to the counter');
select is((select matched from ci_probe), true, 'citext comparisons are case-insensitive for app_server');

select throws_ok(
  $$select * from app.rate_limit_hit('test:bad', 0, interval '1 minute')$$,
  '22023',
  'invalid rate limit arguments',
  'invalid limits are rejected'
);

select * from finish();
rollback;
