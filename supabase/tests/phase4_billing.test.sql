-- Phase 4C database tests (P4-12; phase 4 §17.7, §17.10, §17.12, §17.19.3): the billing tables and
-- their grants, apply_subscription_state (ordering B4, subject never moved B13/B16, grace B9/D4-21,
-- account.changed), the idempotent event log (B3, B5), lost disputes (B7), reconciliation
-- bookkeeping and its trigger (B12, D4-22), the health checks and the purge.
begin;
create extension if not exists pgtap with schema extensions;

select plan(99);

-- ---------------------------------------------------------------------------
-- Structure and grants (§17.12.4)
-- ---------------------------------------------------------------------------
select has_table('app', 'billing_customers', 'app.billing_customers exists');
select has_table('app', 'billing_checkouts', 'app.billing_checkouts exists');
select has_table('app', 'billing_events', 'app.billing_events exists');
select has_table('app', 'billing_disputes', 'app.billing_disputes exists');
select has_column('app', 'subscriptions', 'synced_at', 'subscriptions record when the provider last confirmed them');
select has_column('app', 'user_flags', 'billing_dispute_count', 'user_flags count lost disputes');
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relname in ('billing_customers', 'billing_checkouts', 'billing_events', 'billing_disputes')
      and not c.relrowsecurity),
  0, 'row level security is on for the billing tables');
select ok(
  has_table_privilege('app_server', 'app.billing_customers', 'SELECT') and has_table_privilege('app_server', 'app.billing_events', 'SELECT')
  and has_table_privilege('app_server', 'app.billing_disputes', 'SELECT'),
  'app_server reads customers, the event log and disputes');
select is(
  (select count(*)::int
     from unnest(array['app.billing_customers', 'app.billing_events', 'app.billing_disputes', 'app.subscriptions']) as t(tbl),
          unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p(priv)
    where has_table_privilege('app_server', t.tbl, p.priv)),
  0, 'app_server writes none of them directly: only through the definer functions');
select is(
  (select count(*)::int from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p(priv)
    where has_table_privilege('app_server', 'app.billing_checkouts', p.priv)),
  4, 'checkouts are the app''s own rows');
select is(
  (select count(*)::int
     from unnest(array['app.billing_customers', 'app.billing_checkouts', 'app.billing_events', 'app.billing_disputes']) as t(tbl),
          unnest(array['anon', 'authenticated', 'app_janitor', 'app_egress_loader']) as r(role),
          unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p(priv)
    where has_table_privilege(r.role, t.tbl, p.priv)),
  0, 'no other role reaches the billing tables');

create temp table billing_functions (sig text) on commit drop;
insert into billing_functions values
  ('app.record_billing_event(text, text, text, timestamptz, jsonb)'),
  ('app.lock_billing_event(bigint)'),
  ('app.finish_billing_event(bigint, text, text, text, uuid)'),
  ('app.apply_subscription_state(text, text, text, text, uuid, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz, timestamptz)'),
  ('app.record_billing_dispute(text, text, text, text, uuid)'),
  ('app.begin_billing_reconcile()'),
  ('app.finish_billing_reconcile(boolean, jsonb, text)');
select is((select count(*)::int from billing_functions where has_function_privilege('app_server', sig, 'EXECUTE')), 7,
  'app_server runs the billing functions');
select is(
  (select count(*)::int from billing_functions, unnest(array['anon', 'authenticated', 'app_janitor', 'app_egress_loader']) as r(role)
    where has_function_privilege(r.role, sig, 'EXECUTE')),
  0, 'no client or other role runs them');
select is(
  (select count(*)::int
     from unnest(array['app.trigger_billing_reconcile()', 'app.emit_account_changed()']) as f(sig),
          unnest(array['app_server', 'app_janitor', 'app_egress_loader', 'anon', 'authenticated']) as r(role)
    where has_function_privilege(r.role, f.sig, 'EXECUTE')),
  0, 'the reconcile trigger and the realtime signal are granted to nobody');

