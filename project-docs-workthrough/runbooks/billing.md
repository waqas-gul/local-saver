# Runbook — Billing: webhooks, reconciliation, support

| Field | Value |
|---|---|
| Applies from | Phase 4C, the provider-neutral billing core (P4-12, 2026-10-17); written in P4-25 (2026-10-18). Built and tested locally only, against the fake provider. |
| What | How Pro is paid for and kept in sync, and what an operator does when a webhook fails, a payment doesn't show, or someone asks for a refund or a cancellation ([phase 4 §20](../phases/phase-4-pro-accounts.md#20-phase-4c-implementation-the-provider-neutral-billing-core-2026-10-17)). |
| Tools | The MFA-protected Supabase dashboard (SQL editor, as the project's database owner); the provider's dashboard (MFA required, B15); the host's logs. The app has no operator console (D4-23). |
| Owner | Operator on call: **[OWNER: name and email, Q-022]** |
| Rehearsed | **No.** There is no provider yet (**Q-005**): no adapter (P4-13), no sandbox, no real transaction (AC-4.3). Steps that name the provider's dashboard are generic until then. |
| Open decisions | Q-005 (provider, entity, tax), Q-006 (prices: the pages show `[OWNER: price]`), Q-026; D4-21 (hosted checkout, 7-day grace, a full refund ends Pro, a second lost dispute restricts uploads) and D4-22 (reconciliation through pg_net) are built as recommended and wait for the owner; the refund policy (legal pages). |

## 1. How it works

- **Pro comes only from the provider's state.** Nothing a browser sends, no redirect parameter and no checkout row grants Pro. `app.entitlement_state` reads `app.subscriptions`, and only `app.apply_subscription_state` writes it, always with the state **fetched from the provider** (fetch-on-event), never a webhook body's copy.
- **Checkout** (`POST /api/v1/billing/checkout`, an `Idempotency-Key` required): the account gets the provider's hosted checkout. Refused while the account already has an entitling subscription (`409 ALREADY_SUBSCRIBED`) or is being deleted (`403 ACCOUNT_DELETION_PENDING`). The return page only polls `GET /me/entitlements`. **Portal** (`POST /api/v1/billing/portal`): the provider's page for card changes, cancellation and invoices.
- **Webhook** (`POST /api/v1/billing/webhook`, `withWebhook`: no session or Origin):

  | Step | Result |
  |---|---|
  | The signature over the raw body (current or previous secret) and its timestamp fail | `400`, nothing stored; log `billing.webhook_rejected` |
  | The verified body can't be read | Stored as `rejected`, `200` (the provider must not retry a poison event); log `billing.webhook_invalid` |
  | The event was already finished, or another delivery holds it | `200`, nothing done (`duplicate`) |
  | Otherwise | Stored once per (provider, event ID). The subscription is fetched from the provider and applied in one transaction: `processed`, `ignored_stale` (older than what we have) or `ignored_unknown`; `200` |
  | Anything unexpected | The event is `failed`, `500`: the provider retries, and a retry takes the event over |

- **Whose subscription:** our row for it, else our checkout its `checkoutRef` names, else our customer mapping. Otherwise it is **never applied** (log `billing.subject_unknown`). A subscription or customer is never moved to another account (B13).
- **Reconciliation, daily at 05:16 UTC** (`trigger-billing-reconcile` → pg_net → `POST /api/v1/internal/billing/reconcile` with the Vault bearer secret; the work runs after the `202`). It applies every subscription the provider changed since the last success minus a day, refetches entitled subscriptions the provider hasn't confirmed for 36 hours, and cancels at period end the renewing subscription of an account in its deletion grace. One run at a time. **Off until billing is live** (the `billing_reconcile` runtime flag).
- **Rules (D4-21):**

  | Event | Effect |
  |---|---|
  | Payment fails (`past_due`) | Pro for 7 days of grace (or the provider's dunning end); repeated failures in one period never extend it |
  | Cancelled at period end | Pro until the period ends |
  | Full refund with revocation | The provider ends the subscription: Free |
  | Partial refund | No change |
  | Dispute opened or won | Logged only |
  | Dispute lost (confirmed with the provider) | The subscription is cancelled at once (Free); counted once per dispute; the **second** lost dispute restricts the account's uploads (`billing.upload_restricted`) |

- **Downgrade.** Existing shares keep their snapshot; new actions follow the plan (07 §5).
- **Records** (`subscriptions`, `billing_customers`, `billing_checkouts`, `billing_events`, `billing_disputes`) have no foreign key to the user: they stay after the account is deleted. Event payloads are minimized (IDs, status, period, amount, currency), never the raw body or card data. Events are kept 400 days; checkouts 30 days.
- Audit events: `billing.subscription_changed`, `billing.dispute_lost`, `billing.upload_restricted` (system); `admin.override_granted`, `admin.override_revoked` (operator).

## 2. Health and alerts

`GET /api/v1/health/cron` ([monitoring](monitoring.md)) has two billing checks:

| Check | Fails as | Means | First step |
|---|---|---|---|
| `billingWebhooks` | `failing` | An event has been `failed` for over an hour | §4 |
| `billingReconcile` | `stale` | Where the flag is on: no successful reconciliation for 2 days | §5 |

Logs (IDs, types, statuses and codes only, never bodies): `billing.webhook_rejected` (bad signatures: a spike means probing or a wrong secret), `billing.webhook_invalid`, `billing.webhook_failed`, `billing.subject_unknown`, `billing.subscription_unknown`, `billing.subscription_not_our_plan`, `billing.subject_mismatch`, `billing.reconcile_finished`, `billing.reconcile_failed`, `billing.reconcile_item_failed`.

## 3. Queries

```sql
-- One account: what the app resolves (entitled, the subscription shown, overrides, deletion pending).
select u.id, u.email, s.* from auth.users u, app.entitlement_state(u.id) s where u.email = '<address>';

-- Its subscriptions, newest provider state first.
select provider, provider_subscription_id, status, billing_interval, current_period_end, cancel_at_period_end, grace_until,
       provider_updated_at, synced_at
  from app.subscriptions where subject_type = 'user' and subject_id = '<user id>' order by provider_updated_at desc;

-- Its checkouts, webhook events and disputes.
select id, provider, plan, billing_interval, status, created_at, expires_at
  from app.billing_checkouts where subject_type = 'user' and subject_id = '<user id>' order by created_at desc;
select received_at, provider_event_id, event_type, status, attempts, error
  from app.billing_events where subject_type = 'user' and subject_id = '<user id>' order by received_at desc limit 50;
select provider_dispute_id, provider_subscription_id, lost_at
  from app.billing_disputes where subject_type = 'user' and subject_id = '<user id>';

-- Its billing history in the audit log.
select occurred_at, action, actor_kind, metadata from app.audit_events
 where target_type = 'user' and target_id = '<user id>' and (action like 'billing.%' or action like 'admin.override_%')
 order by occurred_at desc;

-- Events that need attention: failed, or still held long after their delivery.
select id, received_at, provider_event_id, event_type, status, attempts, error
  from app.billing_events
 where status = 'failed' or (status = 'received' and received_at < now() - interval '10 minutes')
 order by received_at;

-- Events applied to nobody in the last week (a subscription we couldn't place).
select received_at, provider_event_id, event_type, error
  from app.billing_events where status = 'ignored_unknown' and received_at > now() - interval '7 days' order by received_at desc;

-- Reconciliation: the flag, the last runs and their counts.
select key, enabled, updated_at, updated_by from app.runtime_flags where key = 'billing_reconcile';
select last_started_at, last_succeeded_at, last_failed_at, last_error, last_result
  from app.job_heartbeats where job in ('billing-reconcile', 'trigger-billing-reconcile');
```

## 4. A failing webhook

1. **Find the events** (§3, "events that need attention"). `error` is a code:
   - `provider_*`: fetching from the provider failed (its API, the API key, a timeout);
   - `processing_error`: our side (look up the event ID in the logs: `billing.webhook_failed`).
2. **Fix the cause.** A wrong or rotated API key: [secret rotation](secret-rotation.md). The provider down: wait. A bug: open an incident ([incident](incident.md)).
3. **Replay.** The app keeps no body to replay, by design. Either:
   - **redeliver** the event from the provider's dashboard: a `failed` event is taken over and processed again; a finished one answers `200` and does nothing; or
   - **let reconciliation repair the state** (§5). It fetches the subscriptions themselves, so a missed event matters only until the next run.
4. **Check** that `billingWebhooks` is `ok` again and the account's subscription row has the provider's state (§3).

**A spike of `billing.webhook_rejected`:**
- right after a secret rotation: the provider still signs with the old secret, which is fine while `BILLING_WEBHOOK_SECRET_PREVIOUS` holds it;
- otherwise: someone is probing the endpoint. Nothing is stored or applied; check the Cloudflare rules for the path (08 §4).

## 5. Reconciliation

**Run it now** (only where the flag is on; it posts to the app, which runs it after answering):

```sql
select app.run_job('trigger-billing-reconcile');
select last_succeeded_at, last_failed_at, last_error, last_result from app.job_heartbeats where job = 'billing-reconcile';
```

- `trigger-billing-reconcile` failing with `missing_secret`: the Vault secrets `billing_reconcile_url` and `billing_reconcile_secret` are missing (§8).
- A `401` in `net._http_response`: the Vault secret and `BILLING_RECONCILE_SECRET` differ ([secret rotation](secret-rotation.md)).
- A run started under 15 minutes ago and not finished holds the next one (the route answers `{"started": false, "reason": "running"}`).
- `last_result` holds counts only: `listed`, `refetched`, `deletionCancels`, `applied`, `unchanged`, `stale`, `unknown`, `errors`. `items_failed` means some items failed and the rest were applied; `provider_failed` means listing failed.

**Refetch one entitled subscription at the next run.** Reconciliation refetches entitled subscriptions the provider hasn't confirmed for 36 hours:

```sql
update app.subscriptions set synced_at = now() - interval '37 hours'
 where provider = '<provider>' and provider_subscription_id = '<subscription id>';
```

**Look further back than a day.** The next run lists what the provider changed since the last success minus a day. To list from an earlier date, move the last success back. It is set again when that run succeeds:

```sql
update app.job_heartbeats set last_succeeded_at = '<date before the missed change>' where job = 'billing-reconcile';
```

**Never write `app.subscriptions`' state, `billing_customers` or `billing_events` by hand.** Only `apply_subscription_state` may write a subscription's state, from the provider's answer (B4, B13). The two updates above change only *when* the next fetch happens.

## 6. Support requests

**"I paid but I'm not Pro."**
1. Check the account (§3): a subscription row in an entitling state means Pro. The open page refetches on `account.changed` (Realtime); otherwise a reload shows it.
2. No row:
   - a checkout `completed` or `created` with no subscription: the webhook hasn't arrived or failed (§4);
   - an `ignored_unknown` event at that time with log `billing.subject_unknown`: the provider's subscription carries no reference we know. That is a bug in the adapter's custom data: open an incident.
3. Fix it with §4 or §5. If the person can't wait, grant Pro with an expiry (§7) and revoke it once the subscription is in.

**"Cancel my subscription."**
- The person cancels in the provider's portal (`/settings/billing` → *Manage billing*). Pro stays until the period ends.
- On request from the account's own address (verify as in [accounts](accounts.md) §3): cancel at period end in the provider's dashboard. The next webhook or reconciliation applies it.

**"Refund me."** Refunds are made in the provider's dashboard under the refund policy (**[OWNER]**, legal pages). A full refund with revocation ends Pro through the provider's state; a partial one changes nothing in the app.

**Two subscriptions for one account.** Two checkouts paid before either webhook arrived can give one account two subscriptions: the "already subscribed" check saw neither yet ([phase 4 §20.9](../phases/phase-4-pro-accounts.md#209-the-q-005-dependency-owner-decisions-and-next-steps)). Find them (§3), cancel and refund one in the provider's dashboard, and let it sync.

**A lost dispute.** The subscription is already cancelled and the account is on Free. After the **second**, uploads are restricted for review (`billing.upload_restricted`). To lift the restriction after review (nothing audits this: record who and why in the support log):

```sql
update app.user_flags set upload_restricted = false, updated_at = now() where user_id = '<user id>';
```

**An account being deleted.** The request cancels the subscription at period end, and reconciliation retries daily during the grace. After the deletion the records stay, for accounting ([account deletion](account-deletion.md) §7).

## 7. Granting Pro by hand (overrides)

For support, testing on staging, or a payment fix in progress. Only for accounts, never anonymous users. Both functions audit (`admin.override_*`, with the reason and your name).

```sql
-- Pro, optionally until a date (the 6th argument).
select app.admin_grant_override('<user id>', 'plan', '"pro"', '<why, ticket>', '<your name>', now() + interval '3 days');
-- One limit or feature (keys: limits.activeStorageBytes, limits.dailyUploadBytes, limits.maxFileBytes,
-- limits.historyRetentionDays, features.*); numbers as JSON numbers, features as true or false.
select app.admin_grant_override('<user id>', 'limits.activeStorageBytes', '214748364800', '<why>', '<your name>');

-- The account's live overrides, and revoking one.
select id, key, value, reason, created_by, created_at, expires_at
  from app.entitlement_overrides
 where subject_type = 'user' and subject_id = '<user id>' and revoked_at is null and (expires_at is null or expires_at > now());
select app.admin_revoke_override('<override id>', '<why>', '<your name>');
```

- A later override of the same key wins. The plan override `"free"` takes Pro away even with a subscription: use it only for abuse, and record why.
- Prefer an expiry: an override without one lasts until revoked.

## 8. Going live (per environment, once Q-005 and P4-13 are done)

1. **Provider account:** the entity, tax setup and products and prices (Q-005, Q-006); MFA on its dashboard for every member (B15).
2. **Secrets on the host** (all or none; [08 §9.2](../08-deployment-and-operations.md#92-server-only)): `BILLING_PROVIDER`, `BILLING_API_KEY`, `BILLING_WEBHOOK_SECRET` (at least 32 characters, separate per environment), `BILLING_PRICE_PRO_MONTH`, `BILLING_PRICE_PRO_YEAR`, `BILLING_RECONCILE_SECRET` (at least 32 characters). `fake` and `BILLING_FAKE_API_URL` are refused in production builds and deployments.
3. **Webhook endpoint** at the provider: `https://<app origin>/api/v1/billing/webhook`, for the event types the adapter maps.
4. **Cloudflare** (08 §4): on staging, an Access bypass for the webhook path; WAF, bot and rate-limit exceptions for it. The origin lock still applies: the provider calls the public hostname.
5. **Vault**, then the flag:

   ```sql
   select vault.create_secret('https://<app origin>/api/v1/internal/billing/reconcile', 'billing_reconcile_url', 'billing reconcile endpoint');
   select vault.create_secret('<the BILLING_RECONCILE_SECRET value>', 'billing_reconcile_secret', 'billing reconcile bearer secret');
   update app.runtime_flags set enabled = true, updated_at = now(), updated_by = '<your name>', note = 'billing live'
    where key = 'billing_reconcile';
   ```

   `create_secret` refuses a name that already exists, as on the local stack, whose seed creates both. Change an existing one with `vault.update_secret` ([secret rotation](secret-rotation.md)).

6. **Verify:**
   - the sandbox lifecycle on staging: checkout, renewal, a failed payment and its grace, cancel at period end, resume, a full refund, a dispute (T4-B6, with the event IDs in `evidence/phase-4/billing-sandbox.md`);
   - a manual reconciliation run (§5) and `billingReconcile: ok`;
   - one real transaction in production, then refund it (T4-B7, AC-4.3).

## 9. Secrets

`BILLING_WEBHOOK_SECRET`, `BILLING_API_KEY` and `BILLING_RECONCILE_SECRET` (with its Vault twin): [secret rotation](secret-rotation.md).

## 10. Not verified yet

- **Everything provider-specific** (Q-005, P4-13): the signature scheme, the event and status mapping, redelivery from the dashboard, the portal, refunds and disputes as the provider reports them.
- **Staging:** the webhook path through Cloudflare (B17), pg_net reaching the app, the Vault secrets, the sandbox lifecycle (T4-B6).
- **Production:** one real transaction (T4-B7).
