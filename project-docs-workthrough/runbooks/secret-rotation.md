# Runbook — Secret rotation

| Field | Value |
|---|---|
| Applies from | Phase 3 (2026-10-16). Covers 03 §12 plus the Phase 3 secrets. Phase 4 additions (P4-25, 2026-10-18): what the link pepper now protects and when its previous value may go; the billing secrets; the secrets only Supabase Auth holds. |
| Target | Each rotation within 1 hour (08 §10), with no downtime: generate, add the new value while the old one is still accepted, deploy, verify, remove the old value, record. |
| Owner | Operator on call: **[OWNER, Q-022]** |
| Rehearsed | **No.** No staging environment yet. |

Generate secrets with a CSPRNG, for example `openssl rand -base64 48`. Never paste one into a ticket, chat or shell history: use the host's secret UI or a file you delete afterwards. Record every rotation (date, who, why) in the operations log.

## `ORIGIN_SHARED_SECRET`

Two values are accepted during a rotation (`ORIGIN_SHARED_SECRET_PREVIOUS`).

1. Set `ORIGIN_SHARED_SECRET_PREVIOUS` to the current value and `ORIGIN_SHARED_SECRET` to a new one on the host, then deploy.
2. Change the Cloudflare Transform Rule to send the new value (`infra/cloudflare/README.md` §2).
3. Verify: requests through Cloudflare get 200, and direct requests to the origin get 403.
4. Remove `ORIGIN_SHARED_SECRET_PREVIOUS`, then deploy.

## `NETWORK_KEY_SECRET`

Versioned, with a 100-day overlap (03 §3.2).

1. Set `NETWORK_KEY_SECRET_PREVIOUS` to the current value, `NETWORK_KEY_SECRET_CURRENT` to a new one, and raise `NETWORK_KEY_VERSION`. Deploy.
2. Spaces found under the previous key are moved to the new one on their next observe (`app.rekey_network_space`), so content stays put.
3. Keep the previous secret for 100 days, then remove it and deploy.

## `LINK_PEPPER` and `CODE_PEPPER`

Versioned (`PEPPER_VERSION`, `*_PREVIOUS`).

| Pepper | Protects |
|---|---|
| `LINK_PEPPER` | Share links (Phase 2); since Phase 4: room links (P4-19), room invite and pairing links (P4-17, P4-18) and merge intents (4A), each domain-separated. **There is no `INVITE_PEPPER`** (DV4-83). |
| `CODE_PEPPER` | Short codes |

Link passwords (P4-16) use scrypt with a random salt per password: no server secret, nothing to rotate.

1. Set `LINK_PEPPER_PREVIOUS` and `CODE_PEPPER_PREVIOUS` to the current values, set new `LINK_PEPPER` and `CODE_PEPPER` (at least 32 characters each, different from each other), and raise `PEPPER_VERSION`. Deploy.
2. Everything made under the old version keeps verifying with the previous pepper. **Only one previous version is accepted:** don't rotate again until step 3 is done.
3. Remove the `*_PREVIOUS` values once nothing live was made under the old version. Since Phase 4 there is no fixed wait: a Pro share lasts up to 90 days, extending it moves links that follow it, and room links last up to 30 days. Ask the database, with `<old>` the `PEPPER_VERSION` before step 1:

   ```sql
   select 'links' as what, count(*) as live, max(expires_at) as last_expiry
     from app.share_links where pepper_version = <old> and revoked_at is null and expires_at > now()
   union all
   select 'codes', count(*), max(short_code_expires_at)
     from app.share_links where short_code_pepper_version = <old> and short_code_hmac is not null and short_code_expires_at > now()
   union all
   select 'invites', count(*), max(expires_at)
     from app.room_invites where pepper_version = <old> and revoked_at is null and expires_at > now()
   union all
   select 'merge intents', count(*), max(expires_at)
     from app.merge_intents where pepper_version = <old> and status = 'open' and expires_at > now();
   ```

   Wait until every `live` is 0, or accept that what is left stops working. Run the query again just before removing: an extension can move `last_expiry` later. Then deploy.
4. Removing the previous value early (a leaked pepper) ends every link, code, invite and pending merge made under it.

## Turnstile secret

1. In Cloudflare Turnstile, rotate the widget's secret. Cloudflare allows a grace period for the old one.
2. Update it in the Supabase project's Auth captcha settings and in the host env (`TURNSTILE_SECRET_KEY`). Deploy.
3. Verify: anonymous sign-in, and a report submission.

## Supabase API keys