-- ---------------------------------------------------------------------------
-- Fixtures: c6…01–c6…07 accounts. Times are fixed relative to this transaction's now().
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, is_anonymous, encrypted_password, created_at, updated_at)
select id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', email, false, '', now(), now()
  from (values
    ('c6000000-0000-4000-8000-000000000001', 'b1@example.com'),
    ('c6000000-0000-4000-8000-000000000002', 'b2@example.com'),
    ('c6000000-0000-4000-8000-000000000003', 'b3@example.com'),
    ('c6000000-0000-4000-8000-000000000004', 'b4@example.com'),
    ('c6000000-0000-4000-8000-000000000005', 'b5@example.com'),
    ('c6000000-0000-4000-8000-000000000006', 'b6@example.com'),
    ('c6000000-0000-4000-8000-000000000007', 'b7@example.com')
  ) as u(id, email);

-- apply(sub, customer, subject, status, period start/end offsets, cancel, grace, updated-at offset): seconds from now().
create function pg_temp.apply(p_sub text, p_customer text, p_subject text, p_status text, p_start int, p_end int,
                              p_cancel boolean, p_grace int, p_updated int, p_interval text default 'month')
returns text language sql as $$
  select app.apply_subscription_state('fake', p_sub, p_customer, 'user', p_subject::uuid, 'pro', p_interval, p_status,
    case when p_start is null then null else now() + make_interval(secs => p_start) end,
    case when p_end is null then null else now() + make_interval(secs => p_end) end,
    p_cancel, null,
    case when p_grace is null then null else now() + make_interval(secs => p_grace) end,
    now() + make_interval(secs => p_updated))
$$;
create function pg_temp.entitled(p_user text) returns boolean language sql as $$
  select entitled from app.entitlement_state(p_user::uuid)
$$;
create function pg_temp.changes(p_user text) returns int language sql as $$
  select count(*)::int from app.audit_events where action = 'billing.subscription_changed' and target_id = p_user
$$;
create function pg_temp.signals(p_user text) returns int language sql as $$
  select count(*)::int from realtime.messages where topic = 'user:' || p_user and event = 'account.changed'
$$;

-- ---------------------------------------------------------------------------
-- apply_subscription_state: insert, unchanged, newer, older (B4), subject (B13), validation
-- ---------------------------------------------------------------------------
grant app_server to postgres;
set local role app_server;
select is(pg_temp.apply('sub_1', 'cus_1', 'c6000000-0000-4000-8000-000000000001', 'active', -60, 2592000, false, null, -10),
  'applied', 'a first state is applied (callable by app_server)');
reset role;
select is(
  (select row(status, provider_customer_id, subject_id::text, billing_interval, plan)::text from app.subscriptions where provider_subscription_id = 'sub_1'),
  row('active', 'cus_1', 'c6000000-0000-4000-8000-000000000001', 'month', 'pro')::text, 'the row holds the provider''s state');
select is((select subject_id::text from app.billing_customers where provider = 'fake' and provider_customer_id = 'cus_1'),
  'c6000000-0000-4000-8000-000000000001', 'the customer is mapped to the subject');
select ok(pg_temp.entitled('c6000000-0000-4000-8000-000000000001'), 'resolution now grants Pro (4B reads the row)');
select is(
  (select metadata - 'subscriptionId' from app.audit_events
    where action = 'billing.subscription_changed' and target_id = 'c6000000-0000-4000-8000-000000000001'),
  '{"provider": "fake", "from": null, "to": "active", "interval": "month", "cancelAtPeriodEnd": false}'::jsonb,
  'the change is audited from nothing to active (IDs and states only)');
select is(pg_temp.signals('c6000000-0000-4000-8000-000000000001'), 1, 'account.changed is sent on the user''s topic');
select is(
  (select count(*)::int from realtime.messages m, jsonb_object_keys(m.payload) k
    where m.topic = 'user:c6000000-0000-4000-8000-000000000001' and m.event = 'account.changed' and k not in ('v', 'type', 'id')),
  0, 'the signal carries no subject IDs or state (T-018; id is realtime''s message ID): the client refetches');

