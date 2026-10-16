# 06 — Decisions, Risks and Open Questions

| Field | Value |
|---|---|
| Document status | LIVING DOCUMENT |
| Last updated | 2026-10-16 (Phase 3 security review: RISK-031, RISK-036 and RISK-037 updated; D-2 note). 2026-10-16 (Phase 3 implementation: owner decisions Q-008 and D-1 … D-9 recorded on DEC-015 … DEC-019 and DEC-029; Q-008 answered; Q-022 note; RISK-006, RISK-011, RISK-012, RISK-018, RISK-029 and RISK-031 updated; RISK-034 … RISK-041 added). 2026-10-16 (Phase 2 owner decisions: Q-010, Q-027 and Q-028 answered, Q-011 answered for Phase 2; owner notes on DEC-013 (link lifetime), DEC-024, DEC-025, DEC-033; Q-022 note (no alert delivery in Phase 2); RISK-032 and RISK-033 added after the implementation review). 2026-10-15 (Phase 2: implementation notes on DEC-013, DEC-014, DEC-024, DEC-025, DEC-033; Q-010, Q-011, Q-027, Q-028 assumed for Phase 2; Q-022 note; RISK-030 and RISK-031 added). Earlier the same day: (Phase 1 implementation notes on DEC-005, DEC-011, DEC-020, DEC-032; RISK-001, RISK-010 and RISK-016 updated after the Phase 1 security review; RISK-028 added; second review pass: RISK-029 and Q-031 added, Q-019 note (Firefox 128), RISK-010 note; Q-007/019/021/023/029/030 assumed for Phase 1). Earlier: 2026-09-29 (DEC-001 shadcn/ui accepted; DEC-035 UI component system added.) Earlier: 2026-09-23 (CR-001: owner kept automatic same-network visibility. DEC-001 Next.js accepted. DEC-034 frontend state management accepted.) |

---

## 1. How this log works

### 1.1 Decision statuses

| Status | Meaning |
|---|---|
| `PROPOSED` | Recommended, awaiting owner approval. Must not be implemented yet. |
| `CONDITIONAL` | Approved in principle, pending a named spike or answer |
| `ACCEPTED` | Approved by the owner. Implementation must follow it. |
| `SUPERSEDED` | Replaced by a later decision (link to its change record) |
| `REJECTED` | Considered and declined (kept for history) |

### 1.2 Changing an accepted decision

**Never change an accepted decision silently.** Add a change record under §5 and update the decision's status:

```text
CR-NNN — <short title> (changes DEC-XXX)
Date:
Previous decision:
Reason for change:
New decision:
Impact on existing implementation (code, data, migrations, docs):
Migration / rollback plan:
Approved by:
```

---

## 2. Decision log

### DEC-001 — Web framework and UI stack

