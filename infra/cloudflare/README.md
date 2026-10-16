# Cloudflare and R2 configuration

Configuration that lives outside the repository's code, written down so every environment can be rebuilt the same way (08 §4, §6, §10). **Nothing here has been applied yet**: it needs the domain (Q-020) and the owner's Cloudflare account.

Replace `example.invalid` with the real domain once Q-020 is answered. `.invalid` can never resolve, so a forgotten placeholder fails safely.

## 1. Zone settings (staging and production)

| Setting | Value |
|---|---|
| DNS records for app hostnames | **Proxied** (orange cloud) |
| SSL/TLS mode | **Full (strict)**, with a valid origin certificate |
| Always Use HTTPS | On |
| Minimum TLS version | 1.2 |
| HSTS | Sent by the app (`proxy.ts`) over HTTPS. Enable zone-level HSTS preload only once the domain is final. |

## 2. Origin lock: Request Header Transform Rule (DEC-004)

**This rule decides who can reach the app, and under DEC-031 who sees local content. Changes need review.**

- **Rule name:** `origin-lock`
- **When:** hostname equals the app hostname (all paths)
- **Then:** set static request header `X-Origin-Auth` to the value of `ORIGIN_SHARED_SECRET` for that environment
- The app (`TRUST_PROXY_MODE=cloudflare`) rejects every request without it with 403, and only then trusts `CF-Connecting-IP`.

**Rotation (two accepted values):**

1. Generate a new secret (≥ 32 random characters, for example `openssl rand -base64 36`).
2. On the host, set `ORIGIN_SHARED_SECRET_PREVIOUS` to the current secret and `ORIGIN_SHARED_SECRET` to the new one. Restart.
3. Update the Transform Rule to the new secret.
4. After traffic is confirmed healthy, remove `ORIGIN_SHARED_SECRET_PREVIOUS` and restart.

**Verification (part of SP-01, test T-008):** a request straight to the origin hostname returns 403; a request through Cloudflare with a forged `X-Origin-Auth` or `CF-Connecting-IP` header is overwritten by Cloudflare and succeeds with the real client IP.

On a VPS, prefer **Cloudflare Tunnel** so the origin has no public ingress at all; keep the Transform Rule as defense in depth.

## 3. Cache rules

- Cache only `/_next/static/*` and hashed public assets.
- **Bypass cache** for `/api/*`, `/s/*`, `/j/*`, `/c*`, `/rooms/*` and all HTML. Pages carry a per-request CSP nonce and user data.

## 4. Rate limiting and WAF

- One rate-limiting rule on `/api/` with a **generous per-IP threshold** (many users share IPs behind carrier NAT). The application's Postgres limits are the precise layer (DEC-020).
- Custom WAF rules: allow only the methods each path prefix uses. Exempt the billing webhook path from bot challenges (Phase 4).
- Check that bot protections never challenge API or webhook calls.

## 5. Staging access

- **Cloudflare Access** protects the whole staging hostname. Create a service token for CI smoke tests.

## 6. Turnstile (Phase 1, Phase 2)

- One widget per environment, restricted to that environment's hostnames.
- Site key → `NEXT_PUBLIC_TURNSTILE_SITE_KEY` in the app's environment.
- Secret key → the Supabase project's **Auth captcha settings** (provider Turnstile). Supabase Auth verifies the token at anonymous sign-in.
- **From Phase 2**, the same secret key also → `TURNSTILE_SECRET_KEY` in the app's environment: the server verifies its own challenges (repeated wrong share codes, abuse reports) and checks that the token was solved on this environment's hostname. The app refuses to start in staging or production without it.
- Share and code pages (`/s/*`, `/c`) and their API routes must be reachable by link viewers; if Cloudflare Access protects staging, the testers' phones must pass it too.

## 7. Conditional rules (decided by SP-04)

- `v4.` and `v6.` probe hostnames that answer in only one address family (dual-stack binding, 03 §3.4).
- A Transform Rule forwarding the client ASN, accepted by the app only together with a valid `X-Origin-Auth`.

## 8. R2 buckets

| Item | Staging | Production |
|---|---|---|
| Bucket | `{product}-files-staging` | `{product}-files-prod` |
| Public access / `r2.dev` / custom domain | Off / off / none | Off / off / none |
| CORS | `infra/r2/cors.staging.json` | `infra/r2/cors.production.json` |
| Lifecycle | `infra/r2/lifecycle.json` | `infra/r2/lifecycle.json` |
| API tokens | `web-app` and `janitor`, Object Read & Write, scoped to the one bucket | same |

The JSON files use the S3 API format. Apply them with any S3 client pointed at the R2 endpoint, for example the AWS CLI with an R2 token:

```bash
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...   # an admin token, never the runtime tokens
ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
aws s3api put-bucket-cors --endpoint-url "$ENDPOINT" --bucket <bucket> --cors-configuration file://infra/r2/cors.staging.json
aws s3api put-bucket-lifecycle-configuration --endpoint-url "$ENDPOINT" --bucket <bucket> --lifecycle-configuration file://infra/r2/lifecycle.json
aws s3api get-bucket-cors --endpoint-url "$ENDPOINT" --bucket <bucket>
aws s3api get-bucket-lifecycle-configuration --endpoint-url "$ENDPOINT" --bucket <bucket>
```

SP-02 verifies that R2 applies both exactly as written (RISK-011). There is intentionally **no lifecycle rule for `ws/`** (Team retention is managed by the application).