select is(pg_temp.apply('sub_1', 'cus_1', 'c6000000-0000-4000-8000-000000000001', 'active', -60, 2592000, false, null, -10),
  'unchanged', 'the same state again (a duplicate or replay) changes nothing');
select is(row(pg_temp.changes('c6000000-0000-4000-8000-000000000001'), pg_temp.signals('c6000000-0000-4000-8000-000000000001'))::text,
  row(1, 1)::text, 'no second audit event or signal');

select is(pg_temp.apply('sub_1', 'cus_1', 'c6000000-0000-4000-8000-000000000001', 'canceled', -60, 2592000, true, null, -5),
  'applied', 'a newer state is applied');
select is(
  (select metadata ->> 'from' || '→' || (metadata ->> 'to') from app.audit_events
    where action = 'billing.subscription_changed' and target_id = 'c6000000-0000-4000-8000-000000000001' order by id desc limit 1),
  'active→canceled', 'audited with from and to');
update app.subscriptions set synced_at = now() - interval '3 days' where provider_subscription_id = 'sub_1';
select is(pg_temp.apply('sub_1', 'cus_1', 'c6000000-0000-4000-8000-000000000001', 'active', -60, 2592000, false, null, -8),
  'stale', 'an older provider state is refused (provider_updated_at ordering, B4)');
select is((select row(status, cancel_at_period_end)::text from app.subscriptions where provider_subscription_id = 'sub_1'),
  row('canceled', true)::text, 'and the newer state stays');
select ok((select synced_at = now() from app.subscriptions where provider_subscription_id = 'sub_1'),
  'a stale answer still counts as the provider having been asked (synced_at)');
select ok(pg_temp.entitled('c6000000-0000-4000-8000-000000000001'), 'cancelled at period end: Pro until the period ends (B8)');

select is(pg_temp.apply('sub_1', 'cus_1', 'c6000000-0000-4000-8000-000000000002', 'active', -60, 2592000, false, null, 0),
  'subject_mismatch', 'a subscription is never moved to another subject');
select is((select subject_id::text from app.subscriptions where provider_subscription_id = 'sub_1'),
  'c6000000-0000-4000-8000-000000000001', 'its subject is unchanged');
select ok(not pg_temp.entitled('c6000000-0000-4000-8000-000000000002'), 'and the other account got nothing');

select is(pg_temp.apply('sub_2', 'cus_1', 'c6000000-0000-4000-8000-000000000002', 'active', -60, 2592000, false, null, 0),
  'applied', 'another subscription naming someone else''s customer is stored for its own subject');
select is(
  (select array_agg(subject_id::text order by subject_id) from app.billing_customers where provider = 'fake' and provider_customer_id = 'cus_1'),
  array['c6000000-0000-4000-8000-000000000001'], 'but a customer is never re-mapped to another subject');

select throws_ok($$select pg_temp.apply('sub_x', 'cus_x', 'c6000000-0000-4000-8000-000000000003', 'lifetime', 0, 60, false, null, 0)$$,
  '22023', null, 'an unknown status is refused');
select throws_ok($$select app.apply_subscription_state('fake', 'sub_x', 'cus_x', 'user', 'c6000000-0000-4000-8000-000000000003', 'team', 'month',
                     'active', now(), now() + interval '1 day', false, null, null, now())$$, '22023', null, 'a plan other than pro is refused');
select throws_ok($$select app.apply_subscription_state('fake', 'sub_x', 'cus_x', 'workspace', 'c6000000-0000-4000-8000-000000000003', 'pro', 'month',
                     'active', now(), now() + interval '1 day', false, null, null, now())$$, '22023', null, 'a subject type other than user is refused');