1. Rotate in the Supabase dashboard (API keys): publishable and secret.
2. Update `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (a rebuild, because it is public build-time config) and `SUPABASE_SECRET_KEY` on the host. Deploy.
3. The storage janitor uses neither (C-4), though Supabase injects both into it (RISK-036).

## Database role passwords (`app_server`, `app_janitor`, `app_egress_loader`)

1. `alter role <role> with password '<new>';` A brief overlap isn't possible: change the secret right after.
2. Update where the password lives:

   | Role | Where |
   |---|---|
   | `app_server` | Host env `DATABASE_URL`, then deploy |
   | `app_janitor` | `supabase secrets set JANITOR_DATABASE_URL=…`, then redeploy `storage-janitor` |
   | `app_egress_loader` | The GitHub environment secret `EGRESS_LOADER_DATABASE_URL` (staging and production) |

3. Verify:
   - `app_server`: `/api/v1/health?ready=1`;
   - `app_janitor`: the next `storage-janitor` heartbeat;
   - `app_egress_loader`: a manual run of the "Refresh egress ranges" workflow.

## R2 tokens

There are two tokens: **web** (the app) and **janitor**.

1. Create a new token in Cloudflare with the same scope: Object Read & Write, "Apply to specific buckets only" (this bucket), an expiry date about 90 days out. Never an Admin level.
2. Set it:

   | Token | Where |
   |---|---|
   | Web | `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` on the host, then deploy |
   | Janitor | `supabase secrets set JANITOR_S3_ACCESS_KEY_ID=… JANITOR_S3_SECRET_ACCESS_KEY=…`, then redeploy `storage-janitor` |

3. Verify:
   - web: an upload and a download;
   - janitor: a `storage-janitor` run with `deleted` > 0 or no failures.
4. Revoke the old token. Rotate every 90 days.

## `JANITOR_TRIGGER_SECRET`

Two values are accepted during a rotation (`JANITOR_TRIGGER_SECRET_PREVIOUS`).

1. `supabase secrets set JANITOR_TRIGGER_SECRET_PREVIOUS='<current>' JANITOR_TRIGGER_SECRET='<new>'` and redeploy `storage-janitor`.
2. Update Vault:

   ```sql
   select vault.update_secret((select id from vault.secrets where name = 'storage_janitor_secret'), '<new>');
   ```

3. Verify: the next `net._http_response` rows are 202, not 401 ([janitor](janitor.md) §3).
4. `supabase secrets unset JANITOR_TRIGGER_SECRET_PREVIOUS` and redeploy.

## Billing secrets (Phase 4C)

Only where billing is live ([billing](billing.md) §8). The provider isn't chosen yet (Q-005): the provider-side steps are generic.

### `BILLING_WEBHOOK_SECRET`

Two values are accepted during a rotation (`BILLING_WEBHOOK_SECRET_PREVIOUS`).

1. Get the new signing secret. Many providers generate it themselves, and some keep the old one valid for a while; then start at the provider's webhook settings.
2. On the host, set `BILLING_WEBHOOK_SECRET_PREVIOUS` to the current value and `BILLING_WEBHOOK_SECRET` to the new one (at least 32 characters, separate per environment). Deploy.
3. Make the provider sign with the new secret, if step 1 didn't already.
4. Verify: a test event from the provider's dashboard gets `200`, and `billing.webhook_rejected` doesn't spike.
5. Once the provider signs only with the new secret, remove `BILLING_WEBHOOK_SECRET_PREVIOUS` and deploy.

### `BILLING_API_KEY`

The app accepts one key at a time.

1. Create a new key at the provider with the same permissions. Keep the old one active.
2. Set `BILLING_API_KEY` on the host. Deploy.
3. Verify: a checkout on staging, and a manual reconciliation ([billing](billing.md) §5) with `errors` at 0.
4. Revoke the old key at the provider.

If the provider allows only one key at a time, do this at a quiet hour. Until the deploy, checkouts answer `502` and webhooks fail with `provider_*` errors. The provider retries them, and reconciliation repairs the rest.

### `BILLING_RECONCILE_SECRET`

Two values are accepted during a rotation (`BILLING_RECONCILE_SECRET_PREVIOUS`), plus the Vault twin pg_net sends.

1. On the host, set `BILLING_RECONCILE_SECRET_PREVIOUS` to the current value and `BILLING_RECONCILE_SECRET` to a new one (at least 32 characters). Deploy.
2. Update Vault:

   ```sql
   select vault.update_secret((select id from vault.secrets where name = 'billing_reconcile_secret'), '<new>');
   ```

3. Verify: run reconciliation by hand ([billing](billing.md) §5). The newest `net._http_response` row is 202, not 401, and the `billing-reconcile` heartbeat succeeds.
4. Remove `BILLING_RECONCILE_SECRET_PREVIOUS` and deploy.

## Secrets only Supabase Auth holds (Phase 4)

The app never has these.

| Secret | Rotation |
|---|---|
| SMTP password (P4-23) | [`infra/email/README.md`](../../infra/email/README.md) §9 |
| Google OAuth client secret (4A) | Create a new client secret on the OAuth client in Google Cloud. Set it in the Supabase project (Authentication → Providers → Google). Verify a Google sign-in on staging, then delete the old secret. **No OAuth client exists yet.** |

Authenticator apps (P4-24) add no secret: each factor's key stays in Supabase Auth.
