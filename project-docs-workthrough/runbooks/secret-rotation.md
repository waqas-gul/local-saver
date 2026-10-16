# Runbook — Secret rotation

| Field | Value |
|---|---|
| Applies from | Phase 3 (2026-10-16). Covers 03 §12 plus the Phase 3 secrets. |
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

1. Set `LINK_PEPPER_PREVIOUS` and `CODE_PEPPER_PREVIOUS` to the current values, set new `LINK_PEPPER` and `CODE_PEPPER` (at least 32 characters each, different from each other), and raise `PEPPER_VERSION`. Deploy.
2. Links and codes made under the old version keep verifying with the previous pepper.
3. Remove the `*_PREVIOUS` values once the last link made under the old version has expired: at most 7 days and 1 hour later on Free (links never outlive their share). Deploy.

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