select throws_ok($$select app.apply_subscription_state('fake', 'sub_x', 'cus_x', 'user', 'c6000000-0000-4000-8000-000000000003', 'pro', 'month',
                     'active', now(), now() + interval '1 day', false, null, null, null)$$, '22023', null, 'provider_updated_at is required');

-- ---------------------------------------------------------------------------
-- Grace (D4-21, B9): 7 days from the recorded failure, never extended within a period
-- ---------------------------------------------------------------------------
select is(pg_temp.apply('sub_g', 'cus_g', 'c6000000-0000-4000-8000-000000000003', 'active', -86400, 2505600, false, null, -7200),
  'applied', 'grace fixture: active');
select is(pg_temp.apply('sub_g', 'cus_g', 'c6000000-0000-4000-8000-000000000003', 'past_due', -86400, 2505600, false, null, -3600),
  'applied', 'a failed payment');
select is((select grace_until from app.subscriptions where provider_subscription_id = 'sub_g'),
  now() - interval '1 hour' + interval '7 days', 'with no dunning end from the provider, grace is 7 days from the failure');
select ok(pg_temp.entitled('c6000000-0000-4000-8000-000000000003'), 'Pro during grace');
select is(pg_temp.apply('sub_g', 'cus_g', 'c6000000-0000-4000-8000-000000000003', 'past_due', -86400, 2505600, false, null, -60),
  'unchanged', 'another failure in the same period');
select is((select grace_until from app.subscriptions where provider_subscription_id = 'sub_g'),
  now() - interval '1 hour' + interval '7 days', 'does not extend grace (B9)');
select is(pg_temp.apply('sub_g', 'cus_g', 'c6000000-0000-4000-8000-000000000003', 'past_due', -86400, 2505600, false, 2592000, -30),
  'unchanged', 'a later dunning end from the provider in the same period');
select is((select grace_until from app.subscriptions where provider_subscription_id = 'sub_g'),
  now() - interval '1 hour' + interval '7 days', 'does not extend it either');
select is(pg_temp.apply('sub_g', 'cus_g', 'c6000000-0000-4000-8000-000000000003', 'active', -86400, 2505600, false, null, -20),
  'applied', 'the retry succeeds');
select is((select grace_until from app.subscriptions where provider_subscription_id = 'sub_g'), null, 'grace is cleared');
select is(pg_temp.apply('sub_g', 'cus_g', 'c6000000-0000-4000-8000-000000000003', 'past_due', 2505600, 5097600, false, null, -10),
  'applied', 'a failure in the next period');
select is((select grace_until from app.subscriptions where provider_subscription_id = 'sub_g'),
  now() - interval '10 seconds' + interval '7 days', 'starts a new grace');
select is(pg_temp.apply('sub_h', 'cus_h', 'c6000000-0000-4000-8000-000000000004', 'past_due', -86400, 2505600, false, 259200, -10),
  'applied', 'a past_due state with the provider''s dunning end');
select is((select grace_until from app.subscriptions where provider_subscription_id = 'sub_h'), now() + interval '3 days',
  'uses the provider''s dunning end');
select is(pg_temp.apply('sub_h', 'cus_h', 'c6000000-0000-4000-8000-000000000004', 'past_due', -864000, 1728000, false, -1, -5),
  'applied', 'a grace that already ended');
select ok(not pg_temp.entitled('c6000000-0000-4000-8000-000000000004'), 'means Free (no job needed: resolution compares with now())');
select is(pg_temp.apply('sub_g', 'cus_g', 'c6000000-0000-4000-8000-000000000003', 'canceled', 2505600, 0, false, null, -5),
  'applied', 'an immediate cancel (period end = now)');
select ok(not pg_temp.entitled('c6000000-0000-4000-8000-000000000003'), 'is Free at once');

