-- Phase 4C: the provider-neutral billing core (phase 4 §17.7, §17.10, §17.12; task P4-12).
--
-- Pro comes only from verified provider state. The web app's webhook pipeline verifies a provider's
-- signature over the raw body, stores the event once (idempotency), fetches the subscription from the
-- provider (fetch-on-event: the payload's own state is never applied) and writes it through
-- app.apply_subscription_state, which locks the row and refuses an older provider state
-- (provider_updated_at). Daily reconciliation repairs whatever webhooks missed. Nothing a browser
-- sends, no redirect parameter and no checkout row grants Pro: app.entitlement_state (4B) reads
-- subscriptions only.
--
--   app.billing_customers   subject ↔ provider customer; read-only for the app, written only by
--                           apply_subscription_state (never re-pointed to another subject)
--   app.billing_checkouts   our checkout attempts; the checkoutRef in the provider's custom data
--   app.billing_events      the idempotent webhook log; read-only for the app, written only by the
--                           functions below
--   app.billing_disputes    lost disputes, one row per provider dispute (counted once, D4-21)
--   app.subscriptions       (4B) gains synced_at: when the provider last confirmed the row
--   app.user_flags          gains billing_dispute_count (D4-21: a second lost dispute restricts uploads)
--
-- No provider is chosen (Q-005). The functions take provider-neutral values; the adapter maps its
-- provider's states to the internal statuses (07 §6.3).

-- ---------------------------------------------------------------------------
-- Tables and columns
-- ---------------------------------------------------------------------------
set role app_owner;

-- When the provider last confirmed this row (a webhook's fetch or reconciliation). Reconciliation
-- refetches entitled subscriptions not confirmed for 36 hours (§17.7.7).
alter table app.subscriptions add column synced_at timestamptz not null default now();

alter table app.user_flags
  add column billing_dispute_count integer not null default 0 check (billing_dispute_count >= 0);

-- §17.12.1. No foreign key to the user: kept for accounting after an account is deleted.
create table app.billing_customers (
  subject_type text not null check (subject_type in ('user')),
  subject_id uuid not null,
  provider text not null check (provider ~ '^[a-z0-9_]{2,32}$'),
  provider_customer_id text not null check (char_length(provider_customer_id) between 1 and 255),
  created_at timestamptz not null default now(),
  primary key (subject_type, subject_id, provider),
  constraint billing_customers_provider_id unique (provider, provider_customer_id)
);

-- One row per checkout the app started; its id is the checkoutRef the provider carries back.
create table app.billing_checkouts (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('user')),
  subject_id uuid not null,
  provider text not null check (provider ~ '^[a-z0-9_]{2,32}$'),
  plan text not null check (plan in ('pro')),
  billing_interval text not null check (billing_interval in ('month', 'year')),
  provider_checkout_id text check (char_length(provider_checkout_id) between 1 and 255),
  status text not null default 'created' check (status in ('created', 'completed', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  constraint billing_checkouts_provider_checkout unique (provider, provider_checkout_id)
);
create index billing_checkouts_subject_idx on app.billing_checkouts (subject_type, subject_id, created_at desc);
create index billing_checkouts_created_idx on app.billing_checkouts (created_at);

-- The webhook log (§17.7.5): one row per provider event. The payload is minimized by the app (IDs,
-- status, period, amount, currency); never the raw body, emails, addresses or card data.
create table app.billing_events (
  id bigint generated always as identity primary key,
  provider text not null check (provider ~ '^[a-z0-9_]{2,32}$'),
  provider_event_id text not null check (char_length(provider_event_id) between 1 and 255),
  event_type text not null check (char_length(event_type) between 1 and 100),
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received'
    check (status in ('received', 'processed', 'ignored_stale', 'ignored_unknown', 'rejected', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  -- The delivery processing the event holds it until then; a concurrent delivery of the same event
  -- is answered as a duplicate, and a delivery after a crash may take it over.
  locked_until timestamptz,
  error text check (char_length(error) <= 200),
  subject_type text check (subject_type in ('user')),
  subject_id uuid,
  payload jsonb not null default '{}'::jsonb,
  retention_until timestamptz not null default (now() + interval '400 days'),
  constraint billing_events_provider_event unique (provider, provider_event_id),
  constraint billing_events_subject check ((subject_type is null) = (subject_id is null))
);
create index billing_events_open_idx on app.billing_events (status, received_at) where status in ('received', 'failed');
create index billing_events_retention_idx on app.billing_events (retention_until);

-- Lost disputes, confirmed with the provider (B7, B14): one row per provider dispute, so a dispute
-- counts once however many events report it. No foreign key: kept with the billing records.
create table app.billing_disputes (
  provider text not null check (provider ~ '^[a-z0-9_]{2,32}$'),
  provider_dispute_id text not null check (char_length(provider_dispute_id) between 1 and 255),
  provider_subscription_id text check (char_length(provider_subscription_id) between 1 and 255),
  subject_type text not null check (subject_type in ('user')),
  subject_id uuid not null,
  lost_at timestamptz not null default now(),
  primary key (provider, provider_dispute_id)
);
create index billing_disputes_subject_idx on app.billing_disputes (subject_type, subject_id);

-- Off until billing is live in an environment (no provider before Q-005 and P4-13). While off, the
-- daily trigger posts nothing and /health/cron doesn't expect reconciliation runs.
insert into app.runtime_flags (key, enabled, value, note) values
  ('billing_reconcile', false, '{}',
   'Billing is live here: the daily trigger-billing-reconcile job posts to the web app, and /health/cron reports billingReconcile stale after 2 days without a successful run')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- The event log (§17.7.5 steps 5, 8, 9). Definer functions: the app can read the log but not
-- write it directly.
--
-- record_billing_event: the idempotent insert.
--   new        first delivery: stored, held for 2 minutes by this delivery
--   retry      a delivery of an event that failed before (or whose holder crashed): taken over
--   duplicate  already finished, or held by a concurrent delivery: answer 200, do nothing
-- ---------------------------------------------------------------------------
create function app.record_billing_event(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_payload jsonb
)
returns table (event_id bigint, outcome text)
language plpgsql security definer set search_path = ''
as $$
declare
  v_id bigint;
  v_row app.billing_events;
begin
  insert into app.billing_events as e (provider, provider_event_id, event_type, occurred_at, payload, attempts, locked_until)
  values (p_provider, p_provider_event_id, left(p_event_type, 100), p_occurred_at, coalesce(p_payload, '{}'::jsonb), 1,
          now() + interval '2 minutes')
  on conflict (provider, provider_event_id) do nothing
  returning e.id into v_id;
  if v_id is not null then
    return query select v_id, 'new'::text;
    return;
  end if;

  select * into v_row from app.billing_events e
   where e.provider = p_provider and e.provider_event_id = p_provider_event_id
     for update;
  if v_row.status = 'failed' or (v_row.status = 'received' and coalesce(v_row.locked_until, '-infinity') <= now()) then
    update app.billing_events e
       set attempts = e.attempts + 1, status = 'received', error = null, locked_until = now() + interval '2 minutes'
     where e.id = v_row.id;
    return query select v_row.id, 'retry'::text;
  else
    return query select v_row.id, 'duplicate'::text;
  end if;
end
$$;

-- Taken inside the transaction that applies an event: locks its row while it is still being
-- processed. False when another delivery finished it meanwhile (then nothing is applied twice).
create function app.lock_billing_event(p_id bigint)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  perform 1 from app.billing_events e where e.id = p_id and e.status = 'received' for update;
  return found;
end
$$;

create function app.finish_billing_event(
  p_id bigint,
  p_status text,
  p_error text default null,
  p_subject_type text default null,
  p_subject_id uuid default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_status is null or p_status not in ('processed', 'ignored_stale', 'ignored_unknown', 'rejected', 'failed') then
    raise exception 'invalid billing event status' using errcode = '22023';
  end if;
  update app.billing_events e
     set status = p_status,
         processed_at = case when p_status = 'failed' then null else now() end,
         locked_until = null,
         error = left(p_error, 200),
         subject_type = coalesce(p_subject_type, e.subject_type),
         subject_id = coalesce(p_subject_id, e.subject_id)
   where e.id = p_id;
  if not found then
    raise exception 'unknown billing event' using errcode = '22023';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- apply_subscription_state (§17.7.5 step 7, B4, B9): the only writer of app.subscriptions.
-- Called with the provider's authoritative state (fetched, never a webhook payload's own copy).
--   applied           inserted, or a newer state written (audited; account.changed is sent)
--   unchanged         the same state again (a duplicate or a replay): nothing written but synced_at
--   stale             older than the stored state (provider_updated_at): ignored
--   subject_mismatch  the row belongs to another subject: never re-pointed
-- Grace (D4-21): the provider's dunning end, else 7 days from the failure the provider recorded.
-- Repeated failures in one period never extend it (B9); a new period's failure starts a new one.
-- ---------------------------------------------------------------------------
create function app.apply_subscription_state(
  p_provider text,
  p_provider_subscription_id text,
  p_customer_id text,
  p_subject_type text,
  p_subject_id uuid,
  p_plan text,
  p_interval text,
  p_status text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_canceled_at timestamptz,
  p_grace_until timestamptz,
  p_provider_updated_at timestamptz
)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_old app.subscriptions;
  v_id uuid;
  v_grace timestamptz;
begin
  if p_subject_type is distinct from 'user' or p_subject_id is null then
    raise exception 'invalid subject' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('trialing', 'active', 'past_due', 'paused', 'canceled', 'expired') then
    raise exception 'invalid subscription status' using errcode = '22023';
  end if;
  if p_plan is distinct from 'pro' or p_interval is null or p_interval not in ('month', 'year') then
    raise exception 'invalid plan or interval' using errcode = '22023';
  end if;
  if p_provider_updated_at is null or p_cancel_at_period_end is null then
    raise exception 'provider_updated_at and cancel_at_period_end are required' using errcode = '22023';
  end if;

  select * into v_old from app.subscriptions s
   where s.provider = p_provider and s.provider_subscription_id = p_provider_subscription_id
     for update;
  if v_old.id is not null then
    if v_old.subject_type <> p_subject_type or v_old.subject_id <> p_subject_id then
      return 'subject_mismatch';
    end if;
    if p_provider_updated_at < v_old.provider_updated_at then
      update app.subscriptions set synced_at = now() where id = v_old.id;
      return 'stale';
    end if;
  end if;

  if p_status = 'past_due' then
    v_grace := coalesce(p_grace_until, p_provider_updated_at + interval '7 days');
    if v_old.status = 'past_due' and v_old.current_period_start is not distinct from p_period_start then
      v_grace := least(v_grace, v_old.grace_until);
    end if;
  end if;

  -- A customer maps to one subject, first come; it is never moved (B13).
  insert into app.billing_customers (subject_type, subject_id, provider, provider_customer_id)
  values (p_subject_type, p_subject_id, p_provider, p_customer_id)
  on conflict do nothing;

  if v_old.id is null then
    insert into app.subscriptions (provider, provider_subscription_id, provider_customer_id, subject_type, subject_id, plan,
                                   billing_interval, status, current_period_start, current_period_end, cancel_at_period_end,
                                   canceled_at, grace_until, provider_updated_at)
    values (p_provider, p_provider_subscription_id, p_customer_id, p_subject_type, p_subject_id, p_plan, p_interval, p_status,
            p_period_start, p_period_end, p_cancel_at_period_end, p_canceled_at, v_grace, p_provider_updated_at)
    on conflict (provider, provider_subscription_id) do nothing
    returning id into v_id;
    if v_id is null then
      -- A concurrent call inserted it first: apply against that row.
      return app.apply_subscription_state(p_provider, p_provider_subscription_id, p_customer_id, p_subject_type, p_subject_id,
                                          p_plan, p_interval, p_status, p_period_start, p_period_end, p_cancel_at_period_end,
                                          p_canceled_at, p_grace_until, p_provider_updated_at);
    end if;
    insert into app.audit_events (actor_kind, action, target_type, target_id, metadata)
    values ('system', 'billing.subscription_changed', 'user', p_subject_id::text,
            jsonb_build_object('provider', p_provider, 'subscriptionId', v_id, 'from', null, 'to', p_status,
                               'interval', p_interval, 'cancelAtPeriodEnd', p_cancel_at_period_end));
    return 'applied';
  end if;

  if (v_old.provider_customer_id, v_old.billing_interval, v_old.status, v_old.current_period_start, v_old.current_period_end,
      v_old.cancel_at_period_end, v_old.canceled_at, v_old.grace_until)
     is not distinct from
     (p_customer_id, p_interval, p_status, p_period_start, p_period_end, p_cancel_at_period_end, p_canceled_at, v_grace) then
    update app.subscriptions
       set synced_at = now(), provider_updated_at = p_provider_updated_at
     where id = v_old.id;
    return 'unchanged';
  end if;

  update app.subscriptions
     set provider_customer_id = p_customer_id,
         billing_interval = p_interval,
         status = p_status,
         current_period_start = p_period_start,
         current_period_end = p_period_end,
         cancel_at_period_end = p_cancel_at_period_end,
         canceled_at = p_canceled_at,
         grace_until = v_grace,
         provider_updated_at = p_provider_updated_at,
         updated_at = now(),
         synced_at = now()
   where id = v_old.id;
  insert into app.audit_events (actor_kind, action, target_type, target_id, metadata)
  values ('system', 'billing.subscription_changed', 'user', p_subject_id::text,
          jsonb_build_object('provider', p_provider, 'subscriptionId', v_old.id, 'from', v_old.status, 'to', p_status,
                             'interval', p_interval, 'cancelAtPeriodEnd', p_cancel_at_period_end));
  return 'applied';
end
$$;

-- ---------------------------------------------------------------------------
-- A lost dispute (D4-21, B7), already confirmed with the provider by the caller: recorded once per
-- provider dispute; each new one adds to the account's billing_dispute_count, and a second restricts
-- uploads for review (07 §6.2). The subscription itself is cancelled at the provider and re-synced by
-- the caller. Returns the new count, or null when the dispute was already counted (or the account no
-- longer exists: the dispute row stays, the flag can't).
-- ---------------------------------------------------------------------------
create function app.record_billing_dispute(
  p_provider text,
  p_dispute_id text,
  p_subscription_id text,
  p_subject_type text,
  p_subject_id uuid
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_inserted boolean;
  v_count integer;
begin
  if p_subject_type is distinct from 'user' or p_subject_id is null then
    raise exception 'invalid subject' using errcode = '22023';
  end if;
  insert into app.billing_disputes (provider, provider_dispute_id, provider_subscription_id, subject_type, subject_id)
  values (p_provider, p_dispute_id, p_subscription_id, p_subject_type, p_subject_id)
  on conflict do nothing
  returning true into v_inserted;
  if v_inserted is null then
    return null;
  end if;
  begin
    insert into app.user_flags as f (user_id, billing_dispute_count, updated_at)
    values (p_subject_id, 1, now())
    on conflict (user_id) do update set billing_dispute_count = f.billing_dispute_count + 1, updated_at = now()
    returning f.billing_dispute_count into v_count;
  exception when foreign_key_violation then
    return null;
  end;
  insert into app.audit_events (actor_kind, action, target_type, target_id, metadata)
  values ('system', 'billing.dispute_lost', 'user', p_subject_id::text, jsonb_build_object('provider', p_provider, 'disputes', v_count));
  if v_count >= 2 then
    update app.user_flags set upload_restricted = true, updated_at = now()
     where user_id = p_subject_id and not upload_restricted;
    if found then
      insert into app.audit_events (actor_kind, action, target_type, target_id, metadata)
      values ('system', 'billing.upload_restricted', 'user', p_subject_id::text, jsonb_build_object('disputes', v_count));
    end if;
  end if;
  return v_count;
end
$$;

-- ---------------------------------------------------------------------------
-- Reconciliation bookkeeping for the web app's reconcile route (§17.7.7): one run at a time (a run
-- that started less than 15 minutes ago and hasn't finished holds it), and the heartbeat
-- 'billing-reconcile' that /health/cron reads. updated_since is the last success minus a day (null
-- before the first: list everything).
-- ---------------------------------------------------------------------------
create function app.begin_billing_reconcile()
returns table (started boolean, updated_since timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare
  v_beat app.job_heartbeats;
begin
  insert into app.job_heartbeats (job) values ('billing-reconcile') on conflict (job) do nothing;
  select * into v_beat from app.job_heartbeats h where h.job = 'billing-reconcile' for update;
  if v_beat.last_started_at is not null
     and v_beat.last_started_at > greatest(coalesce(v_beat.last_succeeded_at, '-infinity'), coalesce(v_beat.last_failed_at, '-infinity'))
     and v_beat.last_started_at > now() - interval '15 minutes' then
    return query select false, null::timestamptz;
    return;
  end if;
  update app.job_heartbeats h set last_started_at = now(), updated_at = now() where h.job = 'billing-reconcile';
  return query select true, v_beat.last_succeeded_at - interval '1 day';
end
$$;

create function app.finish_billing_reconcile(p_ok boolean, p_result jsonb, p_error text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform app.record_job_run('billing-reconcile', coalesce(p_ok, false), coalesce(p_result, '{}'::jsonb), p_error);
end
$$;

-- ---------------------------------------------------------------------------
-- purge-ephemeral (every 10 min), Phase 4C version: checkouts never completed expire after 24 hours
-- and every checkout is deleted after 30 days (§17.12.1); webhook log rows go at their retention
-- date (400 days). Otherwise as Phase 4A.
-- ---------------------------------------------------------------------------
create or replace function app.purge_ephemeral()
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  v_total integer := 0;
  v_n integer;
begin
  delete from app.network_presence where last_seen_at < now() - interval '24 hours';
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app.rate_counters where expires_at < now();
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app.idempotency_keys where expires_at < now();
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app.link_grants where expires_at < now();
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app.link_sessions where expires_at < now() - interval '24 hours';
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  update app.share_links
     set short_code_hmac = null, short_code_pepper_version = null, short_code_expires_at = null
   where short_code_expires_at < now();
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  update app.merge_intents set status = 'expired' where status = 'open' and expires_at <= now();
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app.merge_intents where status <> 'open' and coalesce(completed_at, expires_at) < now() - interval '30 days';
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app.devices where revoked_at < now() - interval '30 days';
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  update app.billing_checkouts set status = 'expired' where status = 'created' and expires_at <= now();
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app.billing_checkouts where created_at < now() - interval '30 days';
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app.billing_events where retention_until < now();
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  return v_total;
end
$$;

-- ---------------------------------------------------------------------------
-- Job health for GET /api/v1/health/cron, Phase 4C version (§17.7.5, §17.12.3). Adds:
--   billingWebhooks   failing: a webhook event has been failed for more than an hour
--   billingReconcile  where billing is live (the billing_reconcile flag): stale after 2 days
--                     without a successful reconciliation; not_required elsewhere
-- Otherwise as Phase 3.
-- ---------------------------------------------------------------------------
create or replace function app.cron_health(p_require_egress boolean)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_beat timestamptz := (select h.last_succeeded_at from app.job_heartbeats h where h.job = 'cron-heartbeat');
  v_janitor timestamptz := (select h.last_succeeded_at from app.job_heartbeats h where h.job = 'storage-janitor');
  v_due integer;
  v_oldest timestamptz;
  v_run app.storage_reconcile_runs;
  v_last_finished timestamptz;
  v_usage app.job_heartbeats;
  v_loaded text;
  v_volume integer;
  v_threshold integer := coalesce((select (f.value ->> 'value')::integer from app.runtime_flags f where f.key = 'janitor_daily_volume_alert'), 10000);
  v_billing app.runtime_flags;
  v_billing_run timestamptz := (select h.last_succeeded_at from app.job_heartbeats h where h.job = 'billing-reconcile');
  v_checks jsonb;
begin
  -- Held rows count until their copy is made: until then R2's lifecycle rules may delete the
  -- original (RISK-031).
  select count(*)::integer, min(od.not_before) into v_due, v_oldest
    from app.object_deletions od
   where od.completed_at is null and od.not_before <= now() and (not od.legal_hold or od.hold_copy is null);
  select * into v_run from app.storage_reconcile_runs r order by r.id desc limit 1;
  v_last_finished := (select max(r.finished_at) from app.storage_reconcile_runs r where r.status = 'finished');
  select * into v_usage from app.job_heartbeats h where h.job = 'reconcile-storage-usage';
  v_loaded := (select f.value ->> 'loadedAt' from app.runtime_flags f where f.key = 'egress_ranges');
  select count(*)::integer into v_volume from app.object_deletions od where od.completed_at > now() - interval '24 hours';
  select * into v_billing from app.runtime_flags f where f.key = 'billing_reconcile';

  v_checks := jsonb_build_object(
    'heartbeat', case when v_beat is null then 'missing' when v_beat < now() - interval '10 minutes' then 'stale' else 'ok' end,
    'janitorBacklog', case
      when v_due > 1000 or v_oldest < now() - interval '1 hour' then 'backlog'
      when v_due > 0 and (v_janitor is null or v_janitor < now() - interval '5 minutes') and v_oldest < now() - interval '5 minutes' then 'stalled'
      else 'ok' end,
    'janitorFailures', case
      when exists (select 1 from app.object_deletions od where od.completed_at is null and od.last_error like 'guard:%') then 'guard_refused'
      when exists (select 1 from app.object_deletions od where od.completed_at is null and od.attempts >= 5) then 'failing'
      else 'ok' end,
    'janitorVolume', case when v_volume > v_threshold then 'unusual' else 'ok' end,
    'burnFinalize', case
      when exists (select 1 from app.shares s where s.status = 'claimed' and s.claim_grace_until < now() - interval '10 minutes') then 'late'
      else 'ok' end,
    'reconcile', case
      when v_run.id is null then 'pending'
      when v_run.status = 'running' and v_run.started_at < now() - interval '24 hours' then 'stale'
      when v_run.status = 'running' and v_last_finished is null then 'pending'
      when coalesce(v_last_finished, v_run.started_at) < now() - interval '8 days' then 'stale'
      else 'ok' end,
    'storageDrift', case
      when v_usage.job is null or v_usage.last_succeeded_at is null then 'pending'
      when v_usage.last_succeeded_at < now() - interval '2 days' then 'stale'
      when coalesce((v_usage.last_result ->> 'drift')::integer, 0) > 0 then 'drift'
      else 'ok' end,
    'egressLists', case
      when not coalesce(p_require_egress, true) then 'not_required'
      when v_loaded is null then 'missing'
      when v_loaded::timestamptz < now() - interval '3 days' then 'stale'
      else 'ok' end,
    'jobs', case
      when exists (select 1 from app.job_heartbeats h
                    where h.last_failed_at is not null and h.last_failed_at > coalesce(h.last_succeeded_at, '-infinity')) then 'failing'
      else 'ok' end,
    'billingWebhooks', case
      when exists (select 1 from app.billing_events e where e.status = 'failed' and e.received_at < now() - interval '1 hour') then 'failing'
      else 'ok' end,
    'billingReconcile', case
      when not coalesce(v_billing.enabled, false) then 'not_required'
      when v_billing_run is null then case when v_billing.updated_at < now() - interval '2 days' then 'stale' else 'pending' end
      when v_billing_run < now() - interval '2 days' then 'stale'
      else 'ok' end);

  return jsonb_build_object(
    'status', case when exists (select 1 from jsonb_each_text(v_checks) c where c.value not in ('ok', 'pending', 'not_required'))
                   then 'degraded' else 'ok' end,
    'checks', v_checks);
end
$$;

reset role;

-- ---------------------------------------------------------------------------
-- account.changed (§17.14): an ID-free signal on the subject's user topic whenever its subscription
-- changes in a way that matters for entitlements; the client refetches /me/entitlements. Owned by
-- the migration role, like the other realtime.send triggers (realtime.messages has RLS).
-- ---------------------------------------------------------------------------
create function app.emit_account_changed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT'
     or (new.status, new.current_period_end, new.cancel_at_period_end, new.grace_until, new.billing_interval, new.plan)
        is distinct from (old.status, old.current_period_end, old.cancel_at_period_end, old.grace_until, old.billing_interval, old.plan) then
    perform realtime.send(jsonb_build_object('v', 1, 'type', 'account.changed'), 'account.changed', 'user:' || new.subject_id::text, true);
  end if;
  return null;
end
$$;

create trigger subscriptions_emit_account_changed
  after insert or update on app.subscriptions
  for each row execute function app.emit_account_changed();

-- ---------------------------------------------------------------------------
-- The daily trigger (D4-22): pg_cron → run_job → this → pg_net POST to the web app's reconcile
-- route with the Vault secret. The provider's API key stays in the web tier, never in the database
-- or an Edge Function (RISK-036). Owned by the migration role (Vault, pg_net), granted to nobody.
-- While the billing_reconcile flag is off it posts nothing; on, a missing Vault secret raises, so
-- run_job records a failed heartbeat.
-- ---------------------------------------------------------------------------
create function app.trigger_billing_reconcile()
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  if not coalesce((select f.enabled from app.runtime_flags f where f.key = 'billing_reconcile'), false) then
    return jsonb_build_object('posted', false, 'reason', 'disabled');
  end if;
  v_url := (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'billing_reconcile_url');
  v_secret := (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'billing_reconcile_secret');
  if v_url is null or v_secret is null then
    raise exception 'missing_secret' using errcode = 'P0001';
  end if;
  perform net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    timeout_milliseconds := 10000);
  return jsonb_build_object('posted', true);
end
$$;

-- ---------------------------------------------------------------------------
-- The job runner, Phase 4C version: adds trigger-billing-reconcile. Otherwise as Phase 3.
-- ---------------------------------------------------------------------------
create or replace function app.run_job(p_job text)
returns void
language plpgsql security invoker set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_job is null or p_job not in ('trigger-storage-janitor', 'finalize-burn-claims', 'purge-tombstones',
                                    'cleanup-anonymous-users', 'reconcile-storage-usage', 'reconcile-r2-orphans',
                                    'cron-heartbeat', 'trigger-billing-reconcile') then
    raise exception 'unknown job' using errcode = '22023';
  end if;
  perform app.job_started(p_job);
  begin
    if p_job = 'trigger-storage-janitor' then
      v_result := jsonb_build_object('delete', app.trigger_storage_janitor('delete'),
                                     'reconcile', app.trigger_storage_janitor('reconcile'));
    elsif p_job = 'finalize-burn-claims' then
      v_result := jsonb_build_object('finalized', app.finalize_claims(500));
    elsif p_job = 'purge-tombstones' then
      v_result := app.purge_tombstones(1000);
    elsif p_job = 'cleanup-anonymous-users' then
      v_result := jsonb_build_object('deleted', app.cleanup_anonymous_users(1000));
    elsif p_job = 'reconcile-storage-usage' then
      v_result := app.reconcile_storage_usage(1000);
    elsif p_job = 'reconcile-r2-orphans' then
      v_result := app.start_storage_reconcile();
    elsif p_job = 'trigger-billing-reconcile' then
      v_result := app.trigger_billing_reconcile();
    else
      v_result := '{}'::jsonb;
    end if;
    perform app.record_job_run(p_job, true, v_result);
  exception when others then
    perform app.record_job_run(p_job, false, '{}'::jsonb, sqlstate || ' ' || left(sqlerrm, 180));
    raise warning 'job % failed: % %', p_job, sqlstate, sqlerrm;
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- RLS and grants (§17.12.4). The app reads customers and the event log, and writes them only
-- through the functions above; checkouts are its own.
-- ---------------------------------------------------------------------------
alter table app.billing_customers enable row level security;
create policy app_server_read on app.billing_customers for select to app_server using (true);
grant select on app.billing_customers to app_server;

alter table app.billing_checkouts enable row level security;
create policy app_server_all on app.billing_checkouts for all to app_server using (true) with check (true);
grant select, insert, update, delete on app.billing_checkouts to app_server;

alter table app.billing_events enable row level security;
create policy app_server_read on app.billing_events for select to app_server using (true);
grant select on app.billing_events to app_server;

alter table app.billing_disputes enable row level security;
create policy app_server_read on app.billing_disputes for select to app_server using (true);
grant select on app.billing_disputes to app_server;

revoke execute on all functions in schema app from public;

grant execute on function
  app.record_billing_event(text, text, text, timestamptz, jsonb),
  app.lock_billing_event(bigint),
  app.finish_billing_event(bigint, text, text, text, uuid),
  app.apply_subscription_state(text, text, text, text, uuid, text, text, text, timestamptz, timestamptz, boolean, timestamptz,
                               timestamptz, timestamptz),
  app.record_billing_dispute(text, text, text, text, uuid),
  app.begin_billing_reconcile(),
  app.finish_billing_reconcile(boolean, jsonb, text)
to app_server;
-- trigger_billing_reconcile and emit_account_changed: granted to nobody (pg_cron runs the job as
-- its owner; the trigger fires as the table's).

-- Daily at 05:16 (offset from the */5 and */10 jobs and from reconcile-r2-orphans at 05:06 on Sundays).
select cron.schedule('trigger-billing-reconcile', '16 5 * * *', $$select app.run_job('trigger-billing-reconcile')$$);