- **Decision:** keep Next.js 16 App Router (16.3.5 installed), React 19, TypeScript (strict), Tailwind CSS v4 and shadcn/ui.
- **Reason:** already scaffolded. One deployable for UI and API. shadcn/ui gives accessible Radix-based components copied into the repo (no runtime lock-in).
- **Alternatives considered:** React Router/Remix, SvelteKit, a separate SPA plus an API service (Hono/Fastify).
- **Risks:** Next.js 16 differs from older docs and libraries (`proxy.ts`, async request APIs). Follow the bundled docs (RISK-016).
- **Status:** **Next.js as the frontend and full-stack framework: ACCEPTED** (owner, 2026-09-23). **shadcn/ui as the UI component system: ACCEPTED** (owner, 2026-09-29; configuration in DEC-035). React 19, TypeScript and Tailwind CSS: PROPOSED (part of the owner's preferred stack, not yet separately confirmed). Frontend state management is DEC-034.

### DEC-002 — Same-network model: discovery is not authorization *(rejected by the owner)*

> Kept for history. Replaced by DEC-031 through [CR-001](#cr-001--keep-automatic-same-network-visibility-changes-dec-002-and-dec-003).

- **Decision (as proposed):** network signals only **suggest** nearby rooms. Content access requires **membership**, obtained by approval, nearby PIN, an owner-opened join window, an invite/QR secret, or workspace membership. Membership persists across networks.
- **Reason (as proposed):** public-IP grouping yields false positives (CGNAT, campus, café, VPN, relays) and false negatives (dual-stack, relays). Browsers block LAN identification. The same Wi-Fi is not a trust boundary. See [03 §2](03-security-and-network-design.md#2-same-network-detection--technical-analysis).
- **Alternatives considered:** automatic visibility for the same public IP, with or without crowding heuristics; WebRTC LAN proof; native apps with mDNS (Q-025).
- **Status:** **REJECTED** by the owner on 2026-09-23. The product keeps automatic same-network visibility with no approval step (DEC-031).

### DEC-003 — Network hint derivation, privacy and retention *(superseded)*

> Replaced by DEC-032 through [CR-001](#cr-001--keep-automatic-same-network-visibility-changes-dec-002-and-dec-003). The derivation (keyed HMAC, IPv4 /32, IPv6 /64) carries over. The discovery-only purpose, the 2 h / 24 h hint lifetimes and the crowding threshold of 12 do not.

- **Decision (as proposed):** `hint = HMAC-SHA256(secret key, normalized IP)`, where IPv4 is /32 and IPv6 is /64. Observations live for 2 h and are deleted after 24 h. Crowding threshold 12 distinct devices per 24 h. iCloud Private Relay ranges mark a network `shared_egress`.
- **Status:** **SUPERSEDED** by DEC-032 (2026-09-23)

### DEC-004 — Trusted client-IP source and origin lock

- **Decision:**
  - Production traffic must pass through Cloudflare. The origin rejects requests without the secret header injected by a Cloudflare Transform Rule.
  - Only then is `CF-Connecting-IP` trusted. `X-Forwarded-For` and `X-Real-IP` are ignored.
  - On a VPS, prefer Cloudflare Tunnel.
- **Reason:** `NextRequest.ip` no longer exists. Forwarded headers are client-controlled unless the proxy chain is controlled. **Under DEC-031 the trusted IP decides who sees local content**, so a spoofed IP would expose any network's local content. Spoofing would also allow rate-limit evasion.
- **Alternatives considered:** trusting the host's `X-Forwarded-For` (unverified), authenticated origin pulls with mTLS (VPS only), Cloudflare IP allow-listing (VPS only).
- **Status:** PROPOSED — verified in SP-01

### DEC-005 — Device identity via Supabase anonymous sign-ins

- **Decision:**
  - Each browser signs in anonymously (CAPTCHA/Turnstile required) and registers an `app.devices` row.
  - Anonymous users inactive for 30 days are deleted.
  - Upgrading to a permanent account keeps the same user ID.
  - **Share-link viewers do not create Supabase users.**
- **Reason:** one `auth.uid()` for anonymous and permanent users, native Realtime authorization, a built-in upgrade path.
- **Alternatives considered:** own device cookies plus custom JWTs minted with a Supabase-imported signing key (lower MAU cost, more code; kept as an exit ramp). Third-party auth providers (unnecessary).
- **Risks:** MAU billing for anonymous devices (RISK-006). CAPTCHA applies to every Supabase auth flow once enabled.
- **Phase 1 implementation (2026-10-15):** anonymous sign-in with a Turnstile token when a site key is configured (required in staging and production), then `POST /api/v1/devices`. The browser keeps its session and sends the access token as a bearer header; the server verifies it and never refreshes it (phase 1 DV1-14, instead of `@supabase/ssr` cookies).
- **Status:** PROPOSED

### DEC-006 — Data-access boundary

- **Decision:** application tables live in the private `app` schema, **not exposed** through the Data API. Only the Next.js server (role `app_server`) reads and writes them. Browsers use Supabase only for Auth and Realtime. RLS is enabled everywhere with server-only policies as defense in depth.
- **Reason:** a single enforcement point for authorization, entitlements, quotas and rate limits. Clients cannot bypass the API through PostgREST.
- **Alternatives considered:** browser supabase-js with RLS for everything (logic spread across policies, entitlements and rate limits bypassable, hard to test). Server calls through PostgREST with the secret key (no multi-statement transactions without RPC).
- **Status:** PROPOSED

### DEC-007 — Migrations and query layer

- **Decision:** SQL-first migrations with the Supabase CLI. Kysely with generated types for server queries over the Supavisor pooler (session mode for a long-running server). pgTAP for database tests.
  - **Fallback** if the host blocks outbound Postgres TCP: supabase-js with the secret key calling `SECURITY DEFINER` RPC functions in a dedicated, locked-down schema.
- **Reason:** SQL-native features (RLS, realtime triggers, pg_cron) are central. Generated types avoid drift.
- **Alternatives considered:** Drizzle ORM (acceptable if preferred, with SQL migrations staying authoritative), Prisma (weaker fit for SQL-first, heavier runtime).
- **Status:** PROPOSED — connectivity verified in SP-01

### DEC-008 — API style

- **Decision:** versioned JSON route handlers under `/api/v1`. Thin handlers call server-only services. zod contracts shared with the client. Server Actions are **not** used for security-critical or upload flows.
- **Reason:** explicit HTTP semantics, per-endpoint rate limits and CSRF policy, testable with HTTP tools. Server Actions are queued, default to a 1 MB body, and allow requests with no `Origin` header (with a warning).
- **Alternatives considered:** Server Actions everywhere, tRPC, a separate API service.
- **Status:** PROPOSED

### DEC-009 — File storage and transfer path

- **Decision:** Cloudflare R2 private buckets. Browsers upload directly with presigned PUT (multipart for large files) and download through presigned GET (60 s) issued after authorization. **File bytes never pass through Next.js or Supabase.**
- **Reason:** free egress, S3 compatibility, no web-tier bandwidth, memory or timeout pressure. The Next.js proxy buffers bodies up to 10 MB.
- **Alternatives considered:** Supabase Storage (egress billed), proxying through Next.js, a Cloudflare Worker download gateway (later option).
- **Risks:** no POST policies, so verification happens after upload (RISK-010). Presigned URLs are bearer tokens (RISK-009). Presigning only works on the S3 endpoint.
- **Status:** PROPOSED — semantics verified in SP-02

### DEC-010 — Object key and metadata strategy

- **Decision:** keys `{d7|d30|d90|ws}/{yyyy}/{mm}/{dd}/{fileUuid}` with no PII. `Content-Type`, `Content-Disposition: attachment` and `Cache-Control` set at upload through signed headers. Lifecycle backstop rules per prefix.
- **Reason:** lifecycle backstops need prefixes, reconciliation lists by date, and R2 response-header overrides are uncertain.
- **Alternatives considered:** per-user or per-room prefixes (PII-adjacent, no benefit), flat keys (no backstop).
- **Status:** PROPOSED

### DEC-011 — Realtime approach

- **Decision:**
  - Supabase Realtime **private** channels.
  - Local mode uses one topic per network space, `net:{spaceId}`. A device may join it only while the server has recorded it as **present** on that space (DEC-032). Pro/Team rooms use `room:{roomId}` with membership checks.
  - **Broadcast emitted by database triggers** with ID-only payloads. Presence for devices on the network ("N devices here now").
  - **No Postgres Changes. No client-sent broadcasts.**
  - Link-viewer pages poll.
- **Reason:** Postgres Changes is single-threaded with per-subscriber checks. Trigger emission is transactional. Replay storage holds no content. Authorization stays simple.
- **Alternatives considered:** Postgres Changes, own WebSocket server, Ably/Pusher, Cloudflare Durable Objects.
- **Risks:** channel authorization is cached per connection, so a device that left a network can receive ID-only signals until its token refreshes (RISK-007). Message retention (RISK-023).
- **Phase 1 implementation (2026-10-15):** verified on the local Supabase stack (T-015 … T-018): private `net:` and `user:` topics, presence-based join, client broadcasts refused, presence tracking allowed, nothing emitted for rolled-back transactions, a public channel with the same topic receives none of the private signals. Hosted behaviour is still SP-03.
- **Status:** PROPOSED — verified in SP-03. Revised 2026-09-23 for CR-001 (network topics instead of nearby-room membership).

### DEC-012 — Content model

- **Decision:** a **share** (a bundle of files, or one text item) → `files` / `text_items`. Each share has a scope:
  - `network`: posted to a network space and visible to devices currently on that network (local mode, DEC-031).
  - `link_only`: visible only to its creator and to holders of its links (Phase 2).
  - `room`: posted to a Pro private room or a Team workspace room (Phase 4–5).

  `share_links` grant remote access to one share, or read-only access to a private or workspace room (Pro/Team).
- **Reason:** bundles map to multi-file sends and single links. Per-share lifecycle (expiry, burn) matches user intent. Local mode needs no room object, because a network has no owner or members.
- **Alternatives considered:** flat items (multi-file links harder), links as the only container, modelling each network as a room with members (the rejected DEC-002).
- **Status:** PROPOSED. Revised 2026-09-23 for CR-001.

### DEC-013 — Remote link format and viewer sessions

- **Decision:**
  - URL `https://{domain}/s/{linkId}#k={secret}`: a 96-bit link ID and a 256-bit secret stored as an HMAC.
  - Unlocking creates an httpOnly link session and a grant (≤ 12 h). Viewers get no Supabase user.
  - State is revealed only after the secret is proven.
  - Share pages are `noindex`, `no-referrer`, with no third-party scripts.
- **Reason:** keeps secrets out of logs and referrers, safe against unfurlers, cost-efficient, revocable.
- **Alternatives considered:** secret in the path (logged everywhere), opaque path-only token, requiring viewer sign-in.
- **Phase 2 implementation (2026-10-15):** as decided. The cookie is `__Host-link_session` on HTTPS and plain `link_session` on local plain-HTTP origins (phase 2 DV2-3); the HMAC is bound to the link ID; a grant that only timed out answers 404, an ended link 410 ([ARCHITECTURE.md §9](ARCHITECTURE.md#9-remote-sharing)).
- **Owner decision (2026-10-16), link lifetime:** a link never outlives its share; the share's expiry is its maximum lifetime, and a link created without a chosen expiry lasts exactly as long as the share. No separate 7-day link limit applies (07 §1's planned default; phase 2 DV2-13, §19.1).
- **Status:** PROPOSED

### DEC-014 — Short share codes

- **Decision:** 10-character Crockford Base32 (50 bits), HMAC-stored. Default validity 1 h (Free ≤ 24 h, Pro ≤ 7 days). Rate limits with Turnstile escalation. Resolving creates a grant and never reveals the link secret.
- **Reason:** typable yet brute-force resistant at scale ([03 §4.4](03-security-and-network-design.md#44-short-codes-dec-014)).
- **Alternatives considered:** 8 characters (≈ 0.9 expected hits per day under a 10⁶ guesses/day attack with 10⁶ active codes), 6-digit global codes (unsafe), word lists (longer).
- **Phase 2 implementation (2026-10-15):** as decided, with failure-only counters, a 24-hour block from the 20th failure, codes clamped to their link's expiry (DV2-14) and a "new code" endpoint (DV2-5); without Turnstile configured the escalation is a wait (DV2-19). Residual risk RISK-030.
- **Status:** PROPOSED

### DEC-015 — One-time download semantics

- **Decision:** **burn on claim.** The first non-creator download request atomically claims the share. Only the claimant (device or link session) may obtain URLs during a grace window (15 min plus a size-based extension, ≤ 6 h, ≤ 3 issuances per file). Then the content ends and objects are deleted. POST only. No previews for burn shares.
- **Reason:** completion is unobservable. Completion-based consumption is exploitable (abort at 99%) and racy. Bots follow links.
- **Alternatives considered:** completion detection through a Worker proxy (still exploitable by partial downloads), single-use presigned URLs (not supported by SigV4 semantics).
- **Status:** PROPOSED — changes REQ-004 (owner sign-off)
- **Phase 3 implementation (2026-10-16, [phase 3 §18](phases/phase-3-expiry-one-time-download.md#18-implementation-2026-10-16)):**
  - **Built as decided.** One conditional UPDATE (`app.claim_burn_share`) under the share's row lock, READ COMMITTED enforced. Tested: 50 simultaneous claims give exactly one winner, at the SQL and API levels, with a mutation check.
  - **Grace:** `least(15 min + 1 s per MiB, 6 h)`, **capped at the share's expiry** (owner decision D-6), and checked with the database clock.
  - **The creator** never claims and may download until the share is consumed (D-7). A creator who opens their own link in a browser is a link viewer and claims (RISK-039).
  - **The claimant ends it early** with "I've got it" (`confirm-received`). Objects go 5 minutes after the share is consumed.

### DEC-016 — Expiry enforcement and cleanup

- **Decision:**
  - Request-time checks are authoritative.
  - `app.end_share()` is the only path to end content: it nulls text, enqueues object deletions and releases quota.
  - pg_cron performs state transitions. An outbox plus janitor deletes objects.
  - R2 lifecycle rules are the backstop. Reconciliation jobs catch drift.
- **Reason:** correctness independent of job latency, no orphan objects, auditable.
- **Alternatives considered:** relying on lifecycle rules (≈ 24 h lag), synchronous deletion in request paths (fragile).
- **Status:** PROPOSED
- **Owner decisions (2026-10-16), built in Phase 3 ([phase 3 §18](phases/phase-3-expiry-one-time-download.md#18-implementation-2026-10-16)):**
  - **D-1, one deletion executor.** The storage janitor alone deletes and tombstones objects. The request-path executor, and `app_server`'s grant on `claim_object_deletions`, are removed. Access still ends at once; physical deletion follows within about a minute (RISK-034).
  - **D-2, hold.** Takedown objects are put on legal hold (`legal_hold`, `hold_reason`). The janitor and the purge skip them, and an operator releases them with `admin_release_hold`. The final retention policy is an operational and legal responsibility (Q-022).
    - **Security review (2026-10-16):** R2's lifecycle rules ignore the database, so they would have deleted held objects at their class period + 1 day. The janitor now copies each held object to `hold/<key>`, which no rule covers, and deletes both after the release (phase 3 DV3-15, RISK-031).
  - **D-3, keep reported shares.** Shares with abuse reports are never purged automatically. Their download records and the audit events about them are kept too.
  - **D-9, keep suspended users.** Anonymous-user cleanup never deletes suspended users.
  - **Retention as built:** tombstones are purged 30 days after the share ends, downloads and audit events on their own dates, and completed outbox rows 30 days after completion.

### DEC-017 — Scheduler and janitor runtime

- **Decision:** Supabase Cron (pg_cron) for SQL jobs. The storage janitor is a Supabase Edge Function invoked by pg_cron through pg_net with a Vault-stored secret. A Cloudflare Worker with a Cron Trigger and R2 binding is the documented alternative.
- **Reason:** jobs sit next to the data. Nothing runs in the background on the web host.
- **Alternatives considered:** host cron calling an API route, GitHub Actions schedules (can be delayed), a Cloudflare Worker.
- **Status:** PROPOSED — Edge Function execution limits verified before Phase 3
- **Phase 3 (2026-10-16, [phase 3 §18](phases/phase-3-expiry-one-time-download.md#18-implementation-2026-10-16)):**
  - **Limits measured on the local edge runtime only (P3-00):**
    - 256 MB, with a 1 s soft and 2 s hard CPU limit, enforced and cumulative per worker;
    - about 0.6 ms of CPU per signed S3 call, so the janitor takes at most 500 rows per invocation;
    - `EdgeRuntime.waitUntil`, pg_net → Kong → function, and Vault all work.
  - **The janitor is the Edge Function, as decided.** It connects as the least-privilege `app_janitor` role, not with the service-role key.
  - **The egress-list refresh moved to a scheduled GitHub Actions workflow** (owner decision D-4). It runs the existing script as `app_egress_loader`, because the merge needs about 4 s of CPU, twice the Edge limit. No Cloudflare Worker.
  - **Hosted limits** must be measured again on staging.

### DEC-018 — Entitlements model and enforcement location

- **Decision:** plans defined in typed code, overrides in the database, resolved per request on the server, enforced in services on every write path. Snapshots stored on shares and links. **The uploader's plan** governs local, link-only and private-room shares. **The workspace plan** governs workspace rooms.
- **Phase 3 (Q-008, owner 2026-10-16):** burn after download is `features.burnAfterDownload`, which only Pro will have. During beta and testing the Free plan may also use it while the runtime flag `free_burn_after_download` is on (**default off**). It is gated at creation only, the share's snapshot records the grant, and there is no payment or Pro infrastructure. `GET /api/v1/me/entitlements` tells the UI.
- **Reason:** server-side enforcement, predictable behaviour after plan changes.
- **Alternatives considered:** plans only in database rows (harder to type and test), client-side gating (insecure).
- **Status:** PROPOSED

### DEC-019 — Storage quota accounting

*Phase 3 (2026-10-16):* daily reconciliation is built (`app.reconcile_storage_usage`): it locks the ledger row and then recounts, which is race-free (tested with 20 concurrent completions), and audits drift above max(1 MiB, 0.1 %). The 7-day staging soak (AC-3.5) is pending.

- **Decision:** a per-subject ledger. Atomic conditional reservation at init, commit on verification, release on failure or end. Daily reconciliation.
- **Reason:** race-free quota enforcement without table-wide locks.
- **Alternatives considered:** `SUM()` at upload time (slow, racy). R2 has no per-user quotas.
- **Status:** PROPOSED

### DEC-020 — Rate limiting layers

- **Decision:** a coarse Cloudflare edge rule plus Postgres fixed-window counters (`app.rate_limit_hit`) keyed by device, user, network key, link and room. Turnstile escalation. Move to Redis only if database load requires it.
- **Reason:** no new vendor for the MVP, works across instances, precise keys.
- **Alternatives considered:** in-memory limits (lost on restart, per instance), Upstash Redis from day one (extra vendor).
- **Phase 1 implementation (2026-10-15):** Postgres counters per device, user and network space for every Phase 1 action ([03 §10](03-security-and-network-design.md#10-rate-limiting-and-abuse-protection)); daily volumes counted in KiB. The Cloudflare edge rule waits for the zone (Phase 0).
- **Status:** PROPOSED

### DEC-021 — Link password hashing

- **Decision:** Argon2id (m = 19 MiB, t = 2, p = 1) via `@node-rs/argon2`. PHC strings. Versioned grants. Attempt limits.
- **Reason:** OWASP-recommended, memory-hard, prebuilt Linux binaries.
- **Alternatives considered:** scrypt via `node:crypto` (fallback if native binaries fail on the host), bcrypt (72-byte input limit).
- **Status:** PROPOSED (Phase 4)

### DEC-022 — Hosting

- **Decision:** Hostinger managed Node.js web app behind Cloudflare, **only if SP-01 passes**. Otherwise a Hostinger VPS (Docker, Next.js `standalone`, Cloudflare Tunnel), or Vercel if the owner prefers managed hosting over operations work.
- **Reason:** owner preference and cost, but unverified platform behaviour is critical to security (client IP) and reliability.
- **Alternatives considered:** Vercel (a paid plan is needed for commercial use), Next.js on Cloudflare Workers via OpenNext (verify Next.js 16 support), Render, Fly.io, Railway.
- **Status:** CONDITIONAL — pending SP-01 and Q-012

### DEC-023 — Billing provider

- **Decision:** a **merchant of record** (Paddle, Lemon Squeezy or Polar) unless the business is in a Stripe-supported country and prefers to handle sales tax and VAT itself. Provider-agnostic subscription tables and an idempotent webhook log.
- **Reason:** a global consumer SaaS at low price points must handle VAT/GST. A merchant of record takes that on.
- **Alternatives considered:** Stripe Billing plus Stripe Tax. Stripe's own merchant-of-record offering (reported in private beta in 2026; verify availability).
- **Risks:** fees of about 5% + $0.50 per transaction on low prices (RISK-015).
- **Status:** PROPOSED — blocked on Q-005

### DEC-024 — No third-party ad or analytics scripts on content pages

- **Decision:** no ad networks, tag managers or third-party analytics on app, room, share, invite or code pages. Any Free-plan ads are limited to marketing pages or first-party promotions.
- **Reason:** third-party scripts can read shared text, file names and presigned URLs. Ad network policies often exclude file-hosting user content.
- **Alternatives considered:** sandboxed ad iframes (still privacy and performance costs).
- **Phase 2 implementation (2026-10-15):** share and code pages load no third-party script; Cloudflare Turnstile loads only on demand (a code check after failures, sending a report) where it is configured. Tested by an E2E network log (AC-2.9).
- **Owner decision (2026-10-16, Q-011):** no advertising in Phase 2; remote sharing stays ad-free. Nothing about ads after Phase 2 is decided.
- **Status:** PROPOSED; the Phase 2 part (no ads at all) accepted by the owner on 2026-10-16 (Q-011)

### DEC-025 — Content-safety posture

- **Decision:**
  - Downloads are attachment-only, from R2's origin.
  - Inline previews only for magic-byte-verified raster images via `<img>` (no `next/image` optimization). Text shown as escaped plain text.
  - Filename sanitization.
  - Executable/script uploads blocked for anonymous remote links until scanning exists.
  - Abuse reporting and takedown.
  - No public multi-scanner services for private files. Malware scanning in Phase 6.
- **Reason:** prevent XSS and phishing via user content, reduce malware distribution, protect privacy.
- **Phase 2 implementation (2026-10-15):** executables, scripts, installers and disk images are blocked from Free remote links and link-only shares (`lib/server/security/file-policy.ts`; Q-010 assumed); reports and SQL takedown are built; quarantine and evidence preservation are not (RISK-031).
- **Owner decision (2026-10-16, Q-010):** accepted as built: executables, scripts, installers and disk images are blocked in anonymous/Free remote sharing; archives are allowed with a warning; local sharing is unchanged (it allows them with a badge and a confirmation).
- **Status:** PROPOSED; the remote executable policy accepted by the owner on 2026-10-16 (Q-010)

### DEC-026 — Upload transport by size

- **Decision:** single presigned PUT for files ≤ 100 MB (Phase 1). Multipart for larger files (Phase 4): equal parts ≥ 16 MiB, resumable, verified with `ListParts`.
- **Reason:** simple for Free. R2's single-PUT limit is 5 GiB, and it has multipart part-size rules.
- **Status:** PROPOSED

### DEC-027 — Text items

- **Decision:** text lives in Postgres (hard cap 1 MB; Free 100 KB proposed). Versioned last-writer-wins edits with 409 on conflict. Content nulled at share end. No CRDT or collaborative editing.
- **Reason:** clipboard-style sharing doesn't need live co-editing. Simple and auditable.
- **Alternatives considered:** Yjs/CRDT live editing (complex), storing text in R2 (unnecessary).
- **Status:** PROPOSED (Q-021)

### DEC-028 — Environments and CI/CD

- **Decision:**
  - Environments: local (Supabase CLI), staging and production, each with separate Supabase projects, R2 buckets and hostnames.
  - GitHub Actions CI: typecheck, lint, unit, database tests, build, e2e.
  - Migrations go to staging automatically and to production with approval.
  - The host deploys only from a deploy branch fast-forwarded after CI and migrations succeed.
- **Reason:** the host auto-deploys from Git. Gating prevents untested deploys.
- **Status:** PROPOSED

### DEC-029 — Observability and redaction

*Phase 3, owner decision D-5 (2026-10-16):*
- **The first alert path** is an external uptime monitor polling `GET /api/v1/health/cron`, which answers 503 when a job, the janitor, reconciliation or the egress lists are unhealthy, and emails a named recipient.
- **Nothing is built in-app for alerts.** The recipient is **[OWNER]** (Q-022).
- **Alerts are not operational** until a monitor is configured ([monitoring runbook](runbooks/monitoring.md)).

- **Decision:** error monitoring (Sentry or equivalent) scrubbing URLs, fragments, cookies and tokens. Structured JSON logs (pino) with redaction. Uptime and cron-heartbeat monitoring. Alert catalogue in [08](08-deployment-and-operations.md#8-observability-and-alerting).
- **As built (Phases 0–1, 2026-10-15):** logs use the internal JSON logger with redaction (`lib/server/log.ts`) instead of pino (phase 0 DV-7, phase 1 DV1-7). Error monitoring and uptime and cron-heartbeat monitoring are not built yet.
- **Status:** PROPOSED

### DEC-030 — Runtime and package manager

- **Decision:** Node.js 24 LTS on the host (22 LTS as fallback), pinned with `engines` and `.node-version`. pnpm pinned through `packageManager` to a version the host and CI support. Keep 12.4.2 only if SP-01 confirms support.
- **Reason:** Next.js 16 needs Node ≥ 20.9. The host offers 18/20/22/24. Lockfile format compatibility.
- **Phase 0 implementation (2026-09-23):** `.node-version` = **22** and `engines.node` = `>=22.12.0`, matching the development machine (Node 22.22) and CI. `packageManager` stays **pnpm 12.4.2** and the lockfile was regenerated with it. Both are interim until SP-01 (phase 0 DV-3, DV-4).
- **Status:** PROPOSED (SP-01, Q-024)

### DEC-031 — Local mode: automatic same-network visibility

- **Decision (the owner's product rule):**
  - **Same Wi-Fi/network:** anyone on that network automatically sees the files, text and images posted to it. No approval, PIN, QR code or link.
  - **Different network:** sees nothing automatically, not even that the content exists.
  - **Remote access:** only through an explicit share link, its QR code, or a short share code, and only to what was shared.
- **Reason:** this is the product's core promise. The owner explicitly declined approval-based sharing on 2026-09-23 (CR-001).
- **Alternatives considered:** DEC-002 (approval, PIN or open-join window, then remembered membership): rejected by the owner. WebRTC LAN proof: withdrawn (it needs another device online and can trigger a permission prompt). Native apps with mDNS: future option (Q-025).
- **Security implications:**
  - The network the server sees becomes the access rule for local content. That view must come only from a Cloudflare-verified IP (DEC-004) and must switch itself off wherever the server cannot tell networks apart (DEC-032).
  - Inherent residual risks, which no guard can remove: everyone physically on the Wi-Fi sees local content (RISK-025); different networks behind one undetected shared IP can see each other's local content (RISK-001); an IP reassigned by the ISP exposes content still live on it (RISK-026). See [03 §3.8](03-security-and-network-design.md#38-isolation-guarantees).
- **Status:** **ACCEPTED** (owner, 2026-09-23)

### DEC-032 — Network keys, dual-stack binding and fail-closed eligibility

- **Decision:**
  - `networkKey = HMAC-SHA256(secret, normalized IP)`: IPv4 /32, IPv6 /64, with IPv4-mapped and NAT64 forms normalized. Raw IPs are never stored. One **network space** per key.
  - The server derives the key **on every request** from the Cloudflare-verified client IP. No API accepts a network or space identifier from the client.
  - **Dual-stack binding (if SP-04 shows it works):** the client probes an IPv4-only and an IPv6-only hostname, and the server binds both keys to the device for 10 minutes, but only while the current request's own key is one of them.
  - A new local share goes into the uploader's **most specific** eligible space (IPv6 /64 if present, else IPv4). A device sees shares in every eligible space of its current network.
  - **Eligibility.** Only `ok` networks have local mode. The other statuses switch it off (fail closed):
    - `shared_egress`: iCloud Private Relay and Tor exit lists; VPN, hosting and (IPv4 only) mobile-carrier ASNs; an IPv4 bound to two or more IPv6 /64s within one hour.
    - `too_large`: more than 50 distinct devices in 24 h (Q-029).
    - `blocked`: operator action.
    - `unavailable`: no trusted or global IP.

    Fail closed covers both viewing and posting. Content already on a network is hidden until it becomes eligible again. Creators always keep access to their own shares.
  - **Presence:** recorded by the server, lasting 10 minutes after the device's last check-in. It authorizes the realtime topic and feeds the device count.
- **Reason:** makes DEC-031 as safe as a web app can make it. Clients cannot pick a network, and ambiguous networks fail closed instead of leaking.
- **Alternatives considered:**
  - Plain SHA-256: reversible.
  - IPv6 /56 grouping: groups more strangers.
  - A crowding threshold of 12 (DEC-003): too low now that ordinary office and café Wi-Fi is meant to work.
  - No guards: leaks immediately on mobile, VPN and relay IPs.
  - Remembering access after a device leaves: contradicts DEC-031.
- **Risks:** false negatives (RISK-013). Undetected shared IPs (RISK-001). Network keys are pseudonymous personal data.
- **Phase 1 implementation (2026-10-15):** without SP-04, only the current request's key counts; no dual-stack probe, no ASN list. `shared_egress` comes from the egress-range lists; `too_large` uses the runtime flag `network_large_cap` (50). Key rotation re-keys spaces in place (`app.rekey_network_space`).
- **Status:** PROPOSED — parameters set by SP-04 and Q-029

### DEC-033 — Local share permissions and remote reach

- **Decision:**
  - The uploader picks a destination: **This network** (the default when eligible) or **Link only** (Phase 2; never visible on any network). Pro/Team add private and workspace rooms.
  - Anyone currently on the network can view, download, copy text and report a local share. **Only its creator** can edit text, delete it, and create or revoke links (Q-021). Operators can block.
  - Creators always see their shares under **My uploads**, from any network, and can share them by link from there.
  - Remote links target **one share** (Free) or a **private or workspace room** (Pro/Team). **There is no link to a whole network's feed**: it would expose other people's local uploads off the network (Q-028).
  - Before posting, the UI states the audience: *"Visible to everyone on this network"* (under the composer); the status bar shows *"This network · 3 devices here now"*. (Phase 1 copy split by the owner on 2026-10-15; phase 1 §18.6.) A one-time notice explains that everyone on the same Wi-Fi, including guests, can see and download local posts.
- **Reason:** keeps the automatic model while ensuring nobody can delete or export someone else's local post, and that uploaders know who can see it.
- **Alternatives considered:** anyone present may delete or edit (vandalism on public Wi-Fi); network-wide remote links (exposes others' posts).
- **Phase 2 implementation (2026-10-15):** "Link only" posting, creator-only links from any network, one share per link (no feed links, Q-028 assumed). Where local sharing is off, the composer offers Link only.
- **Owner decision (2026-10-16, Q-028):** accepted as built: a link exposes only its one share, never a feed, space, other local shares, presence, devices or network identifiers; link-only shares never appear in a local feed.
- **Status:** PROPOSED (Q-021); the remote-reach rule accepted by the owner on 2026-10-16 (Q-028)

### DEC-034 — Frontend state management: Zustand, TanStack Query, Supabase Realtime

- **Decision (owner):** three layers, each owning one kind of state:

| Layer | Owns | Examples | Must never |
|---|---|---|---|
| **Zustand** | **Client-only state** | UI state (open dialogs, tabs, selection, composer drafts), the upload queue and per-file progress, selected files before upload, temporary state of the current network or room view (the Presence roster, realtime connection status) | Hold copies of server data, secrets or presigned URLs. Persist anything except harmless preferences. |
| **TanStack Query** | **Server state**, fetched only through `/api/v1` | The local feed and file lists, share details and text posts, "My uploads", the current network status (the `observe` result), user and account data, entitlements and plans, transfer history, link-viewer content | Be written by anything except query functions, mutations, and realtime-triggered updates (rule 1) |
| **Supabase Realtime** | **Live update signals only** | `share.changed` (new uploads, deletions, expiry, claims, text edits), `network.changed`, Presence | Hold state or deliver content. Payloads stay ID-only (DEC-011). |

- **Integration rules** (proposed details of the accepted split):
  1. **Realtime updates the query cache, never the UI directly.** A handler receives an ID and invalidates or refetches the affected query keys. Alternatively it fetches the one share through the API and places it in the cache. An ended status removes the item. Nothing is taken from the payload except IDs and status.
  2. **At-most-once delivery:** on (re)subscribe and reconnect, invalidate the local feed and the open share queries ([02 §5.3](02-system-architecture.md#53-delivery-semantics-and-client-rules)).
  3. **Leaving a network clears its data.** Network-scoped query keys include the current space IDs. When `observe` returns different space IDs, or a status other than `ok`, the client removes all network-scoped queries (not just hides them), then drops the old `net:` channel. This keeps G3 true on screen and in memory.
  4. A `404` or `410` from the API for a cached share removes it from the cache.
  5. **No cache persistence.** No TanStack Query persister. Zustand's `persist` only for harmless preferences (for example "one-time notice dismissed"), never for server data, text, file names, presigned URLs or link secrets.
  6. **Request isolation during server rendering.** Follow the Next.js 16 guide: create a new `QueryClient` per server render and reuse one in the browser. Create Zustand stores per request through a context provider, never as module-level singletons that could be shared between requests on the server.
  7. **Never cache network- or secret-dependent data on the server.** No `use cache`, Cache Components or `fetch` caching for data whose result depends on the requester's IP (local feed, network status) or on a link secret. A shared server cache would show one network's feed to another. This data is fetched in the browser after hydration. Server prefetch with `HydrationBoundary` is allowed only for data that is neither (for example pricing). Link-viewer content is always fetched client-side, because its secret lives in the URL fragment, which the server never sees.
  8. **Retries:** never retry `4xx` automatically (`401/403/404/409/410` are handled explicitly; `429` waits for `Retry-After`). Retry network errors and `5xx` with backoff.
  9. **Upload progress:** throttle XHR progress events (at most about 10 updates per second per file) before writing to Zustand. Components read it through selectors.
  10. **Link-viewer pages** use TanStack Query with a 30 s refetch interval and refetch on focus. Viewers have no Realtime connection (DEC-005, DEC-011).
  11. **One cache contract per resource:** query keys and `queryOptions` factories live in `lib/client/queries/*`, and every caller imports them from there.
- **Reason:** each kind of state has exactly one owner, so server data is never duplicated or left stale in a client store. TanStack Query provides caching, request de-duplication, retries, mutations and optimistic updates. Zustand is small and selector-based, which suits high-frequency upload progress. Realtime stays a thin signal layer, matching the ID-only payload design. The bundled Next.js 16 docs include a TanStack Query guide for the App Router.
- **Alternatives considered:** Redux Toolkit with RTK Query (more boilerplate), SWR (fewer mutation and cache-manipulation tools), Jotai, React context only (re-render storms from upload progress), Server Components and Server Actions only (DEC-008 keeps security-critical flows off Server Actions, and realtime needs a client cache), Zustand for everything (duplicated server state).
- **Risks:** local content lingering in client caches after leaving a network (RISK-027, rule 3). Library compatibility with React 19 and Next.js 16: pin versions at install and follow the bundled guide (RISK-016). Server-cache leaks across networks (rule 7).
- **Status:** **ACCEPTED** (owner, 2026-09-23) for the three-layer split. The integration rules are proposed details; they can change during the Phase 1 plan review without a change record, as long as the split stays.

### DEC-035 — UI component system: shadcn/ui on Radix

- **Decision (owner):** shadcn/ui is the UI component system. Components are generated into `components/ui/` with the shadcn CLI and owned by the repository.
- **Configuration** (chosen during Phase 0 on 2026-09-29; `components.json`):

| Setting | Value | Why |
|---|---|---|
| CLI | shadcn 4.21 | Current release at install time |
| Component base | **Radix UI** (`radix-ui` package) | 02 and DEC-001 assume Radix primitives for accessible dialogs, menus and toasts. The CLI now defaults to Base UI. |
| Preset | Nova (`radix-nova`): neutral colours, Lucide icons, Geist font | Matches the Geist font already in the layout |
| Theme | CSS variables in `app/globals.css`; dark mode through a `.dark` class | shadcn default. No theme switch yet, so the app renders light until Phase 1 adds one. |
| Class helper | `cn` package (shadcn's replacement for `clsx` + `tailwind-merge`), re-exported from `lib/utils.ts` | Installed by the CLI. Publisher verified: maintainer `shadcn`, npm provenance attestation. |
| `shadcn` package | **devDependency** (the CLI put it in `dependencies`) | Only its CSS (`shadcn/tailwind.css`) is used, at build time, like `tailwindcss`. Keeps about 300 CLI packages out of the production dependency tree. |

- **Consequences:**
  - The document CSP adds `style-src-attr 'unsafe-inline'`. Radix server-renders `style=""` attributes (for example the Progress indicator), which nonces cannot cover. Verified in Phase 0 by building a Radix Progress bar: without the directive the browser blocked the attribute and the bar rendered full width. Attributes cannot run script. `<style>` elements still need the nonce, and `script-src` is unchanged ([03 §11](03-security-and-network-design.md#11-web-security-headers-and-content-security-policy), phase 0 F-7).
  - A future theme switch that sets `.dark` before first paint needs an inline script carrying the CSP nonce.
  - Generated files keep the CLI's code style (no semicolons); they are regenerated rather than hand-edited where possible.
- **Alternatives considered:** Base UI or React Aria as the shadcn base (newer; the docs assume Radix), a hand-built component set (slower, accessibility risk).
- **Status:** **ACCEPTED** (owner, 2026-09-29) for shadcn/ui as the component system. The preset, base colour and theme mechanism are implementation choices that can change before Phase 1 UI work without a change record.

---

## 3. Risk register

Likelihood: L/M/H. Impact: L/M/H/Critical. Status: `OPEN` · `MITIGATING` · `ACCEPTED` · `CLOSED`.

| ID | Risk | Likelihood | Impact | Mitigation | Phase | Status |
|---|---|---|---|---|---|---|
| RISK-001 | Cross-network exposure: different networks behind one public IP that is not recognized as shared (small-ISP CGNAT, campus or enterprise NAT, VPNs missing from lists) see each other's local content. Inherent to DEC-031. | M (higher at low scale, before shared IPs are detected) | **Critical** | DEC-032 fail-closed guards: Private Relay and Tor lists, VPN/hosting/mobile-carrier ASNs, IPv4-with-several-IPv6 detection, large-network cap. Audience indicator (DEC-033). Report and takedown. Shorter default expiry (Q-030). Tests T-001 … T-010. SP-04 measures it. Phase 1: the Apple and Tor lists are loaded by `pnpm egress:load` (weekly runbook), and staging and production **turn local sharing off everywhere** when the lists are missing or older than 14 days (security review M2). **Can be reduced, not eliminated.** | 0–1, 6 | OPEN |
| RISK-002 | Client-IP spoofing via forwarded headers or origin bypass. Under DEC-031 a forged IP would reveal **any network's local content**. | M | **Critical** | DEC-004 origin lock, Tunnel on VPS, spoofing tests from outside Cloudflare (T-008), production refuses the test IP override | 0–1 | OPEN |
| RISK-003 | Hostinger platform unknowns (timeouts, streaming, IP headers, pnpm 12, memory, restarts, outbound TCP) | M | H | SP-01 with pass/fail criteria, VPS or Vercel fallback (DEC-022) | 0 | OPEN |
| RISK-004 | Abuse of free anonymous hosting (malware, phishing, piracy, illegal content, spam) | H | **Critical** | Quotas, rate limits, Turnstile, executable policy, abuse reports, takedown, kill switches, scanning (Phase 6), public beta gate | 1–3, 6 | OPEN |
| RISK-005 | Legal and compliance obligations (GDPR, DMCA, illegal-content reporting, EU DSA, ToS/Privacy/AUP, DPA for Team) | M | H | Legal review before public beta (Q-022), data inventory and retention, operator processes | 2–3, 6 | OPEN |
| RISK-006 | Supabase costs from anonymous devices (MAU likely counted; realtime connections) | M | M | No Supabase users for link viewers, lazy sign-in, hidden-tab disconnects, cost alerts, custom-JWT exit ramp. **Phase 3:** `cleanup-anonymous-users` deletes anonymous users inactive for 30 days with nothing open (never suspended ones, D-9). | 1, 3, 6 | MITIGATING |
| RISK-007 | Realtime authorization cached per connection: a device that left a network (or a removed private-room member) keeps receiving ID-only signals until its token refreshes | M | L | ID-only payloads, cooperative unsubscribe on network change, API re-derives the network on every request, presence expires after 10 min, consider 30-min JWT expiry | 1 | ACCEPTED (mitigated) |
| RISK-008 | One-time download can't confirm completion; partial-download bypass; bots consuming links | H if completion-based | M | DEC-015 burn on claim, POST only, no previews | 3 | OPEN |
| RISK-009 | Presigned URLs are bearer tokens and can be forwarded within their TTL | M | L | 60 s TTL, attachment disposition, per-link issuance limits, logging | 1–2 | ACCEPTED (mitigated) |
| RISK-010 | Upload size and type can't be fully enforced before bytes reach R2 (no POST policy) | M | M | **Signed `Content-Length` and `If-None-Match: *` on the presigned PUT** (storage refuses other sizes and any overwrite; verified on RustFS, R2 in SP-02), exact size and stored-header check at completion (no `Content-Encoding`), a deleted object's key held by a tombstone while its upload URL can still be used (phase 1 F1-12), delete on mismatch, stale-upload sweep, single-PUT cap 5 GiB, multipart part-count control | 1, 4 | MITIGATING |
| RISK-011 | R2 behaviour differs from S3 (response-header overrides, batch delete support, lifecycle lag ≈ 24 h) | M | M | Headers set at upload, SP-02 verification, lifecycle only as backstop. **Phase 3:** the janitor uses single DeleteObject calls only (no DeleteObjects); ListObjectsV2, multipart listing and deleting during a streaming GET were checked on RustFS only (P3-00). SP-02 must repeat them on R2. | 0–3 | OPEN |
| RISK-012 | Storage quota races or drift | M | M | Atomic reservation ledger, daily reconciliation with alerts. **Phase 3:** reconciliation built and race-tested; drift is audited and shown on `/health/cron` (`storageDrift`). | 1, 3 | MITIGATING |
| RISK-013 | Local false negatives: devices on the same Wi-Fi don't see each other (IPv4/IPv6 split, VPN or Private Relay on one device, multi-WAN), or local mode is off (mobile data, most hotspots, large or shared networks) | H | M (UX) | Dual-stack binding (SP-04), clear status copy, link/QR/code fallback (built in Phase 2: Link only where local sharing is off, links from any network), SP-04 measurement | 1–2 | OPEN (mitigated by the Phase 2 fallback) |
| RISK-014 | Chrome Local Network Access gating WebRTC breaks the optional LAN-proof experiment | — | — | SP-05 withdrawn by CR-001. No design depends on WebRTC. | — | CLOSED |
| RISK-015 | Pricing economics: fixed merchant-of-record fees on $3–5 plans; worst-case storage per plan | H | M | $4–5 plus annual plans, total storage quotas, cost model in [07](07-plans-and-entitlements.md) | 4 | OPEN |
| RISK-016 | Next.js 16 and ecosystem churn (proxy rename, library compatibility with Supabase SSR, shadcn, TanStack Query and Zustand) | M | M | Follow bundled docs (including the TanStack Query guide), pin versions, Renovate/Dependabot with CI. Phase 1: Next.js 16.3.5 → 16.3.8 for advisories published after Phase 0 (F1-6); `@supabase/ssr` not used (DV1-14). | 0+ | OPEN |
| RISK-028 | A dependency advisory has no fixed release (currently `braces`, reachable only through dev tooling), or a fix is newer than pnpm's minimum release age | M | L | Advisory-specific ignore with the reason in `pnpm-workspace.yaml`; overrides only to versions past the release-age policy; never add release-age exclusions without review (phase 1 F1-6) | All | ACCEPTED (reviewed) |
| RISK-030 | Short-code guessing spread over many networks (for example many IPv6 /64s or a botnet) gets around the per-network and per-session failure limits | L | M | 50-bit codes valid ≤ 24 h, HMAC-only storage, Turnstile after 5 failures, 24-hour blocks, a global failure alert (`code.resolve_failure_spike`), the `short_codes_enabled` kill switch; a code never reveals the link secret | 2 | OPEN (phase 2) |
| RISK-031 | Takedown is not prompt or evidence-safe: a blocked share's files wait for the next storage sweep (no janitor before Phase 3, lifecycle rule not applied yet), and nothing preserves evidence where the law requires it (for example CSAM reporting duties) | M | H | Access ends at once. **Phase 3 (D-2, D-3):** blocked objects are put on legal hold, the janitor and purge skip them, reported shares are kept, and an operator releases holds after legal review. **Security review (2026-10-16):** R2's lifecycle rules would still have deleted held objects at class period + 1 day after upload (8 days for `d7/`): the hold lived only in the database. Now the janitor copies each held object to `hold/<key>`, which no rule covers, within a minute of the hold, and deletes both after the release. Tested against RustFS with the original deleted as R2 would. **Remaining:**<br>• proof on real R2 (staging);<br>• no copy while the janitor is off or down (`janitorBacklog` alerts after an hour; the lifecycle margin is at least a day before expiry);<br>• objects already gone before a takedown can't be kept;<br>• the janitor token can delete copies (RISK-037);<br>• the legal procedure (Q-022). | 2–3 | MITIGATING |
| RISK-032 | Successful short-code resolutions are not rate-limited (only failures count, as 03 §4.4 designs it): someone holding a valid code can create link sessions and grants without limit while the code lives (≤ 24 h) | L | L | Cloudflare's per-IP rule on `/api/` ([infra/cloudflare/README.md](../infra/cloudflare/README.md) §4, not applied yet); sessions and grants are purged after they expire; a new code or `short_codes_enabled` off stops it. Applying the unlock limits to resolutions would close it, but would add a limit (owner decision, Q-027). | 2 | OPEN (phase 2 review, 2026-10-16) |
| RISK-033 | The per-link unlock limit (30 per 10 minutes) counts every attempt, not only failures: a link opened by more than 30 new browsers in 10 minutes (for example posted to a large group), or someone who knows a link ID sending wrong secrets, makes further unlocks wait up to 10 minutes (`429`) | M | L | Browsers that already unlocked keep access through their grant; a short code or a second link is another way in; the limit is what stops secret guessing (03 §10). Counting only failures would loosen an accepted limit (Q-027). | 2 | OPEN (phase 2 review, 2026-10-16) |
| RISK-034 | One deletion executor (D-1): between a cancelled upload (or a deleted share) and the janitor's next run, about a minute, a still-valid upload URL can store bytes, and deleted bytes stay in storage | M | L | The bytes are never reachable: the file is rejected and the share ended, so completion and downloads answer 404. The janitor then tombstones the key until the URL expires (tested). The lifecycle backstop applies. | 3 | ACCEPTED (owner D-1) |
| RISK-035 | Edge Function CPU (2 s, cumulative per worker) and wall-clock limits are too small for the janitor's batches (plan R3-1) | M | M | Measured locally (P3-00): about 0.6 ms per signed call, at most 500 rows per invocation, a 100 s budget; the egress merge moved out (D-4). Re-measure on staging. | 3 | MITIGATING |
| RISK-036 | Supabase injects full-access secrets into every function, so a compromised janitor or dependency reaches the whole database (plan R3-2) | L | H | Two pinned dependencies with none of their own (aws4fetch 1.0.20, postgres 3.4.9). The secret is checked first and there is no user input. **Security review (2026-10-16):**<br>• Each worker gets `SUPABASE_DB_URL` (user `postgres`), the service-role key, `SUPABASE_SECRET_KEYS` and more.<br>• `Deno.env.delete` silently does nothing and `Deno.env.set` is `NotSupported`, so the function can't remove them. This is a platform trust boundary.<br>• Tested: the code reads only `JANITOR_*` names (a static scan of `supabase/functions`); errors never carry values; with `app_janitor` blocked the real function does nothing.<br>• Mutation check: a function using the injected URL bypassed the role. The least-privilege role prevents mistakes, not a compromise.<br>• The egress refresh is a GitHub Actions job with no Supabase keys. | 3 | OPEN |
| RISK-037 | The janitor's R2 token can read, overwrite and delete every object in its bucket, hold copies included (R2 has no delete-only scope) (plan R3-3) | L | H | A separate token, 90-day rotation (an expiry date on the token), held only in function secrets. **Security review (2026-10-16):** R2's levels are Admin Read & Write, Admin Read only, Object Read & Write and Object Read only. Object Read & Write on one bucket is the narrowest that can delete. Prefix-scoped temporary credentials would need a minting service; IP filtering is impractical, because Supabase Edge Functions have no static egress IPs. Least privilege is not claimed. The scope checks (a 403 on another bucket) are on staging (SP-02). | 3 | OPEN |
| RISK-038 | A burn claim lost to device failure, leaving the network, or a link grant expiring during grace (plan R3-5) | M | L | Grace sized by file size, 3 issuances, "I've got it", the grace-loss warning (copy for owner review) | 3 | ACCEPTED |
| RISK-039 | A creator who opens their own burn link in a browser uses it up (plan R3-4) | M | L | A warning in the share-link dialog (copy for owner review); the creator's app keeps access (D-7) | 3 | ACCEPTED |
| RISK-040 | After a database restore, reconciliation deletes objects uploaded after the backup point (48 hours later) and flags missing ones (plan R3-6) | L | M | The restore runbook switches the janitor off first and checks drift before switching it back on; accepted as part of the RPO | 3 | ACCEPTED |
| RISK-041 | pg_net is fire-and-forget: a failing trigger shows only in `net._http_response` (plan R3-7) | M | L | The janitor writes its own heartbeat; `/health/cron` reports `stalled`, and `jobs: failing` for a missing Vault secret | 3 | MITIGATING |
| RISK-029 | Supabase Auth stores the client IP of every session (`auth.sessions.ip`) and in its audit log, for as long as the session exists. Anonymous sessions can live for months. The app's own tables, query parameters and logs hold no raw IPs (phase 1 F1-13), but the project's database does. | H | M | Owner decision Q-031: state it in the privacy notice and data inventory (03 §13) at least; options are a retention job for old anonymous sessions and audit entries, Supabase session time-boxing (Pro), or accepting it as Supabase's processing under its DPA. **Phase 3:** deleting inactive anonymous users (30 days, nothing open) deletes their Auth sessions and stored IPs with them; Auth's own audit log is unchanged. | 1, 3 | OPEN (phase 1 F1-14), reduced by Phase 3 |
| RISK-017 | Supabase legacy `anon`/`service_role` keys deprecated by end of 2026 | H | L | Use publishable/secret keys from day one, disable legacy keys | 0 | MITIGATING |
| RISK-018 | Janitor deletes the wrong objects (data loss) | L | H | Deletes only from DB-generated outbox rows, key regex, active-share guard, dry-run mode, volume anomaly alerts. **Phase 3, built and tested:** the guard rails are in SQL (key format, no open share, not held), the key is checked a third time in the core, refused rows are parked and alerted, orphans are only queued, `app_janitor` has no table access, there is a kill switch and dry run, and `janitorVolume` is on `/health/cron`. The 24-hour staging dry run is pending. | 3 | MITIGATING |
| RISK-019 | Email deliverability for accounts and invitations | M | M | Custom SMTP provider with SPF/DKIM/DMARC, monitoring | 4 | OPEN |
| RISK-020 | Scope and complexity for a small team | H | H | Strict phase gates, Phase 1 scope discipline, defer experiments, reuse Supabase/Cloudflare primitives | All | OPEN |
| RISK-021 | pnpm 12 lockfile or blocked build scripts (sharp, unrs-resolver) break host or CI builds or image optimization | M | M | SP-01 build test, pin a supported pnpm, adjust `allowBuilds` | 0 | OPEN |
| RISK-022 | Latency or data residency from single-region Supabase and R2 location | L | M | Choose region by target market (Q-016). Document subprocessors. | 0 | OPEN |
| RISK-023 | Realtime replay retention (3–4 days) stores whatever is in payloads | L | M | ID-only payloads (DEC-011) | 1 | ACCEPTED (mitigated) |
| RISK-024 | Anonymous → existing-account merge bugs leak or lose memberships and content | M | M | Proof via anonymous token, transactional merge, dedicated tests | 4 | OPEN |
| RISK-025 | Everyone on the same Wi-Fi sees local content, including guests and strangers on café, hotel, office and campus networks. Users may not realize this before posting. | H | H | Audience indicator and one-time notice (DEC-033), "Link only" option (Phase 2), large-network cap, report button, clear Terms and UI copy | 1 | ACCEPTED — inherent to DEC-031 (owner decision) |
| RISK-026 | An ISP reassigns a public IP (or IPv6 prefix), and its next holder sees local content still live on that network key | L | H | Shorter default expiry for local shares (Q-030), fail-closed classification, measure ISP rotation behaviour in SP-04 | 1 | OPEN |
| RISK-027 | Client-side caches keep a network's local content on screen or in memory after the device leaves that network, or a server-side cache serves one network's feed to another | M (without rules) | M | DEC-034 rules 3, 5 and 7: network-scoped query keys removed on network change, no cache persistence, no server caching of network-dependent data. Phase 1 E2E test extends T-003. | 1 | OPEN |

---

## 4. Open questions

Status: `OPEN` · `ANSWERED` (record the answer and date, and update affected decisions).

| ID | Question | Why it matters | Recommendation | Blocks | Status |
|---|---|---|---|---|---|
| Q-001 | Do you accept "discover automatically, admit once, remember" instead of automatic same-network content visibility? | Core product behaviour and security (DEC-002) | — | Phase 1 | **ANSWERED** 2026-09-23: **No.** Keep automatic same-network visibility with no approval step (DEC-031, CR-001). |
| Q-002 | Phase 1 admission methods: approval + nearby PIN + open-join window, with QR pairing in Phase 2? | Scope | — | — | **ANSWERED** 2026-09-23: withdrawn. Local mode has no admission step (CR-001). |
| Q-003 | Who may admit new devices by default: owner only, or any member? | Security vs convenience | — | — | **ANSWERED** 2026-09-23: withdrawn (CR-001) |
| Q-004 | Should rooms be discoverable by default on normal networks, and can every plan turn discovery off? | Privacy defaults | — | — | **ANSWERED** 2026-09-23: withdrawn. There is no discovery. An uploader who doesn't want network visibility chooses "Link only" (DEC-033). |
| Q-005 | In which country is the business registered, and who handles sales tax/VAT? | Billing provider (DEC-023) | Merchant of record unless Stripe plus in-house tax is feasible | Phase 4 | OPEN |
| Q-006 | Final prices: Pro monthly/annual, Team structure (flat vs per-seat)? | Fee economics, entitlements | Pro $5/mo or $48/yr. Team $15/mo incl. 3 seats + $5/seat. | Phase 4–5 | OPEN |
| Q-007 | Storage quotas: Free active storage and daily upload, Pro total, Team pooled? | Cost control | Free 2 GB active + 2 GB/day. Pro 100 GB. Team 250 GB pooled + add-ons. | Phase 1, 4, 5 | OPEN — Phase 1 assumes the recommendation (phase 1 §17.2) |
| Q-008 | Is one-time download Pro-only (as listed) or also Free? | Plan gates in Phase 3 | Pro-only at paid launch. Optionally enabled for Free during beta. | Phase 3 | **ANSWERED (owner, 2026-10-16):** Pro at paid launch; for Free, the existing runtime flag `free_burn_after_download` decides during beta and testing (default off; production may keep it off until the paid-plan and beta decision). No payment or Pro infrastructure in Phase 3; the entitlement stays `features.burnAfterDownload`. |
| Q-009 | Read-only room links: Pro-only? | Abuse and complexity | Pro-only | Phase 4 | OPEN |
| Q-010 | Executables/scripts in anonymous remote links: block or warn? | Malware distribution | Block until scanning (Phase 6) | Phase 2 | **ANSWERED** 2026-10-16 (owner): **block** executables, scripts, installers and disk images in anonymous/Free remote sharing until scanning exists; archives stay allowed with the existing warning; local sharing is unchanged. Built that way (phase 2 §19.1); Phase 2 had assumed this answer (phase 2 §17.2). |
| Q-011 | Ads on Free: drop, or marketing pages only? | Privacy/security (DEC-024) | Drop ads. Use upgrade prompts instead. | Phase 2 | **ANSWERED for Phase 2** 2026-10-16 (owner): no advertising in Phase 2; remote sharing stays ad-free, and no ad system is built. Ads after Phase 2 (for example on marketing pages, 07 §8) are not decided. |
| Q-012 | Hosting budget and willingness to use a VPS (ops work) or Vercel if Hostinger managed Node fails SP-01? | Hosting fallback (DEC-022) | Hostinger VPS + Cloudflare Tunnel | Phase 0 exit | OPEN |
| Q-013 | Cloudflare plan at launch: Free or Pro (more WAF and rate-limit rules)? | Edge protection | Free for staging and alpha. Evaluate Pro before public beta. | Public beta | OPEN |
| Q-014 | Account sign-in methods: email magic link, Google, Apple, passwords? | Auth scope | Magic link + Google first | Phase 4 | OPEN |
| Q-015 | Transfer history retention: Pro and Team? | Storage, privacy | Pro 1 year. Team configurable up to 2 years. | Phase 4–5 | OPEN |
| Q-016 | Primary markets/regions? | Supabase region, R2 location, legal scope | Decide before creating production projects | Phase 0 | OPEN |
| Q-017 | Team retention: allow "no expiry" within quota? Maximum retention? | Storage liability | Allow no expiry within quota. Admins set a maximum. | Phase 5 | OPEN |
| Q-018 | Branded share pages: logo/colours/name on our domain only, or custom domains? | Complexity | Logo/colours/name only. Custom domains later. | Phase 5 | OPEN |
| Q-019 | Browser support baseline? | Next.js 16 minimums are Chrome/Edge/Firefox 111+ and Safari 16.4+, but Tailwind CSS 4 (DEC-035) compiles for Chrome 111, Safari 16.4 and **Firefox 128** | Accept **Chrome/Edge 111+, Firefox 128+, Safari 16.4+** | Phase 1 | OPEN — Phase 1 assumes the recommendation (Firefox corrected to 128+ on 2026-10-15, phase 1 §18.6) |
| Q-020 | Product name and production and staging domains? | CORS, CSP, cookies, Turnstile, R2 CORS, email | Decide in Phase 0 | Phase 0 exit | OPEN |
| Q-021 | Who may edit a text item: only its creator, or anyone who can see it? | Collaboration vs vandalism. Under DEC-031 "anyone who can see it" includes strangers on public Wi-Fi. | Local shares: **creator only**; everyone present can copy the text. Private and workspace rooms (Phase 4–5): any member. | Phase 1 | OPEN — Phase 1 assumes the recommendation (phase 1 §17.2) |
| Q-022 | Who handles abuse reports and legal requests, and who reviews ToS/Privacy/AUP? | Legal readiness | Named operator plus external legal review | Public beta | OPEN — Phase 2 built the report intake (stored, audited, logged as `abuse.report_received`), the takedown functions and legal drafts with `[OWNER]` placeholders. **Owner decision 2026-10-16:** Phase 2 delivers no alert to a person and must not claim one; the named operator, the alert channel (email, chat, SMS or pager), the contact address and the evidence procedure stay future operational requirements that wait for this answer (phase 2 §19.1). **Phase 3 (2026-10-16):** the uptime-monitor design (D-5) needs an alert recipient (**[OWNER]**); takedown objects are held (D-2) and reported shares kept (D-3), but how long evidence is kept, and how it is preserved past the R2 lifecycle period, needs legal advice. |
| Q-023 | Do you accept that Phases 1–2 are internal/invite-only and public beta starts after Phase 3 and the launch gate? | Launch timing | Accept | Phase 1 | OPEN — Phase 1 assumes the recommendation (phase 1 §17.2) |
| Q-024 | Keep the uncommitted pnpm 12.4.2 bump? | Build compatibility | Decide after SP-01 | Phase 0 | OPEN |
| Q-025 | Are native (mobile/desktop) apps on the long-term roadmap? | The only way to identify the actual LAN (mDNS/Bonjour) instead of the public IP, which would remove RISK-001 for app users | Not now. Revisit after product-market fit. | — | OPEN |
| Q-026 | Billing in Phase 4 (recommended) or Phase 6 (originally proposed)? | Paid launch timing | Phase 4 | Phase 4 | OPEN |
| Q-027 | Should anonymous users be allowed to create remote links at all, or with tighter caps that a verified (free) account lifts? | Abuse vs "no account required" | Phase 2: allow anonymous links under the Free caps in [03 §10](03-security-and-network-design.md#10-rate-limiting-and-abuse-protection) (for example 500 download-URL issuances/day per link, executable block). Phase 4: a free, email-verified account may get higher caps. | Phase 2 | **ANSWERED** 2026-10-16 (owner): keep the conservative design as implemented: per-link daily URL caps, unlock, short-code and report limits, Turnstile escalation and the kill switches. Nothing is loosened and nothing added. Values: phase 2 §19.2. |
| Q-028 | Should anyone be able to send a remote person a link or QR code to a **whole network's feed**? | It would show other people's local uploads to someone off the network | **No.** Remote links target one share (Free) or a Pro/Team private or workspace room. | Phase 2 | **ANSWERED** 2026-10-16 (owner): **No.** A remote link exposes only its one share: never a network feed, a network space, other people's local shares, presence, device lists or network identifiers. Link-only shares stay out of every local feed. Built and tested that way (phase 2 §19.3). |
| Q-029 | Large-network cap: switch local mode off above how many distinct devices per 24 h? | Too low breaks offices and cafés. Too high lets an undetected shared IP (campus, carrier NAT) group thousands of strangers. | **50**, configurable, tuned from SP-04 and production data. Fail closed (content hidden) while over the cap. | Phase 1 | OPEN — Phase 1 assumes the recommendation (phase 1 §17.2) |
| Q-030 | Default expiry for local shares? | A shorter default limits exposure from IP reassignment (RISK-026) and forgotten posts on public Wi-Fi | **24 h default**, with 1 h / 24 h / 7 days selectable on Free (7 days stays the maximum) | Phase 1 | OPEN — Phase 1 assumes the recommendation (phase 1 §17.2) |
| Q-031 | Supabase Auth keeps the client IP of each session and in its audit log (RISK-029). Accept and disclose, add a retention job, or time-box sessions? | Privacy: "no raw IPs" is true for the app's tables but not for the Supabase project | Disclose it in the privacy notice now; add a job in Phase 3 that removes anonymous sessions and audit entries older than 30 days once SP-03 confirms it is safe on hosted Supabase | Phase 1 (disclosure), Phase 3 (job) | OPEN — raised in phase 1 §18.5 |

---

## 5. Change records

### CR-001 — Keep automatic same-network visibility (changes DEC-002 and DEC-003)

| Field | Record |
|---|---|
| Date | 2026-09-23 |
| Previous decision | **DEC-002** (PROPOSED): network signals only *suggest* nearby rooms. Content access needs membership, obtained by approval, a nearby PIN, an owner-opened join window, a QR/invite secret or workspace membership, and is remembered across networks. **DEC-003** (PROPOSED): short-lived network hints used only for discovery. |
| Reason for change | **Owner decision.** The core product rule is: on the same Wi-Fi/network, anyone automatically sees uploaded files, text and images; on a different network, nothing is visible automatically; remote access is only through a QR code, link or share code. The owner explicitly declined approval-based sharing. |
| New decision | **DEC-031** (ACCEPTED): automatic same-network visibility. **DEC-032** (PROPOSED): network keys, dual-stack binding and fail-closed eligibility guards. **DEC-033** (PROPOSED): local share permissions and remote reach. DEC-011, DEC-012, DEC-018 and DEC-020 revised to match. |
| Impact on implementation | No code exists, so there is nothing to migrate. Plan changes: <br>• Removed: nearby discovery, admission (approval, PIN, open-join window), LAN-proof auto-admit, SP-05, and the tables `network_observations`, `network_rooms`, `room_join_requests`, `room_pins`, `room_blocks`.<br>• Added: `network_spaces`, `network_presence`, dual-stack binding tables, and share scopes (`network`, `link_only`, `room`).<br>• Moved: rooms, members and invites/QR pairing now start in **Phase 4** with Pro private rooms. Free local mode has no rooms.<br>• Risks: RISK-001 and RISK-002 raised to Critical impact under the new model. RISK-025 and RISK-026 added. RISK-014 closed.<br>• Questions: Q-001 answered; Q-002, Q-003 and Q-004 withdrawn; Q-028, Q-029 and Q-030 added.<br>• Documents updated: 00, 02, 03, 04, 05, 07, 08, 09, 10, README and phases 0–6. |
| Inherent consequences (cannot be designed away) | Everyone on the same Wi-Fi sees local content (RISK-025). Different networks behind one shared IP that is not yet detected can see each other's local content (RISK-001). An ISP reassigning an address can expose content still live on it (RISK-026). The brief's line "public IP must not be treated as authorization" no longer holds for local mode: the Cloudflare-verified network is now the access rule for local content, narrowed by the guards in DEC-032. |
| Migration / rollback plan | None needed (planning only). Reinstating an approval step later would need a new change record and would reintroduce room membership in Phase 1. |
| Approved by | Project owner, by instruction in the planning session, 2026-09-23 |