-- ---------------------------------------------------------------------------
-- The event log (B3, B5): idempotent, failures retried, concurrent holders
-- ---------------------------------------------------------------------------
create temp table ev (step text, event_id bigint, outcome text) on commit drop;
insert into ev select 'first', * from app.record_billing_event('fake', 'evt_1', 'subscription.updated', now(), '{"status": "active"}');
select is((select outcome from ev where step = 'first'), 'new', 'a first delivery is new');
select is(
  (select row(status, attempts, locked_until > now(), payload ->> 'status')::text from app.billing_events where provider_event_id = 'evt_1'),
  row('received', 1, true, 'active')::text, 'stored as received, held by this delivery');
insert into ev select 'concurrent', * from app.record_billing_event('fake', 'evt_1', 'subscription.updated', now(), '{}');
select is((select outcome from ev where step = 'concurrent'), 'duplicate', 'a concurrent delivery of the same event is a duplicate');
select ok(app.lock_billing_event((select event_id from ev where step = 'first')), 'the processing transaction can lock a received event');
select app.finish_billing_event((select event_id from ev where step = 'first'), 'failed', 'provider_http_503');
select is((select row(status, processed_at, error, locked_until)::text from app.billing_events where provider_event_id = 'evt_1'),
  row('failed', null::timestamptz, 'provider_http_503', null::timestamptz)::text, 'a failure keeps an error code and releases the event');
insert into ev select 'retry', * from app.record_billing_event('fake', 'evt_1', 'subscription.updated', now(), '{}');
select is((select row(outcome, (select attempts from app.billing_events where provider_event_id = 'evt_1'))::text from ev where step = 'retry'),
  row('retry', 2)::text, 'the provider''s retry takes it again (attempt 2)');
select app.finish_billing_event((select event_id from ev where step = 'first'), 'processed', null, 'user', 'c6000000-0000-4000-8000-000000000001');
select is((select row(status, processed_at is not null, error, subject_id::text)::text from app.billing_events where provider_event_id = 'evt_1'),
  row('processed', true, null::text, 'c6000000-0000-4000-8000-000000000001')::text, 'processed with its subject');
select ok(not app.lock_billing_event((select event_id from ev where step = 'first')), 'a finished event can''t be locked for processing again');
insert into ev select 'after', * from app.record_billing_event('fake', 'evt_1', 'subscription.updated', now(), '{}');
select is((select outcome from ev where step = 'after'), 'duplicate', 'a delivery after processing is a duplicate (B3)');
insert into ev select 'crash', * from app.record_billing_event('fake', 'evt_2', 'payment.failed', now(), '{}');
update app.billing_events set locked_until = now() - interval '1 second' where provider_event_id = 'evt_2';
insert into ev select 'takeover', * from app.record_billing_event('fake', 'evt_2', 'payment.failed', now(), '{}');
select is((select outcome from ev where step = 'takeover'), 'retry', 'an event whose holder crashed is taken over once its hold ends');
select throws_ok($$select app.finish_billing_event(1, 'done')$$, '22023', null, 'an unknown final status is refused');
select throws_ok($$select app.finish_billing_event(-1, 'processed')$$, '22023', null, 'an unknown event is refused');

-- ---------------------------------------------------------------------------
-- Lost disputes (D4-21, B7): once per dispute; the second restricts uploads
-- ---------------------------------------------------------------------------
select is(app.record_billing_dispute('fake', 'dp_1', 'sub_d', 'user', 'c6000000-0000-4000-8000-000000000005'), 1, 'a first lost dispute counts 1');
select is((select row(billing_dispute_count, upload_restricted)::text from app.user_flags where user_id = 'c6000000-0000-4000-8000-000000000005'),
  row(1, false)::text, 'one is recorded, uploads stay open');
select is(app.record_billing_dispute('fake', 'dp_1', 'sub_d', 'user', 'c6000000-0000-4000-8000-000000000005'), null,
  'the same dispute reported again isn''t counted twice');
select is(app.record_billing_dispute('fake', 'dp_2', 'sub_d', 'user', 'c6000000-0000-4000-8000-000000000005'), 2, 'a second dispute counts 2');
select is((select row(billing_dispute_count, upload_restricted)::text from app.user_flags where user_id = 'c6000000-0000-4000-8000-000000000005'),
  row(2, true)::text, 'and restricts uploads for review (07 §6.2)');
