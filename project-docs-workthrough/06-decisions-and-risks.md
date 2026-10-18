# 06 — Decisions, Risks and Open Questions

| Field | Value |
|---|---|
| Document status | LIVING DOCUMENT |
| Last updated | 2026-10-18 (Phase 4, P4-25: Phase 4 notes on DEC-005, DEC-006, DEC-008, DEC-010 … DEC-021, DEC-023, DEC-025, DEC-026, DEC-029 and DEC-033; the Phase 4 decisions D4-1 … D4-31 recorded with their status; RISK-042 … RISK-055 added; RISK-006, RISK-007, RISK-010, RISK-011, RISK-015, RISK-019, RISK-020, RISK-024, RISK-029 and RISK-036 updated; Phase 4 notes on Q-005, Q-006, Q-007, Q-009, Q-010, Q-014, Q-015, Q-016, Q-020, Q-021, Q-022, Q-026, Q-028 and Q-031). 2026-10-16 (Phase 3 security review: RISK-031, RISK-036 and RISK-037 updated; D-2 note). 2026-10-16 (Phase 3 implementation: owner decisions Q-008 and D-1 … D-9 recorded on DEC-015 … DEC-019 and DEC-029; Q-008 answered; Q-022 note; RISK-006, RISK-011, RISK-012, RISK-018, RISK-029 and RISK-031 updated; RISK-034 … RISK-041 added). 2026-10-16 (Phase 2 owner decisions: Q-010, Q-027 and Q-028 answered, Q-011 answered for Phase 2; owner notes on DEC-013 (link lifetime), DEC-024, DEC-025, DEC-033; Q-022 note (no alert delivery in Phase 2); RISK-032 and RISK-033 added after the implementation review). 2026-10-15 (Phase 2: implementation notes on DEC-013, DEC-014, DEC-024, DEC-025, DEC-033; Q-010, Q-011, Q-027, Q-028 assumed for Phase 2; Q-022 note; RISK-030 and RISK-031 added). Earlier the same day: (Phase 1 implementation notes on DEC-005, DEC-011, DEC-020, DEC-032; RISK-001, RISK-010 and RISK-016 updated after the Phase 1 security review; RISK-028 added; second review pass: RISK-029 and Q-031 added, Q-019 note (Firefox 128), RISK-010 note; Q-007/019/021/023/029/030 assumed for Phase 1). Earlier: 2026-09-29 (DEC-001 shadcn/ui accepted; DEC-035 UI component system added.) Earlier: 2026-09-23 (CR-001: owner kept automatic same-network visibility. DEC-001 Next.js accepted. DEC-034 frontend state management accepted.) |

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
- **Phase 4 implementation (2026-10-16 … 18, [phase 4 §18](phases/phase-4-pro-accounts.md#18-phase-4a-implementation-2026-10-16), [ARCHITECTURE §5.3](ARCHITECTURE.md#53-authentication-and-sessions)):** permanent accounts are built. Not verified on hosted Supabase.
  - **Sign-in:** one email with a code and a link (D4-2), plus Google (code paths only, tested with a stub: no OAuth client exists). No passwords: the API and Realtime refuse password sessions, and an account's password is removed when it registers a device (finding F4-2, DV4-9; residual RISK-051).
  - **Upgrade** keeps the user ID (`updateUser({ email })`, confirmed by a code). **Merge:** signing in to an existing account from an anonymous browser redeems a device-bound merge intent (24 h, D4-3); one transaction moves shares, links, history, claims, reservations and room memberships, then deletes the anonymous user (P4-21's coverage list, RISK-024).
  - **Devices:** each is bound to one Auth session (`devices.auth_session_id`). Revocation deletes that session, and `net:` and `room:` access are checked per device (C4-2). Up to 10 devices per account (D4-5).
  - **Account deletion:** 7 days' read-only grace, then the hourly job (P4-22; D4-6 open). **MFA:** optional TOTP; an account with one needs `aal2` on every route and topic (P4-24, DV4-146).
  - Link viewers still create no Supabase user.
- **Status:** PROPOSED

### DEC-006 — Data-access boundary

- **Decision:** application tables live in the private `app` schema, **not exposed** through the Data API. Only the Next.js server (role `app_server`) reads and writes them. Browsers use Supabase only for Auth and Realtime. RLS is enabled everywhere with server-only policies as defense in depth.
- **Reason:** a single enforcement point for authorization, entitlements, quotas and rate limits. Clients cannot bypass the API through PostgREST.
- **Alternatives considered:** browser supabase-js with RLS for everything (logic spread across policies, entitlements and rate limits bypassable, hard to test). Server calls through PostgREST with the secret key (no multi-statement transactions without RPC).
- **Phase 4:** every new table is in `app` with RLS. `subscriptions`, `entitlement_overrides`, `billing_customers`, `billing_events` and `billing_disputes` are read-only for `app_server`; definer functions or operator SQL write them. Definer functions owned by the migration role change `auth.users` and `auth.sessions` (merge, revocation, account deletion); that right is confirmed on the local stack only (phase 4 S4-2).
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
- **Phase 4C:** a second pipeline, `withWebhook`, serves exactly two routes: the provider webhook and the internal billing reconcile route. It has no Origin check, reads the raw body with a size cap and checks the signature (or bearer secret) first. A unit test keeps it to those two routes ([phase 4 §20.4](phases/phase-4-pro-accounts.md#204-security-protections-as-built-1710)).
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
- **Phase 4 (P4-15):** extend by copy writes a new key in a longer class, dated the day of the request, ending in a **fresh UUID** instead of the file ID, unique and never reused (DV4-55). The old key goes through the outbox as `superseded` ([ARCHITECTURE §7.10](ARCHITECTURE.md#710-extending-a-share-phase-4d-p4-15)). Keys stay PII-free.
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
- **Phase 4 implementation (2026-10-16 … 18, [ARCHITECTURE §12.4](ARCHITECTURE.md#124-channel-authorization)), local stack only:**
  - `net:` now needs the caller's own **device** to be present, not just its user (device-session binding, C4-2).
  - Private rooms use `room:{roomId}`: active members of the open room whose session is bound to a non-revoked device of theirs, not suspended. No presence on room topics (P4-17).
  - New ID-only signals: `member.changed`, `room.updated` and `room.deleted` on the room topic; `membership.changed` and `account.changed` on the person's `user:` topic.
  - An account with an authenticator joins no topic below `aal2` (P4-24).
- **Status:** PROPOSED — verified in SP-03. Revised 2026-09-23 for CR-001 (network topics instead of nearby-room membership).

### DEC-012 — Content model

- **Decision:** a **share** (a bundle of files, or one text item) → `files` / `text_items`. Each share has a scope:
  - `network`: posted to a network space and visible to devices currently on that network (local mode, DEC-031).
  - `link_only`: visible only to its creator and to holders of its links (Phase 2).
  - `room`: posted to a Pro private room or a Team workspace room (Phase 4–5).

  `share_links` grant remote access to one share, or read-only access to a private or workspace room (Pro/Team).
- **Reason:** bundles map to multi-file sends and single links. Per-share lifecycle (expiry, burn) matches user intent. Local mode needs no room object, because a network has no owner or members.
- **Alternatives considered:** flat items (multi-file links harder), links as the only container, modelling each network as a room with members (the rejected DEC-002).
- **Phase 4 (P4-17, P4-19):** the `room` scope exists for Pro private rooms: a room share has its room and never a network space. `share_links.target_type = 'room'` gives read-only room links ([ARCHITECTURE §9.10](ARCHITECTURE.md#910-private-rooms-phase-4d-p4-17-p4-18-p4-19)). Workspace rooms wait for Phase 5.
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
- **Phase 4 implementation (2026-10-17 … 18):**
  - A link made without its own expiry follows the share's, also after an extend (`follows_share_expiry`, P4-15).
  - Optional passwords (Pro) are checked on the grant on every viewer route, also for grants made by a code; every change or removal invalidates the link's grants (P4-16, DEC-021, [ARCHITECTURE §9.9](ARCHITECTURE.md#99-password-protected-links-phase-4d-p4-16)).
  - Read-only room links (Pro, P4-19) use the same unlock, grant and viewer path. They last 1 hour to 30 days, never follow a share's expiry and have no short code (DV4-108). Viewers still get no Supabase user.
- **Status:** PROPOSED

### DEC-014 — Short share codes

- **Decision:** 10-character Crockford Base32 (50 bits), HMAC-stored. Default validity 1 h (Free ≤ 24 h, Pro ≤ 7 days). Rate limits with Turnstile escalation. Resolving creates a grant and never reveals the link secret.
- **Reason:** typable yet brute-force resistant at scale ([03 §4.4](03-security-and-network-design.md#44-short-codes-dec-014)).
- **Alternatives considered:** 8 characters (≈ 0.9 expected hits per day under a 10⁶ guesses/day attack with 10⁶ active codes), 6-digit global codes (unsafe), word lists (longer).
- **Phase 2 implementation (2026-10-15):** as decided, with failure-only counters, a 24-hour block from the 20th failure, codes clamped to their link's expiry (DV2-14) and a "new code" endpoint (DV2-5); without Turnstile configured the escalation is a wait (DV2-19). Residual risk RISK-030.
- **Phase 4:** Pro codes last up to 7 days, never past their link (E14); a new code follows the creator's current plan (D4-12). A code for a password link makes a grant that still needs the password (C4-8). Room links get no code: a database check, and the code route answers `404` (DV4-108, waiting for the owner).
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
- **Phase 4:** the Pro plan has burn after download (E10). In a private room, members and room-link viewers claim like anyone else (P4-17, P4-19). Account deletion consumes the burn claims the account still holds in their grace (DV4-130).

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
- **Phase 4 (2026-10-16 … 18):**
  - `end_share` accepts `room_deleted` and `account_deleted`: deleting a room or an account ends its content through it.
  - New outbox reasons: `multipart_abort` (every row for an unverified multipart file carries its upload ID, DV4-45), `superseded` and `extension_cancelled` (P4-15). The deletion claim gains the guard rail `extension_pending`.
  - Retention follows the snapshot: tombstones and download logs of shares and links created on Pro are kept 365 days (Q-015, C4-17).
  - Account deletion is a scheduled job, `delete-due-accounts`, hourly (DV4-136; DEC-017).

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
- **Phase 4 (2026-10-17 … 18, [ARCHITECTURE §10.6](ARCHITECTURE.md#106-scheduled-jobs-pg_cron)):**
  - **New pg_cron jobs, through `app.run_job`:** `delete-due-accounts`, hourly at :23 (P4-22, DV4-136); `trigger-billing-reconcile`, daily at 05:16.
  - **Billing reconciliation** posts through pg_net to the web app's internal route (D4-22), so billing secrets stay in the web tier and never reach an Edge Function. It runs only while the `billing_reconcile` flag is on (off; DV4-36).
  - **The janitor** also aborts multipart uploads (P4-14) and makes extension copies with `CopyObject` (P4-15). A 5 GiB copy took 24 s on RustFS; R2's limit and the Edge wall clock are SP-02.

### DEC-018 — Entitlements model and enforcement location

- **Decision:** plans defined in typed code, overrides in the database, resolved per request on the server, enforced in services on every write path. Snapshots stored on shares and links. **The uploader's plan** governs local, link-only and private-room shares. **The workspace plan** governs workspace rooms.
- **Phase 3 (Q-008, owner 2026-10-16):** burn after download is `features.burnAfterDownload`, which only Pro will have. During beta and testing the Free plan may also use it while the runtime flag `free_burn_after_download` is on (**default off**). It is gated at creation only, the share's snapshot records the grant, and there is no payment or Pro infrastructure. `GET /api/v1/me/entitlements` tells the UI.
- **Phase 4B (2026-10-16, [phase 4 §19](phases/phase-4-pro-accounts.md#19-phase-4b-implementation-2026-10-16), [ARCHITECTURE §5.9](ARCHITECTURE.md#59-plans-and-entitlements-phase-4b)), built as decided:**
  - Free and Pro are typed code (`lib/shared/plans.ts`, binary units, D4-9). Resolution runs per request on the server (`lib/server/entitlements/`), from the subscription and operator overrides read through `app.entitlement_state` with the database's clock. Anonymous users are always Free.
  - Overrides live in `app.entitlement_overrides`, limited to a whitelist and written only by audited operator SQL functions.
  - Snapshots (v2) are stored on shares and links, with a rule per field after a downgrade (D4-12, phase 4 §19.4).
  - Services enforce the matrix on every write path (E1 … E31, [phase 4 §19.3](phases/phase-4-pro-accounts.md#193-the-enforcement-matrix-as-built)): 4B built the rows whose features existed, and each later task added its own. A refusal names `requiredPlan: "pro"` only when Pro would allow the action.
  - Until a billing provider exists (Q-005), Pro comes only from an operator override. The workspace plan is Phase 5.
- **Reason:** server-side enforcement, predictable behaviour after plan changes.
- **Alternatives considered:** plans only in database rows (harder to type and test), client-side gating (insecure).
- **Status:** PROPOSED

### DEC-019 — Storage quota accounting

*Phase 3 (2026-10-16):* daily reconciliation is built (`app.reconcile_storage_usage`): it locks the ledger row and then recounts, which is race-free (tested with 20 concurrent completions), and audits drift above max(1 MiB, 0.1 %). The 7-day staging soak (AC-3.5) is pending.

*Phase 4 (2026-10-16 … 18):*
- Pro's quota is 100 GiB and its daily volume 200 GiB (D4-9); Pro volume isn't counted per network (D4-10).
- The daily volume is charged after the reservation succeeds, and refunded when a share never becomes active, in the same window (C4-6, D4-26, DV4-29).
- A share with a multipart file holds its reservation for 26 hours (DV4-46). An extension copy doesn't change the quota (RISK-049).
- A merge sums the anonymous user's ledger into the account; account deletion deletes the ledger row (P4-21).

- **Decision:** a per-subject ledger. Atomic conditional reservation at init, commit on verification, release on failure or end. Daily reconciliation.
- **Reason:** race-free quota enforcement without table-wide locks.
- **Alternatives considered:** `SUM()` at upload time (slow, racy). R2 has no per-user quotas.
- **Status:** PROPOSED

### DEC-020 — Rate limiting layers

- **Decision:** a coarse Cloudflare edge rule plus Postgres fixed-window counters (`app.rate_limit_hit`) keyed by device, user, network key, link and room. Turnstile escalation. Move to Redis only if database load requires it.
- **Reason:** no new vendor for the MVP, works across instances, precise keys.
- **Alternatives considered:** in-memory limits (lost on restart, per instance), Upstash Redis from day one (extra vendor).
- **Phase 1 implementation (2026-10-15):** Postgres counters per device, user and network space for every Phase 1 action ([03 §10](03-security-and-network-design.md#10-rate-limiting-and-abuse-protection)); daily volumes counted in KiB. The Cloudflare edge rule waits for the zone (Phase 0).
- **Phase 4:** Pro creates up to 300 shares and 300 links an hour (D4-29). Device registration counts per Auth session, not per user (DV4-3). New limits cover accounts, rooms, invites (per invite and per network key, before any lookup), link passwords (per link, network key and session, with failure slots reserved before each hash) and billing ([ARCHITECTURE §5.8](ARCHITECTURE.md#58-rate-limits)).
- **Status:** PROPOSED

### DEC-021 — Link password hashing

- **Decision:** Argon2id (m = 19 MiB, t = 2, p = 1) via `@node-rs/argon2`. PHC strings. Versioned grants. Attempt limits.
- **Reason:** OWASP-recommended, memory-hard, prebuilt Linux binaries.
- **Alternatives considered:** scrypt via `node:crypto` (fallback if native binaries fail on the host), bcrypt (72-byte input limit).
- **Status:** PROPOSED (Phase 4)
- **As built (P4-16, 2026-10-17):** scrypt (N = 2¹⁷, r = 8, p = 1), D4-24's built-in option, because no package was approved; versioned grants and attempt limits as planned (phase 4 §23, DV4-70). Switching to Argon2id later needs the package approved and a rehash on the next successful check.
  - **Argon2id is not used anywhere.** The database accepts only the scrypt PHC format (`$scrypt$ln=17,r=8,p=1$…`).
  - One hash costs about 0.4 s of a core and 128 MiB; at most 4 run at once per process, and every limit is checked before the hash. The cost on the chosen host is a staging item (SP-01).
  - **Waiting for the owner:** confirm scrypt (DV4-70) or approve `@node-rs/argon2` for a later switch ([phase 4 §23.8](phases/phase-4-pro-accounts.md#238-dependencies-owner-decisions-and-next-steps)).

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
- **Phase 4C (2026-10-17, [phase 4 §20](phases/phase-4-pro-accounts.md#20-phase-4c-implementation-the-provider-neutral-billing-core-2026-10-17), [ARCHITECTURE §5.10](ARCHITECTURE.md#510-billing-phase-4c-provider-neutral-core), [billing runbook](runbooks/billing.md)): a provider-neutral core, no provider.**
  - **Built:** provider-agnostic `subscriptions`, `billing_customers`, `billing_checkouts` and `billing_disputes`, and an idempotent webhook log (`billing_events`). A webhook is verified on its raw body; the app then **fetches the state from the provider** and applies it in order (`apply_subscription_state`). Daily reconciliation, hosted checkout and portal, and `/settings/billing`. D4-21 and D4-22 are built as recommended, waiting for the owner.
  - **The only adapter** talks to a local fake provider for tests and development; it is refused in production builds and deployments.
  - **Not built:** the real adapter (P4-13), the provider's sandbox and one real transaction (AC-4.3), all waiting for Q-005. Prices wait for Q-006.
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
- **Phase 4:**
  - Pro links block the same file types (D4-11, built as recommended, waiting for the owner; RISK-047).
  - Posting into a private room isn't subject to the remote policy, because a room is members-only (DV4-97, waiting for the owner).
  - A room link applies the policy per file at download, under its own snapshot, and lists blocked files as such (DV4-112).
- **Status:** PROPOSED; the remote executable policy accepted by the owner on 2026-10-16 (Q-010)

### DEC-026 — Upload transport by size

- **Decision:** single presigned PUT for files ≤ 100 MB (Phase 1). Multipart for larger files (Phase 4): equal parts ≥ 16 MiB, resumable, verified with `ListParts`.
- **Reason:** simple for Free. R2's single-PUT limit is 5 GiB, and it has multipart part-size rules.
- **Built in Phase 4 (P4-14, 2026-10-17, [phase 4 §21](phases/phase-4-pro-accounts.md#21-phase-4d-first-task-p4-14-multipart-uploads-2026-10-17), [ARCHITECTURE §7.9](ARCHITECTURE.md#79-multipart-uploads-phase-4d-p4-14)):** files above 100 MiB use multipart, up to Pro's 5 GiB.
  - Equal parts of `max(16 MiB, size / 9,000)`, rounded up to a MiB. Each part URL signs its `Content-Length`.
  - Completion takes no part list from the client: it checks every part with `ListParts`. A missing part keeps the upload resumable (`409 MULTIPART_INCOMPLETE`, DV4-44).
  - Resume after a reload uses small local metadata plus `ListParts` (D4-25). No `Content-MD5` (DV4-48).
  - The janitor aborts cancelled, failed and abandoned uploads (RISK-050).
  - Tested on RustFS only (once at 5 GiB). R2's equal-part rule and limits are SP-02.
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
- **Phase 4:** `/health/cron` gains `billingWebhooks`, `billingReconcile` and `extensions`; the deletion job reports through `jobs`. Still no monitor is configured, so nothing alerts anyone.
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
- **Phase 4 (P4-17 … P4-19):** a private room is a third destination. Creating one needs Pro; anyone invited may join, anonymous browsers too (D4-19). A room is never visible on a network, and its signals never reach a `net:` topic. A read-only room link (Pro, made by the room's owner) is the room-level remote reach. There is still no link to a network's feed.
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

### Phase 4 decisions (D4-n)

Phase 4's plan listed decisions D4-1 … D4-30 with a recommendation each, none of them made ([phase 4 §17.17.2](phases/phase-4-pro-accounts.md#17172-new-decisions-this-plan-needs)); building added D4-31. Each task built the recommendation where its work needed one, on the owner's instruction to build the task. **That instruction is not an answer to the decision:** apart from D4-1, every row still waits for the owner. Section numbers below are phase 4's. Nothing here is VERIFIED.

| ID | Subject | What was built | Status |
|---|---|---|---|
| D4-1 | Start Phase 4 before Phase 3 is VERIFIED | Phase 4 built task by task on top of `cc2ac40`, uncommitted | **Owner decision recorded** 2026-10-16: the instruction to proceed with 4A answers it (§18); each later task followed its own instruction |
| D4-2 | Sign-in methods (Q-014) | One email with a code and a link, the link followed only on **Continue** (DV4-143); Google code paths, stubbed (no OAuth client); no passwords (DV4-9) | Built as recommended, waiting for the owner (§18.8) |
| D4-3 | Merge proof | A merge intent bound to the anonymous browser's device, 24 hours, its secret stored as an HMAC (DV4-5) | Built as recommended, waiting for the owner (§18.8) |
| D4-4 | Merge with restrictions | Suspended sources refused; `upload_restricted` carried over; a suspended creator's links make no new grants (DV4-27) | Built as recommended, waiting for the owner (§18.8, §19.9) |
| D4-5 | Device cap | 10 devices for every account | Built as recommended, waiting for the owner (§18.8) |
| D4-6 | Account deletion grace and scope | 7 days, read-only (E30's list, DV4-26), cancellable until the date (DV4-137). Suspended accounts are **not** deletable (DV4-13). | **Open.** Partly built as recommended; the grace, the read-only scope and suspended accounts wait for the owner (§29.9) |
| D4-7 | App-sent email | None: Supabase Auth sends every email; the app has no email code | Built as recommended, waiting for the owner (§30) |
| D4-8 | SMTP provider and sending domain | Nothing chosen. Candidates, DNS records and the staging checks are written down in [`infra/email/README.md`](../infra/email/README.md) | **Open** (with Q-020); blocks P4-23's staging half (§30.9) |
| D4-9 | Pro limits and units | Binary units: 5 GiB files, 100 GiB storage, 200 GiB a day, 100 files, 1 MiB text | Built as recommended, waiting for the owner (§19.9) |
| D4-10 | Pro and the per-network daily cap | Pro volume isn't counted per network | Built as recommended, waiting for the owner (§19.9) |
| D4-11 | Executables in Pro links | Blocked, as on Free (E16) | Built as recommended, waiting for the owner (§19.9) |
| D4-12 | Snapshot or current plan | Text edits by the snapshot; codes and link options by the current plan; removing a password always allowed | Built as recommended, waiting for the owner (§19.9) |
| D4-13 | Extend rules | At most now + 90 days; burn shares not extendable; `follows_share_expiry` with a backfill | Built as recommended, waiting for the owner (§22.9) |
| D4-14 | Room limits | 20 rooms per owner, 50 members per room, from the room's snapshot | Built as recommended, waiting for the owner (§24.10) |
| D4-15 | What members and invitees see | A display name or device label; a room preview only after the secret. A removed creator keeps deleting and their existing links, not editing or new links (DV4-93). | Built, with DV4-93's narrower reading; waiting for the owner (§24.10) |
| D4-16 | A downgraded owner's invites and room links | Existing ones keep working; new pairing codes allowed; new invite links and room links refused (DV4-102) | Built as recommended, waiting for the owner (§25.8) |
| D4-17 | Room-link lifetime | 1 hour, 24 hours, 7 days or 30 days | Built as recommended, waiting for the owner (§26.8) |
| D4-18 | Owner leaving a room | Delete only; the owner can't leave | Built as recommended, waiting for the owner (§24.10) |
| D4-19 | Anonymous room members | Allowed | Built as recommended, waiting for the owner (§24.10) |
| D4-20 | History contents | Actor kinds only; no deleting single entries; someone else's link by kind only (DV4-124) | Built as recommended, waiting for the owner (§27.8) |
| D4-21 | Billing behaviours | Hosted checkout; 7-day grace from the failure (DV4-40); a full refund ends Pro; a lost dispute is confirmed with the provider, and the second restricts uploads (DV4-32) | Built in the core against the fake provider, waiting for the owner (§20.9) |
| D4-22 | Billing reconciliation runtime | pg_net → internal route, daily, behind the `billing_reconcile` flag (DV4-36) | Built as recommended, waiting for the owner (§20.9) |
| D4-23 | Operator web admin | Not built; operators use SQL and the runbooks | **Open**; the recommendation is Phase 6 (§31.9) |
| D4-24 | Password hashing | scrypt (N = 2¹⁷, r = 8, p = 1), the plan's fallback, because no package was approved (DV4-70) | Built with the fallback; waiting for the owner: confirm, or approve `@node-rs/argon2` (§23.8, DEC-021) |
| D4-25 | Multipart resume state | localStorage metadata; `ListParts` is the truth | Built as recommended, waiting for the owner (§21.9) |
| D4-26 | Daily volume for failed uploads | Charged after the reservation; refunded when the share never becomes active, in the same window (DV4-29) | Built as recommended, waiting for the owner (§19) |
| D4-27 | Multipart at a downgrade | An upload begun on Pro may finish | Built as recommended, waiting for the owner (§21.9) |
| D4-28 | Phase 1–3 tests asserting that Phase 4 is refused | Rewritten with their intent kept, each recorded as a deviation (DV4-2, DV4-18, DV4-35 and later) | Applied as recommended, waiting for the owner |
| D4-29 | Pro rate limits | 300 shares and 300 links an hour; the rest as Free | Built as recommended, waiting for the owner (§19.9) |
| D4-30 | Re-authentication and MFA | A sign-in within 10 minutes for deletion. `aal2` with an authenticator for deletion, removing the authenticator, revoking from a session without a device and, wider than recommended, every route and topic (DV4-146). | Built, wider than recommended; waiting for the owner (§29.9, §31.9) |
| D4-31 | An Auth hook refusing password sign-ins on hosted projects (new, §18.2) | Not built | **Open** (RISK-051) |

---

## 3. Risk register

Likelihood: L/M/H. Impact: L/M/H/Critical. Status: `OPEN` · `MITIGATING` · `ACCEPTED` · `CLOSED`.

**Phase 4's risks, RISK-042 … RISK-055, are proposed.** [Phase 4 §17.23](phases/phase-4-pro-accounts.md#1723-risks) and its task sections (§18–§31) raised them; the owner has accepted none. Phase 4 rated none of them, so their likelihood and impact are proposals too.

| ID | Risk | Likelihood | Impact | Mitigation | Phase | Status |
|---|---|---|---|---|---|---|
| RISK-001 | Cross-network exposure: different networks behind one public IP that is not recognized as shared (small-ISP CGNAT, campus or enterprise NAT, VPNs missing from lists) see each other's local content. Inherent to DEC-031. | M (higher at low scale, before shared IPs are detected) | **Critical** | DEC-032 fail-closed guards: Private Relay and Tor lists, VPN/hosting/mobile-carrier ASNs, IPv4-with-several-IPv6 detection, large-network cap. Audience indicator (DEC-033). Report and takedown. Shorter default expiry (Q-030). Tests T-001 … T-010. SP-04 measures it. Phase 1: the Apple and Tor lists are loaded by `pnpm egress:load` (weekly runbook), and staging and production **turn local sharing off everywhere** when the lists are missing or older than 14 days (security review M2). **Can be reduced, not eliminated.** | 0–1, 6 | OPEN |
| RISK-002 | Client-IP spoofing via forwarded headers or origin bypass. Under DEC-031 a forged IP would reveal **any network's local content**. | M | **Critical** | DEC-004 origin lock, Tunnel on VPS, spoofing tests from outside Cloudflare (T-008), production refuses the test IP override | 0–1 | OPEN |
| RISK-003 | Hostinger platform unknowns (timeouts, streaming, IP headers, pnpm 12, memory, restarts, outbound TCP) | M | H | SP-01 with pass/fail criteria, VPS or Vercel fallback (DEC-022) | 0 | OPEN |
| RISK-004 | Abuse of free anonymous hosting (malware, phishing, piracy, illegal content, spam) | H | **Critical** | Quotas, rate limits, Turnstile, executable policy, abuse reports, takedown, kill switches, scanning (Phase 6), public beta gate | 1–3, 6 | OPEN |
| RISK-005 | Legal and compliance obligations (GDPR, DMCA, illegal-content reporting, EU DSA, ToS/Privacy/AUP, DPA for Team) | M | H | Legal review before public beta (Q-022), data inventory and retention, operator processes | 2–3, 6 | OPEN |
| RISK-006 | Supabase costs from anonymous devices (MAU likely counted; realtime connections) | M | M | No Supabase users for link viewers, lazy sign-in, hidden-tab disconnects, cost alerts, custom-JWT exit ramp. **Phase 3:** `cleanup-anonymous-users` deletes anonymous users inactive for 30 days with nothing open (never suspended ones, D-9). **Phase 4:** permanent accounts count toward MAU too (phase 4 §17.23). A merge deletes the anonymous user it empties, and account deletion deletes the Auth user (P4-22). No cost alert exists yet (no hosted project). | 1, 3, 4, 6 | MITIGATING |
| RISK-007 | Realtime authorization cached per connection: a device that left a network (or a removed private-room member) keeps receiving ID-only signals until its token refreshes | M | L | ID-only payloads, cooperative unsubscribe on network change, API re-derives the network on every request, presence expires after 10 min, consider 30-min JWT expiry. **Phase 4:**<br>• A removed room member's joined channel gets ID-only signals until its token refreshes; it can fetch nothing, and `membership.changed` tells the browser to drop it (P4-17).<br>• Revoking a device deletes its Auth session: the API refuses it at once and the topic check refuses new joins, while a channel it already joined has the same lag.<br>• Enrolling an authenticator makes Auth end the account's other sessions, whose access tokens stay valid until they expire; the API and Realtime refuse them (P4-24 finding 2). The same window applies when Auth ends a session for any other reason.<br>• The JWT-expiry review is a hosted item. | 1, 4 | ACCEPTED (mitigated) |
| RISK-008 | One-time download can't confirm completion; partial-download bypass; bots consuming links | H if completion-based | M | DEC-015 burn on claim, POST only, no previews | 3 | OPEN |
| RISK-009 | Presigned URLs are bearer tokens and can be forwarded within their TTL | M | L | 60 s TTL, attachment disposition, per-link issuance limits, logging | 1–2 | ACCEPTED (mitigated) |
| RISK-010 | Upload size and type can't be fully enforced before bytes reach R2 (no POST policy) | M | M | **Signed `Content-Length` and `If-None-Match: *` on the presigned PUT** (storage refuses other sizes and any overwrite; verified on RustFS, R2 in SP-02), exact size and stored-header check at completion (no `Content-Encoding`), a deleted object's key held by a tombstone while its upload URL can still be used (phase 1 F1-12), delete on mismatch, stale-upload sweep, single-PUT cap 5 GiB, multipart part-count control. **Phase 4 (P4-14):** each part URL signs its `Content-Length`; a part number beyond the plan gets no URL; completion checks every part's size through `ListParts` and accepts no client part list. RustFS only. | 1, 4 | MITIGATING |
| RISK-011 | R2 behaviour differs from S3 (response-header overrides, batch delete support, lifecycle lag ≈ 24 h) | M | M | Headers set at upload, SP-02 verification, lifecycle only as backstop. **Phase 3:** the janitor uses single DeleteObject calls only (no DeleteObjects); ListObjectsV2, multipart listing and deleting during a streaming GET were checked on RustFS only (P3-00). SP-02 must repeat them on R2. **Phase 4:** multipart and `CopyObject` were checked on RustFS only (phase 4 §21.2, §22.2). RustFS accepts unequal parts and R2 refuses them, so the server checks each part; a multipart object's `LastModified` on R2 is unknown, so keys carry the date (DV4-57); a 5 GiB `CopyObject` in one request on R2 is unproven. | 0–4 | OPEN |
| RISK-012 | Storage quota races or drift | M | M | Atomic reservation ledger, daily reconciliation with alerts. **Phase 3:** reconciliation built and race-tested; drift is audited and shown on `/health/cron` (`storageDrift`). | 1, 3 | MITIGATING |
| RISK-013 | Local false negatives: devices on the same Wi-Fi don't see each other (IPv4/IPv6 split, VPN or Private Relay on one device, multi-WAN), or local mode is off (mobile data, most hotspots, large or shared networks) | H | M (UX) | Dual-stack binding (SP-04), clear status copy, link/QR/code fallback (built in Phase 2: Link only where local sharing is off, links from any network), SP-04 measurement | 1–2 | OPEN (mitigated by the Phase 2 fallback) |
| RISK-014 | Chrome Local Network Access gating WebRTC breaks the optional LAN-proof experiment | — | — | SP-05 withdrawn by CR-001. No design depends on WebRTC. | — | CLOSED |
| RISK-015 | Pricing economics: fixed merchant-of-record fees on $3–5 plans; worst-case storage per plan | H | M | $4–5 plus annual plans, total storage quotas, cost model in [07](07-plans-and-entitlements.md). **Phase 4:** prices show as `[OWNER: price]` on `/pricing` and `/settings/billing` (Q-006); the provider and its fees wait for Q-005. Pro's limits are set in binary units (D4-9). | 4 | OPEN |
| RISK-016 | Next.js 16 and ecosystem churn (proxy rename, library compatibility with Supabase SSR, shadcn, TanStack Query and Zustand) | M | M | Follow bundled docs (including the TanStack Query guide), pin versions, Renovate/Dependabot with CI. Phase 1: Next.js 16.3.5 → 16.3.8 for advisories published after Phase 0 (F1-6); `@supabase/ssr` not used (DV1-14). | 0+ | OPEN |
| RISK-028 | A dependency advisory has no fixed release (currently `braces`, reachable only through dev tooling), or a fix is newer than pnpm's minimum release age | M | L | Advisory-specific ignore with the reason in `pnpm-workspace.yaml`; overrides only to versions past the release-age policy; never add release-age exclusions without review (phase 1 F1-6) | All | ACCEPTED (reviewed) |
| RISK-030 | Short-code guessing spread over many networks (for example many IPv6 /64s or a botnet) gets around the per-network and per-session failure limits | L | M | 50-bit codes valid ≤ 24 h, HMAC-only storage, Turnstile after 5 failures, 24-hour blocks, a global failure alert (`code.resolve_failure_spike`), the `short_codes_enabled` kill switch; a code never reveals the link secret | 2 | OPEN (phase 2) |
| RISK-031 | Takedown is not prompt or evidence-safe: a blocked share's files wait for the next storage sweep (no janitor before Phase 3, lifecycle rule not applied yet), and nothing preserves evidence where the law requires it (for example CSAM reporting duties) | M | H | Access ends at once. **Phase 3 (D-2, D-3):** blocked objects are put on legal hold, the janitor and purge skip them, reported shares are kept, and an operator releases holds after legal review. **Security review (2026-10-16):** R2's lifecycle rules would still have deleted held objects at class period + 1 day after upload (8 days for `d7/`): the hold lived only in the database. Now the janitor copies each held object to `hold/<key>`, which no rule covers, within a minute of the hold, and deletes both after the release. Tested against RustFS with the original deleted as R2 would. **Remaining:**<br>• proof on real R2 (staging);<br>• no copy while the janitor is off or down (`janitorBacklog` alerts after an hour; the lifecycle margin is at least a day before expiry);<br>• objects already gone before a takedown can't be kept;<br>• the janitor token can delete copies (RISK-037);<br>• the legal procedure (Q-022). | 2–3 | MITIGATING |
| RISK-032 | Successful short-code resolutions are not rate-limited (only failures count, as 03 §4.4 designs it): someone holding a valid code can create link sessions and grants without limit while the code lives (≤ 24 h) | L | L | Cloudflare's per-IP rule on `/api/` ([infra/cloudflare/README.md](../infra/cloudflare/README.md) §4, not applied yet); sessions and grants are purged after they expire; a new code or `short_codes_enabled` off stops it. Applying the unlock limits to resolutions would close it, but would add a limit (owner decision, Q-027). | 2 | OPEN (phase 2 review, 2026-10-16) |
| RISK-033 | The per-link unlock limit (30 per 10 minutes) counts every attempt, not only failures: a link opened by more than 30 new browsers in 10 minutes (for example posted to a large group), or someone who knows a link ID sending wrong secrets, makes further unlocks wait up to 10 minutes (`429`) | M | L | Browsers that already unlocked keep access through their grant; a short code or a second link is another way in; the limit is what stops secret guessing (03 §10). Counting only failures would loosen an accepted limit (Q-027). | 2 | OPEN (phase 2 review, 2026-10-16) |
| RISK-034 | One deletion executor (D-1): between a cancelled upload (or a deleted share) and the janitor's next run, about a minute, a still-valid upload URL can store bytes, and deleted bytes stay in storage | M | L | The bytes are never reachable: the file is rejected and the share ended, so completion and downloads answer 404. The janitor then tombstones the key until the URL expires (tested). The lifecycle backstop applies. | 3 | ACCEPTED (owner D-1) |
| RISK-035 | Edge Function CPU (2 s, cumulative per worker) and wall-clock limits are too small for the janitor's batches (plan R3-1) | M | M | Measured locally (P3-00): about 0.6 ms per signed call, at most 500 rows per invocation, a 100 s budget; the egress merge moved out (D-4). Re-measure on staging. | 3 | MITIGATING |
| RISK-036 | Supabase injects full-access secrets into every function, so a compromised janitor or dependency reaches the whole database (plan R3-2) | L | H | Two pinned dependencies with none of their own (aws4fetch 1.0.20, postgres 3.4.9). The secret is checked first and there is no user input. **Security review (2026-10-16):**<br>• Each worker gets `SUPABASE_DB_URL` (user `postgres`), the service-role key, `SUPABASE_SECRET_KEYS` and more.<br>• `Deno.env.delete` silently does nothing and `Deno.env.set` is `NotSupported`, so the function can't remove them. This is a platform trust boundary.<br>• Tested: the code reads only `JANITOR_*` names (a static scan of `supabase/functions`); errors never carry values; with `app_janitor` blocked the real function does nothing.<br>• Mutation check: a function using the injected URL bypassed the role. The least-privilege role prevents mistakes, not a compromise.<br>• The egress refresh is a GitHub Actions job with no Supabase keys.<br>**Phase 4:** billing never runs in an Edge Function. Reconciliation posts through pg_net to the web app (D4-22), and the provider's API key lives only in the web tier (phase 4 §20.4, B15). The janitor function gained multipart aborts and extension copies (P4-14, P4-15). | 3, 4 | OPEN |
| RISK-037 | The janitor's R2 token can read, overwrite and delete every object in its bucket, hold copies included (R2 has no delete-only scope) (plan R3-3) | L | H | A separate token, 90-day rotation (an expiry date on the token), held only in function secrets. **Security review (2026-10-16):** R2's levels are Admin Read & Write, Admin Read only, Object Read & Write and Object Read only. Object Read & Write on one bucket is the narrowest that can delete. Prefix-scoped temporary credentials would need a minting service; IP filtering is impractical, because Supabase Edge Functions have no static egress IPs. Least privilege is not claimed. The scope checks (a 403 on another bucket) are on staging (SP-02). | 3 | OPEN |
| RISK-038 | A burn claim lost to device failure, leaving the network, or a link grant expiring during grace (plan R3-5) | M | L | Grace sized by file size, 3 issuances, "I've got it", the grace-loss warning (copy for owner review) | 3 | ACCEPTED |
| RISK-039 | A creator who opens their own burn link in a browser uses it up (plan R3-4) | M | L | A warning in the share-link dialog (copy for owner review); the creator's app keeps access (D-7) | 3 | ACCEPTED |
| RISK-040 | After a database restore, reconciliation deletes objects uploaded after the backup point (48 hours later) and flags missing ones (plan R3-6) | L | M | The restore runbook switches the janitor off first and checks drift before switching it back on; accepted as part of the RPO | 3 | ACCEPTED |
| RISK-041 | pg_net is fire-and-forget: a failing trigger shows only in `net._http_response` (plan R3-7) | M | L | The janitor writes its own heartbeat; `/health/cron` reports `stalled`, and `jobs: failing` for a missing Vault secret | 3 | MITIGATING |
| RISK-029 | Supabase Auth stores the client IP of every session (`auth.sessions.ip`) and in its audit log, for as long as the session exists. Anonymous sessions can live for months. The app's own tables, query parameters and logs hold no raw IPs (phase 1 F1-13), but the project's database does. | H | M | Owner decision Q-031: state it in the privacy notice and data inventory (03 §13) at least; options are a retention job for old anonymous sessions and audit entries, Supabase session time-boxing (Pro), or accepting it as Supabase's processing under its DPA. **Phase 3:** deleting inactive anonymous users (30 days, nothing open) deletes their Auth sessions and stored IPs with them; Auth's own audit log is unchanged. **Phase 4:** revoking a device deletes its Auth session; a merge deletes the anonymous user, and account deletion the account's Auth user, sessions included. Permanent accounts' sessions are not touched by the anonymous cleanup, so they keep their IPs while they live. | 1, 3, 4 | OPEN (phase 1 F1-14), reduced by Phase 3 |
| RISK-017 | Supabase legacy `anon`/`service_role` keys deprecated by end of 2026 | H | L | Use publishable/secret keys from day one, disable legacy keys | 0 | MITIGATING |
| RISK-018 | Janitor deletes the wrong objects (data loss) | L | H | Deletes only from DB-generated outbox rows, key regex, active-share guard, dry-run mode, volume anomaly alerts. **Phase 3, built and tested:** the guard rails are in SQL (key format, no open share, not held), the key is checked a third time in the core, refused rows are parked and alerted, orphans are only queued, `app_janitor` has no table access, there is a kill switch and dry run, and `janitorVolume` is on `/health/cron`. The 24-hour staging dry run is pending. | 3 | MITIGATING |
| RISK-019 | Email deliverability for accounts and invitations | M | M | Custom SMTP provider with SPF/DKIM/DMARC, monitoring. **Phase 4 (P4-23), local part only:** every Auth email tested through Mailpit. A mail scanner opening the email's link used up the code, so the link now opens the app's callback and is followed only on **Continue** (DV4-143). SMTP, SPF, DKIM, DMARC, the hosted settings and the delivery checks are written down in [`infra/email/README.md`](../infra/email/README.md), not applied (D4-8, Q-020, no staging). | 4 | OPEN |
| RISK-020 | Scope and complexity for a small team | H | H | Strict phase gates, Phase 1 scope discipline, defer experiments, reuse Supabase/Cloudflare primitives. **Phase 4:** built task by task on the owner's instruction, each task tested alone and with every earlier suite, the billing provider left last (phase 4 §17.21). All of it is uncommitted on top of `cc2ac40` and nothing is VERIFIED; the last full E2E run stopped when the system drive filled ([phase 4 §31.7](phases/phase-4-pro-accounts.md#317-tests)). | All | OPEN |
| RISK-021 | pnpm 12 lockfile or blocked build scripts (sharp, unrs-resolver) break host or CI builds or image optimization | M | M | SP-01 build test, pin a supported pnpm, adjust `allowBuilds` | 0 | OPEN |
| RISK-022 | Latency or data residency from single-region Supabase and R2 location | L | M | Choose region by target market (Q-016). Document subprocessors. | 0 | OPEN |
| RISK-023 | Realtime replay retention (3–4 days) stores whatever is in payloads | L | M | ID-only payloads (DEC-011) | 1 | ACCEPTED (mitigated) |
| RISK-024 | Anonymous → existing-account merge bugs leak or lose memberships and content | M | M | Proof via anonymous token, transactional merge, dedicated tests. **Phase 4A and P4-21, built:**<br>• a merge intent bound to the anonymous browser's device (D4-3), redeemed in one definer transaction under the user's row lock;<br>• fault injection at 12 tables;<br>• a coverage list of every column holding a user or device ID, by name and foreign key, with its merge and deletion rule; a new column fails it;<br>• merges racing room removals, room deletion, joins and posts tested; mutation checks.<br>**Remaining:** hosted Supabase (S4-2); a browser session that registered a device before redeeming its merge can't register again (F-28.1, not fixed); a merge into an account in its deletion grace goes with the account unless the deletion is cancelled (phase 4 §29.6 #4, waiting for the owner). | 4 | MITIGATING (built, not verified) |
| RISK-025 | Everyone on the same Wi-Fi sees local content, including guests and strangers on café, hotel, office and campus networks. Users may not realize this before posting. | H | H | Audience indicator and one-time notice (DEC-033), "Link only" option (Phase 2), large-network cap, report button, clear Terms and UI copy | 1 | ACCEPTED — inherent to DEC-031 (owner decision) |
| RISK-026 | An ISP reassigns a public IP (or IPv6 prefix), and its next holder sees local content still live on that network key | L | H | Shorter default expiry for local shares (Q-030), fail-closed classification, measure ISP rotation behaviour in SP-04 | 1 | OPEN |
| RISK-027 | Client-side caches keep a network's local content on screen or in memory after the device leaves that network, or a server-side cache serves one network's feed to another | M (without rules) | M | DEC-034 rules 3, 5 and 7: network-scoped query keys removed on network change, no cache persistence, no server caching of network-dependent data. Phase 1 E2E test extends T-003. | 1 | OPEN |
| RISK-042 | Account enumeration through Supabase Auth's own answers: an upgrade to an address that has an account gets `email_exists`; a sign-in that may not create a user gets `otp_disabled` for an unknown address (phase 4 S4-4) | M | L | Inherent to Supabase. No app endpoint adds enumeration; a fresh sign-in answers the same either way; a password-reset request answers the same for unknown addresses and emails nobody (P4-23). Turnstile on `signInWithOtp` where a site key is configured, and Auth's rate limits (both unverified on hosted Supabase). | 4 | OPEN (proposed for acceptance; owner pending) |
| RISK-043 | A merge that is never redeemed strands the anonymous data on a user the browser can no longer reach | L | M | A 24-hour, device-bound intent; the app retries the redemption at its next start; the anonymous cleanup skips users with an open intent; a redemption waiting for the authenticator keeps its intent (P4-24) | 4 | MITIGATING (proposed) |
| RISK-044 | Password lockout griefing: someone holding a password link's secret locks it for 15 minutes at a time with wrong passwords | M | L | Grants that already proved the password keep working; the lock is per link; Turnstile for an hour after a lock (DV4-74); 20 failures an hour per network key (P4-16). Designed in [03 §4.7](03-security-and-network-design.md#47-password-protected-links-pro-phase-4-dec-021). | 4 | OPEN (proposed; owner acceptance pending) |
| RISK-045 | MFA recovery: TOTP without recovery codes, so a lost authenticator locks the account | M | M | An operator procedure: verify through the account's address, wait, remove the factor, sign out everywhere ([accounts runbook](runbooks/accounts.md) §4). The waiting period is an owner decision. | 4 | OPEN (proposed) |
| RISK-046 | Billing trust boundary: a leaked webhook secret or a provider-side error grants or removes Pro | L | H | HMAC over the raw body, a signed timestamp within 300 s, an idempotent event log; the state is fetched from the provider, so a forged event for a subscription or dispute the provider doesn't know changes nothing; lost disputes confirmed with the provider (DV4-32); ordering by the provider's update time; daily reconciliation and a 36-hour refetch; a single caller writes subscriptions; audit (phase 4 §20.4). Tested against the fake provider only (Q-005). | 4 | MITIGATING (proposed) |
| RISK-047 | Executables in Pro links before malware scanning (if D4-11 allowed them) | L | H | Kept blocked on Pro (D4-11, waiting for the owner); room links check every file at download (DV4-112). Posting into a private room isn't covered by the remote policy (members only; DV4-97, waiting for the owner). | 4 | MITIGATING (proposed) |
| RISK-048 | History privacy: a year of metadata, and download records of other people's actions | M | M | Actor kinds only: no user, device or network IDs, no IP, no names; someone else's link by kind only (DV4-124). Kept by the snapshot's 365 days (Q-015 open, C4-17). After account deletion nothing names the account except the records kept on purpose (DV4-129, DV4-131). | 4 | OPEN (proposed; "stands as proposed", phase 4 §27.8) |
| RISK-049 | Extension copies double the storage until the swap, and copies can fail | L | L | Bounded by the share's size; the quota counts one copy; a fifth failure ends the extension and queues its new keys (DV4-61); `extensions: stuck` and `janitorFailures` on `/health/cron`. RustFS only (SP-02). | 4 | MITIGATING (proposed) |
| RISK-050 | Abandoned multipart parts cost storage until aborted (≤ 26 hours) | M | L | The 24-hour deadline; cancel, rejection, the deadline and any share ending queue the upload ID (DV4-45); the janitor aborts; the weekly reconciliation aborts uploads older than 24 hours; R2's 1-day rule as the backstop (not applied). A refused start can leave an empty upload (DV4-47). | 4 | MITIGATING (proposed) |
| RISK-051 | Password pre-hijack residual (F4-2): between the owner's confirmation by code and the app's device registration, a password session someone set up earlier could call Supabase Auth directly, for example to enrol an authenticator | L | M | The API and Realtime refuse password sessions; registration removes the password and deletes password sessions, after which Auth refuses their tokens (DV4-9). Recommended hardening, not built: an Auth hook refusing password sign-ins on hosted projects (D4-31). | 4 | OPEN (proposed, phase 4 §18.8) |
| RISK-052 | Supabase Auth's TOTP: the same code is accepted again with a new challenge within its 30-second window; no limit on wrong codes on the local stack | L | M | Replaying a code also needs the account's email code; an integration test fails if Auth closes the gap; the limit on wrong codes is a hosted check ([accounts runbook](runbooks/accounts.md) §7). Closing the gap would need a second mechanism inside Auth's tables. | 4 | OPEN (owner: accept, or ask Supabase; phase 4 §31.6) |
| RISK-053 | Two checkouts paid before either webhook arrives give one account two subscriptions | L | L | The "already subscribed" check (it sees neither yet); the portal can cancel one. Nothing prevents it at the provider. | 4 | OPEN (a known limitation for the owner, phase 4 §20.9) |
| RISK-054 | Room members aren't told that a read-only link to their room exists, while it shows their posts to people outside the room | M | M | The owner's dialog carries the DEFINED warning; links last at most 30 days, can have a password and can be turned off; deleting the room revokes them; viewers never see who posted. History tells a member afterwards that a room link fetched their post (DV4-124). | 4 | OPEN (owner decision DV4-121) |
| RISK-055 | One account that fails rolls back the whole hourly deletion run, so nobody is deleted until it is fixed | L | M | `jobs: failing` on `/health/cron` (no monitor configured yet); the [account-deletion runbook](runbooks/account-deletion.md) §5. Per-account isolation in the job is not built. | 4 | OPEN (phase 4 §29.6) |

---

## 4. Open questions

Status: `OPEN` · `ANSWERED` (record the answer and date, and update affected decisions).

| ID | Question | Why it matters | Recommendation | Blocks | Status |
|---|---|---|---|---|---|
| Q-001 | Do you accept "discover automatically, admit once, remember" instead of automatic same-network content visibility? | Core product behaviour and security (DEC-002) | — | Phase 1 | **ANSWERED** 2026-09-23: **No.** Keep automatic same-network visibility with no approval step (DEC-031, CR-001). |
| Q-002 | Phase 1 admission methods: approval + nearby PIN + open-join window, with QR pairing in Phase 2? | Scope | — | — | **ANSWERED** 2026-09-23: withdrawn. Local mode has no admission step (CR-001). |
| Q-003 | Who may admit new devices by default: owner only, or any member? | Security vs convenience | — | — | **ANSWERED** 2026-09-23: withdrawn (CR-001) |
| Q-004 | Should rooms be discoverable by default on normal networks, and can every plan turn discovery off? | Privacy defaults | — | — | **ANSWERED** 2026-09-23: withdrawn. There is no discovery. An uploader who doesn't want network visibility chooses "Link only" (DEC-033). |
| Q-005 | In which country is the business registered, and who handles sales tax/VAT? | Billing provider (DEC-023) | Merchant of record unless Stripe plus in-house tax is feasible | Phase 4 | OPEN — **Phase 4C (2026-10-17):** the provider-neutral billing core is built against a fake provider, which production refuses (DEC-023). **Still blocked on this answer:** the real adapter (P4-13), the provider's sandbox, one real transaction (AC-4.3) and the paid launch; until then Pro comes only from an operator override. The provider must carry custom data onto the subscription, return a subscription's state by ID, list changes since a time, cancel at period end and at once, and report disputes by ID ([phase 4 §20.9](phases/phase-4-pro-accounts.md#209-the-q-005-dependency-owner-decisions-and-next-steps)). |
| Q-006 | Final prices: Pro monthly/annual, Team structure (flat vs per-seat)? | Fee economics, entitlements | Pro $5/mo or $48/yr. Team $15/mo incl. 3 seats + $5/seat. | Phase 4–5 | OPEN — **Phase 4:** `/pricing` (generated from the plans as delivered) and `/settings/billing` show `[OWNER: price]`. The provider's products and the paid launch wait for this answer; the code doesn't. |
| Q-007 | Storage quotas: Free active storage and daily upload, Pro total, Team pooled? | Cost control | Free 2 GB active + 2 GB/day. Pro 100 GB. Team 250 GB pooled + add-ons. | Phase 1, 4, 5 | OPEN — Phase 1 assumes the recommendation (phase 1 §17.2). **Phase 4B:** Pro is built with 100 GiB of storage, 200 GiB a day, 5 GiB files, 100 files and 1 MiB texts, in binary units (D4-9), and isn't counted per network (D4-10); waiting for the owner. Changing a value is a one-line change in `lib/shared/plans.ts`. |
| Q-008 | Is one-time download Pro-only (as listed) or also Free? | Plan gates in Phase 3 | Pro-only at paid launch. Optionally enabled for Free during beta. | Phase 3 | **ANSWERED (owner, 2026-10-16):** Pro at paid launch; for Free, the existing runtime flag `free_burn_after_download` decides during beta and testing (default off; production may keep it off until the paid-plan and beta decision). No payment or Pro infrastructure in Phase 3; the entitlement stays `features.burnAfterDownload`. |
| Q-009 | Read-only room links: Pro-only? | Abuse and complexity | Pro-only | Phase 4 | OPEN — **Phase 4 (P4-19):** built Pro-only, as recommended (E22): only a private room's owner makes them, and a downgraded owner's existing links work until they expire (D4-16). Waiting for the owner ([phase 4 §26.8](phases/phase-4-pro-accounts.md#268-dependencies-owner-decisions-and-next-steps)). |
| Q-010 | Executables/scripts in anonymous remote links: block or warn? | Malware distribution | Block until scanning (Phase 6) | Phase 2 | **ANSWERED** 2026-10-16 (owner): **block** executables, scripts, installers and disk images in anonymous/Free remote sharing until scanning exists; archives stay allowed with the existing warning; local sharing is unchanged. Built that way (phase 2 §19.1); Phase 2 had assumed this answer (phase 2 §17.2). **Phase 4:** the answer covered Free only; Pro links block the same types as recommended (D4-11, waiting for the owner), and posting into a private room doesn't apply the remote policy (DV4-97, DEC-025). |
| Q-011 | Ads on Free: drop, or marketing pages only? | Privacy/security (DEC-024) | Drop ads. Use upgrade prompts instead. | Phase 2 | **ANSWERED for Phase 2** 2026-10-16 (owner): no advertising in Phase 2; remote sharing stays ad-free, and no ad system is built. Ads after Phase 2 (for example on marketing pages, 07 §8) are not decided. |
| Q-012 | Hosting budget and willingness to use a VPS (ops work) or Vercel if Hostinger managed Node fails SP-01? | Hosting fallback (DEC-022) | Hostinger VPS + Cloudflare Tunnel | Phase 0 exit | OPEN |
| Q-013 | Cloudflare plan at launch: Free or Pro (more WAF and rate-limit rules)? | Edge protection | Free for staging and alpha. Evaluate Pro before public beta. | Public beta | OPEN |
| Q-014 | Account sign-in methods: email magic link, Google, Apple, passwords? | Auth scope | Magic link + Google first | Phase 4 | OPEN — **Phase 4A:** built per D4-2: one email with a 6-digit code and a link, plus Google (code paths only, stubbed in tests: no OAuth client exists); no passwords (password sessions refused, DV4-9). Real email waits for D4-8 and Q-020, Google for an OAuth client; waiting for the owner. |
| Q-015 | Transfer history retention: Pro and Team? | Storage, privacy | Pro 1 year. Team configurable up to 2 years. | Phase 4–5 | OPEN — **Phase 4:** built with 365 days for Pro (`historyRetentionDays` in the snapshot). `/history` shows that window (P4-20), and tombstones and download logs of shares and links made on Pro are kept that long (C4-17, 03 §13; RISK-048). Waiting for the owner; Team is Phase 5. |
| Q-016 | Primary markets/regions? | Supabase region, R2 location, legal scope | Decide before creating production projects | Phase 0 | OPEN — **Phase 4:** nothing built depends on it, but every hosted Phase 4 check waits for hosted projects, whose region waits for this answer: Auth settings, TOTP, the migration role's rights on `auth.users` (S4-2), Realtime room channels. |
| Q-017 | Team retention: allow "no expiry" within quota? Maximum retention? | Storage liability | Allow no expiry within quota. Admins set a maximum. | Phase 5 | OPEN |
| Q-018 | Branded share pages: logo/colours/name on our domain only, or custom domains? | Complexity | Logo/colours/name only. Custom domains later. | Phase 5 | OPEN |
| Q-019 | Browser support baseline? | Next.js 16 minimums are Chrome/Edge/Firefox 111+ and Safari 16.4+, but Tailwind CSS 4 (DEC-035) compiles for Chrome 111, Safari 16.4 and **Firefox 128** | Accept **Chrome/Edge 111+, Firefox 128+, Safari 16.4+** | Phase 1 | OPEN — Phase 1 assumes the recommendation (Firefox corrected to 128+ on 2026-10-15, phase 1 §18.6) |
| Q-020 | Product name and production and staging domains? | CORS, CSP, cookies, Turnstile, R2 CORS, email | Decide in Phase 0 | Phase 0 exit | OPEN — **Phase 4:** blocks the sending domain and its SPF, DKIM and DMARC records (with D4-8; written down in [`infra/email/README.md`](../infra/email/README.md), P4-23), real sign-in email, the hosted Auth site URL and redirect allow-list, and the billing webhook endpoint. |
| Q-021 | Who may edit a text item: only its creator, or anyone who can see it? | Collaboration vs vandalism. Under DEC-031 "anyone who can see it" includes strangers on public Wi-Fi. | Local shares: **creator only**; everyone present can copy the text. Private and workspace rooms (Phase 4–5): any member. | Phase 1 | OPEN — Phase 1 assumes the recommendation (phase 1 §17.2). **Phase 4 (P4-17):** private rooms do **not** follow the recommendation: only a text's creator edits it there too (`requireOwnShare` in `lib/server/shares/text.ts`), and a creator removed from the room can't (DV4-93). The room's owner may delete any room share. |
| Q-022 | Who handles abuse reports and legal requests, and who reviews ToS/Privacy/AUP? | Legal readiness | Named operator plus external legal review | Public beta | OPEN — Phase 2 built the report intake (stored, audited, logged as `abuse.report_received`), the takedown functions and legal drafts with `[OWNER]` placeholders. **Owner decision 2026-10-16:** Phase 2 delivers no alert to a person and must not claim one; the named operator, the alert channel (email, chat, SMS or pager), the contact address and the evidence procedure stay future operational requirements that wait for this answer (phase 2 §19.1). **Phase 3 (2026-10-16):** the uptime-monitor design (D-5) needs an alert recipient (**[OWNER]**); takedown objects are held (D-2) and reported shares kept (D-3), but how long evidence is kept, and how it is preserved past the R2 lifecycle period, needs legal advice. **Phase 4:** the new runbooks need the support address and a named operator: a lost authenticator ([accounts runbook](runbooks/accounts.md) §4) and deletion requests by email ([account-deletion runbook](runbooks/account-deletion.md) §8). Account deletion keeps reports, audit events and billing records (DV4-131, waiting for the owner). The refund policy and the subprocessor list (email, billing) need the legal review. |
| Q-023 | Do you accept that Phases 1–2 are internal/invite-only and public beta starts after Phase 3 and the launch gate? | Launch timing | Accept | Phase 1 | OPEN — Phase 1 assumes the recommendation (phase 1 §17.2) |
| Q-024 | Keep the uncommitted pnpm 12.4.2 bump? | Build compatibility | Decide after SP-01 | Phase 0 | OPEN |
| Q-025 | Are native (mobile/desktop) apps on the long-term roadmap? | The only way to identify the actual LAN (mDNS/Bonjour) instead of the public IP, which would remove RISK-001 for app users | Not now. Revisit after product-market fit. | — | OPEN |
| Q-026 | Billing in Phase 4 (recommended) or Phase 6 (originally proposed)? | Paid launch timing | Phase 4 | Phase 4 | OPEN — **Phase 4C:** the provider-neutral core was built in Phase 4 on the owner's instruction, which doesn't answer this question ([phase 4 §20.9](phases/phase-4-pro-accounts.md#209-the-q-005-dependency-owner-decisions-and-next-steps)). Without a provider (Q-005), Pro is granted only by operator override. |
| Q-027 | Should anonymous users be allowed to create remote links at all, or with tighter caps that a verified (free) account lifts? | Abuse vs "no account required" | Phase 2: allow anonymous links under the Free caps in [03 §10](03-security-and-network-design.md#10-rate-limiting-and-abuse-protection) (for example 500 download-URL issuances/day per link, executable block). Phase 4: a free, email-verified account may get higher caps. | Phase 2 | **ANSWERED** 2026-10-16 (owner): keep the conservative design as implemented: per-link daily URL caps, unlock, short-code and report limits, Turnstile escalation and the kill switches. Nothing is loosened and nothing added. Values: phase 2 §19.2. |
| Q-028 | Should anyone be able to send a remote person a link or QR code to a **whole network's feed**? | It would show other people's local uploads to someone off the network | **No.** Remote links target one share (Free) or a Pro/Team private or workspace room. | Phase 2 | **ANSWERED** 2026-10-16 (owner): **No.** A remote link exposes only its one share: never a network feed, a network space, other people's local shares, presence, device lists or network identifiers. Link-only shares stay out of every local feed. Built and tested that way (phase 2 §19.3). **Phase 4:** read-only room links (P4-19) name a private room, never a network; there is no network target. |
| Q-029 | Large-network cap: switch local mode off above how many distinct devices per 24 h? | Too low breaks offices and cafés. Too high lets an undetected shared IP (campus, carrier NAT) group thousands of strangers. | **50**, configurable, tuned from SP-04 and production data. Fail closed (content hidden) while over the cap. | Phase 1 | OPEN — Phase 1 assumes the recommendation (phase 1 §17.2) |
| Q-030 | Default expiry for local shares? | A shorter default limits exposure from IP reassignment (RISK-026) and forgotten posts on public Wi-Fi | **24 h default**, with 1 h / 24 h / 7 days selectable on Free (7 days stays the maximum) | Phase 1 | OPEN — Phase 1 assumes the recommendation (phase 1 §17.2) |
| Q-031 | Supabase Auth keeps the client IP of each session and in its audit log (RISK-029). Accept and disclose, add a retention job, or time-box sessions? | Privacy: "no raw IPs" is true for the app's tables but not for the Supabase project | Disclose it in the privacy notice now; add a job in Phase 3 that removes anonymous sessions and audit entries older than 30 days once SP-03 confirms it is safe on hosted Supabase | Phase 1 (disclosure), Phase 3 (job) | OPEN — raised in phase 1 §18.5. **Phase 4:** no retention job or session time-box was built. Revocation, merges and account deletion delete sessions, but permanent accounts' sessions keep their IPs while they live (RISK-029). |

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
