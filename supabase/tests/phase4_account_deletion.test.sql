-- Phase 4D database tests (P4-22): the account-deletion flow around P4-21's job (phase 4 §17.5.7, D4-6 and D4-30 as
-- recommended; T4-A5, T4-A6). The app may only request and cancel; nothing it or a browser can call runs the job,
-- which pg_cron runs hourly through run_job as its owner. A cancel works only during the grace. A change of the
-- deletion state signals the account's other browsers. The job deletes due accounts and leaves those in their grace,
-- cancelled ones and suspended ones (D4-6 pending, DV4-13). What it deletes and keeps: phase4_account_coverage.test.sql.
begin;
create extension if not exists pgtap with schema extensions;

select plan(14);

-- ---------------------------------------------------------------------------
-- Who may run what
-- ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('app_server', 'app.run_job(text)', 'execute')
  and not has_function_privilege('app_server', 'app.delete_due_accounts(integer)', 'execute')
  and not has_function_privilege('authenticated', 'app.run_job(text)', 'execute')
  and not has_function_privilege('authenticated', 'app.delete_due_accounts(integer)', 'execute')
  and not has_function_privilege('anon', 'app.delete_due_accounts(integer)', 'execute'),
  'nothing the app or a browser can call runs the deletion job');
select ok(
  has_function_privilege('app_server', 'app.request_account_deletion(uuid, interval)', 'execute')
  and has_function_privilege('app_server', 'app.cancel_account_deletion(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'app.request_account_deletion(uuid, interval)', 'execute')
  and not has_function_privilege('authenticated', 'app.cancel_account_deletion(uuid)', 'execute'),
  'the app requests and cancels; browsers can''t call either function');
select is(
  (select schedule || ' ' || command from cron.job where jobname = 'delete-due-accounts'),
  '23 * * * * select app.run_job(''delete-due-accounts'')',
  'pg_cron runs delete-due-accounts every hour, through run_job');
select is(
  (select array_agg(distinct pg_get_userbyid(proowner)::text) from pg_proc
    where oid in ('app.run_job(text)'::regprocedure, 'app.delete_due_accounts(integer)'::regprocedure)),
  (select array_agg(username::text) from cron.job where jobname = 'delete-due-accounts'),
  'the runner and the job belong to the role pg_cron runs the job as (the migration role, which may delete from auth.users)');

-- ---------------------------------------------------------------------------
-- Fixtures: accounts 4c…  01 due   02 in its grace   03 cancels   04 suspended and due
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, is_anonymous, encrypted_password, created_at, updated_at)
select ('4c000000-0000-4000-8000-0000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'd' || n || '@example.com', false, '', now(), now()
  from unnest(array['01', '02', '03', '04']) as n;
insert into app.profiles (user_id) select ('4c000000-0000-4000-8000-0000000000' || n)::uuid from unnest(array['01', '02', '03', '04']) as n;
create function pg_temp.u(p text) returns uuid language sql immutable as $$ select ('4c000000-0000-4000-8000-0000000000' || p)::uuid $$;

grant app_server to current_user;
set local role app_server;
select ok(
  (select bool_and(app.request_account_deletion(pg_temp.u(n), interval '7 days') is not null) from unnest(array['01', '02', '03', '04']) as n),
  'four accounts request their deletion');
select ok(app.cancel_account_deletion(pg_temp.u('03')), 'one cancels it during the grace');
reset role;

select is(
  (select count(*)::int from realtime.messages
    where topic = 'user:' || pg_temp.u('03')::text and event = 'account.changed' and private
      and payload - 'id' = '{"v": 1, "type": "account.changed"}'),
  2, 'the request and the cancel each tell the account''s browsers, privately and naming nobody (realtime adds its message id)');

update app.profiles set deletion_scheduled_for = now() - interval '1 second' where user_id in (pg_temp.u('01'), pg_temp.u('04'));
insert into app.user_flags (user_id, suspended_at, reason) values (pg_temp.u('04'), now(), 'test');

set local role app_server;
select is(app.cancel_account_deletion(pg_temp.u('01')), false, 'a deletion whose date has passed can''t be cancelled');
reset role;
select is(
  (select count(*)::int from app.profiles where user_id = pg_temp.u('01') and deletion_scheduled_for < now()),
  1, 'it stays scheduled');
select is(
  (select count(*)::int from app.audit_events where target_id = pg_temp.u('01')::text and action = 'account.deletion_cancelled'),
  0, 'and nothing is audited as cancelled');

-- ---------------------------------------------------------------------------
-- The job, as pg_cron runs it
-- ---------------------------------------------------------------------------
select app.run_job('delete-due-accounts');
select ok(
  (select (last_result ->> 'deleted')::int >= 1 and last_succeeded_at = now() and (last_failed_at is null or last_failed_at < now())
     from app.job_heartbeats where job = 'delete-due-accounts'),
  'run_job runs it and records a successful heartbeat with the count');
select is(
  (select array_agg(substr(id::text, 35) order by id) from auth.users where id in (pg_temp.u('01'), pg_temp.u('02'), pg_temp.u('03'), pg_temp.u('04'))),
  array['02', '03', '04'],
  'the due account is gone; the one in its grace, the cancelled one and the suspended one stay');
select is(
  (select array_agg(substr(user_id::text, 35) || ':' || (deletion_scheduled_for is not null)::text order by user_id) from app.profiles
    where user_id in (pg_temp.u('02'), pg_temp.u('03'), pg_temp.u('04'))),
  array['02:true', '03:false', '04:true'],
  'with their deletion state as it was');
select is(
  (select count(*)::int from app.audit_events where target_id = pg_temp.u('01')::text and action = 'account.deleted' and actor_kind = 'system'),
  1, 'the deletion is audited by the system');

select * from finish();
rollback;