select is(
  (select array_agg(action order by id) from app.audit_events where target_id = 'c6000000-0000-4000-8000-000000000005'),
  array['billing.dispute_lost', 'billing.dispute_lost', 'billing.upload_restricted'], 'each is audited');
select is(app.record_billing_dispute('fake', 'dp_3', 'sub_z', 'user', 'c6000000-0000-4000-8000-0000000000ff'), null,
  'a dispute of a deleted account counts against no flag row');
select is((select subject_id::text from app.billing_disputes where provider_dispute_id = 'dp_3'), 'c6000000-0000-4000-8000-0000000000ff',
  'but is kept with the billing records');

-- ---------------------------------------------------------------------------
-- Reconciliation bookkeeping (§17.7.7)
-- ---------------------------------------------------------------------------
delete from app.job_heartbeats where job = 'billing-reconcile';
select is((select row(started, updated_since)::text from app.begin_billing_reconcile()), row(true, null::timestamptz)::text,
  'a first run starts and lists everything');
select is((select started from app.begin_billing_reconcile()), false, 'a second run waits while the first holds it');
select app.finish_billing_reconcile(true, '{"listed": 3}');
select is((select row(last_succeeded_at is not null, last_result ->> 'listed')::text from app.job_heartbeats where job = 'billing-reconcile'),
  row(true, '3')::text, 'finishing records the heartbeat with counts');
update app.job_heartbeats set last_succeeded_at = now() - interval '1 day', last_started_at = now() - interval '25 hours' where job = 'billing-reconcile';
select is((select row(started, updated_since)::text from app.begin_billing_reconcile()), row(true, now() - interval '2 days')::text,
  'the next run lists changes since the last success minus a day');
update app.job_heartbeats set last_started_at = now() - interval '16 minutes' where job = 'billing-reconcile';
select is((select started from app.begin_billing_reconcile()), true, 'a run that never finished stops holding it after 15 minutes');

-- ---------------------------------------------------------------------------
-- The daily trigger (D4-22), the runner and the schedule
-- ---------------------------------------------------------------------------
select is(app.trigger_billing_reconcile(), '{"posted": false, "reason": "disabled"}'::jsonb,
  'nothing is posted while billing isn''t live (the billing_reconcile flag is off by default)');
update app.runtime_flags set enabled = true where key = 'billing_reconcile';
create temp table posts (n int) on commit drop;
insert into posts select count(*) from net.http_request_queue where url = 'http://host.docker.internal:3000/api/v1/internal/billing/reconcile';
select is(app.trigger_billing_reconcile(), '{"posted": true}'::jsonb, 'live: the trigger posts');
select is(
  (select array[(count(*) - (select n from posts))::text,
                bool_and(headers ->> 'Authorization' = 'Bearer local-only-billing-reconcile-secret-00000000000001')::text]
     from net.http_request_queue where url = 'http://host.docker.internal:3000/api/v1/internal/billing/reconcile'),
  array['1', 'true'], 'one request queued for pg_net, with the Vault secret as its bearer token');
select lives_ok($$select app.run_job('trigger-billing-reconcile')$$, 'the job runner knows the job');
select ok((select last_succeeded_at is not null from app.job_heartbeats where job = 'trigger-billing-reconcile'), 'and records its run');
delete from vault.secrets where name = 'billing_reconcile_secret';
select app.run_job('trigger-billing-reconcile');
select is((select last_error from app.job_heartbeats where job = 'trigger-billing-reconcile'), 'P0001 missing_secret',
  'live without its Vault secret: a failed run, reported by /health/cron');
select is(
  (select jobname || ' ' || schedule || ' ' || command from cron.job where jobname = 'trigger-billing-reconcile' and active),
  'trigger-billing-reconcile 16 5 * * * select app.run_job(''trigger-billing-reconcile'')', 'scheduled daily through the runner');

-- ---------------------------------------------------------------------------
-- Health (§17.7.5): billingWebhooks and billingReconcile
-- ---------------------------------------------------------------------------
update app.billing_events set status = 'processed' where status = 'failed';
select is(app.cron_health(false) -> 'checks' ->> 'billingWebhooks', 'ok', 'no failed events: ok');
insert into app.billing_events (provider, provider_event_id, event_type, status, received_at)
values ('fake', 'evt_failing', 'payment.failed', 'failed', now() - interval '10 minutes');
select is(app.cron_health(false) -> 'checks' ->> 'billingWebhooks', 'ok', 'a recent failure is still being retried');
update app.billing_events set received_at = now() - interval '61 minutes' where provider_event_id = 'evt_failing';
select is(app.cron_health(false) -> 'checks' ->> 'billingWebhooks', 'failing', 'an event failed for over an hour is reported');
select is(app.cron_health(false) ->> 'status', 'degraded', 'and degrades the status');
update app.runtime_flags set enabled = false where key = 'billing_reconcile';
select is(app.cron_health(false) -> 'checks' ->> 'billingReconcile', 'not_required', 'reconciliation isn''t expected where billing isn''t live');
update app.runtime_flags set enabled = true, updated_at = now() where key = 'billing_reconcile';
delete from app.job_heartbeats where job = 'billing-reconcile';
select is(app.cron_health(false) -> 'checks' ->> 'billingReconcile', 'pending', 'just turned on and not run yet: pending');
update app.runtime_flags set updated_at = now() - interval '3 days' where key = 'billing_reconcile';
select is(app.cron_health(false) -> 'checks' ->> 'billingReconcile', 'stale', 'live for 2 days without a successful run: stale');
select app.finish_billing_reconcile(true, '{}');
select is(app.cron_health(false) -> 'checks' ->> 'billingReconcile', 'ok', 'a recent success: ok');
update app.job_heartbeats set last_succeeded_at = now() - interval '49 hours' where job = 'billing-reconcile';
select is(app.cron_health(false) -> 'checks' ->> 'billingReconcile', 'stale', 'no success for 2 days: stale (B12)');

-- ---------------------------------------------------------------------------
-- purge-ephemeral: checkouts expire after 24 hours and go after 30 days; events at their retention date
-- ---------------------------------------------------------------------------
insert into app.billing_checkouts (id, subject_type, subject_id, provider, plan, billing_interval, status, created_at, expires_at) values
  ('c6c00000-0000-4000-8000-000000000001', 'user', 'c6000000-0000-4000-8000-000000000006', 'fake', 'pro', 'month', 'created',
   now() - interval '25 hours', now() - interval '1 hour'),
  ('c6c00000-0000-4000-8000-000000000002', 'user', 'c6000000-0000-4000-8000-000000000006', 'fake', 'pro', 'month', 'completed',
   now() - interval '31 days', now() - interval '30 days'),
  ('c6c00000-0000-4000-8000-000000000003', 'user', 'c6000000-0000-4000-8000-000000000006', 'fake', 'pro', 'year', 'created',
   now() - interval '1 hour', now() + interval '23 hours');
insert into app.billing_events (provider, provider_event_id, event_type, status, retention_until)
values ('fake', 'evt_old', 'subscription.updated', 'processed', now() - interval '1 second');
select app.purge_ephemeral();
select is(
  (select array_agg(id::text || ':' || status order by id) from app.billing_checkouts where subject_id = 'c6000000-0000-4000-8000-000000000006'),
  array['c6c00000-0000-4000-8000-000000000001:expired', 'c6c00000-0000-4000-8000-000000000003:created'],
  'an unfinished checkout expires after 24 hours, and checkouts are deleted after 30 days');
select is((select count(*)::int from app.billing_events where provider_event_id = 'evt_old'), 0, 'events go at their retention date');

select * from finish();
rollback;
