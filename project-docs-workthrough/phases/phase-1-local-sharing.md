# Phase 1 — Anonymous Local Sharing (same network, automatic)

| Field | Value |
|---|---|
| **Status** | **NEEDS REVIEW** — implemented and tested on the local stack (2026-10-15), review items fixed (§18.5), owner follow-ups applied (§18.6); not VERIFIED. AC-1.3 (T-009), 1.6, 1.8, 1.9, 1.11 and 1.12 are **BLOCKED** on staging, real devices or the owner ([manual verification](phase-1-manual-verification.md)). Started on the owner's instruction before Phase 0 is VERIFIED (§17.1). |
| Plan depth | Detailed: task plan in §17, implementation record in §18. |
| Depends on | Phase 0 VERIFIED (including the SP-04 report). Q-007 (Free quotas), Q-019, Q-021, Q-023, Q-029, Q-030 answered. **Started early by owner decision; the unmet dependencies are listed in §17.1.** |
| Unblocks | Phase 2 |
| Release | **Internal alpha only** (staging behind Cloudflare Access) |
| Last updated | 2026-10-15 |

---

## 1. Goal

Implement the owner's local rule (DEC-031):

- **Devices on the same Wi-Fi/network automatically see** the text, images and files (≤ 100 MB) posted there, in realtime, with **no join step, approval, PIN, QR code or link**.
- **Devices on other networks see nothing**, not even that local content exists.

Also in this phase:

- expiry enforced at request time,
- storage quotas and rate limits,
- fail-closed guards for networks where one IP may cover several networks (DEC-032),
- isolation guarantees G1–G7 ([03 §3.8](../03-security-and-network-design.md#38-isolation-guarantees)) proven by tests.

## 2. Scope

### In scope

| Area | Contents |
|---|---|
| Device bootstrap | Turnstile + Supabase anonymous sign-in; the browser keeps and refreshes its own session and sends the access token as a bearer header, which the server only verifies (DV1-6, DV1-14; planned originally: `@supabase/ssr` cookies with `proxy.ts` refresh); `devices` registration with generated labels and coarse platform, device rename |
| Network | `POST /network/observe`: trusted IP, normalization, HMAC network key, network space upsert, classification (Private Relay and Tor lists loaded manually in this phase; ASN list only if SP-04 confirms ASN forwarding), presence (10 min), heartbeat every 5 min and on `focus`/`online`/connection change. **Dual-stack probe only if SP-04 adopts it.** |
| Guards | Statuses `ok` / `shared_egress` / `too_large` / `blocked` / `unavailable`. Fail closed for viewing and posting. Sticky ≥ 7 days. Status messages. Kill switch `local_sharing_enabled`. |
| Local feed | `GET /local/shares` for the caller's current eligible network. "My uploads" (`GET /me/shares`) from any network. |
| Realtime | Private `net:{spaceId}` and `user:{id}` channels, `realtime.messages` policies (presence-based for `net:`), database triggers with ID-only payloads, Presence for "N devices here now", re-observe and re-subscribe on network change, hidden-tab disconnect |
| Text shares | Create, versioned edit by the creator (409 on conflict, Q-021), delete by the creator. Free cap 100 KB (Q-007). Everyone present can copy. |
| File shares | Upload init (single presigned PUT ≤ 100 MB, signed headers), completion verification (HEAD + sniff), raster image previews, downloads for devices on the network (60 s URLs), delete by the creator |
| Expiry | Options per Q-030 (proposed 1 h / 24 h / 7 days, default 24 h for local shares). Request-time enforcement. `app.end_share()`. Jobs: `expire-shares`, `fail-stale-uploads`, `refresh-network-status`, `purge-ephemeral`, `release-stale-reservations`, `purge-idle-spaces`. R2 lifecycle backstop. `object_deletions` outbox populated, with a best-effort synchronous delete for creator deletes and rejected uploads. |
| Quotas and limits | Storage ledger (Free 2 GB active per user, proposed), daily upload volume per user and per network key, rate limits from [03 §10](../03-security-and-network-design.md#10-rate-limiting-and-abuse-protection), kill switches |
| Security | Origin/CSRF checks, zod validation, filename sanitization, attachment-only downloads, raster-only previews, executable warning and download confirmation on local shares, audit events, download log, log redaction |
| UI | "This network" home: network status, local feed, composer and uploader with progress, **audience line** (under the composer *"Visible to everyone on this network"*; status bar *"This network · N devices here now"*, §18.6), one-time notice, expiry badges, "My uploads", empty and error states, status copy for non-`ok` networks |

### Out of scope (later phases)

Remote share links, QR, short codes and "Link only" posting (Phase 2). Burn after download and the janitor Edge Function (Phase 3). Accounts, Pro features, private rooms and invites, multipart (Phase 4). Workspaces (Phase 5). Malware scanning and (if not adopted in Phase 1) ASN classification (Phase 6).

**Known limitation of this phase:** there is no fallback yet when local mode misses a device (R5) or is off on a network. Links, QR codes and share codes arrive in Phase 2.

## 3. Existing system state (expected at start)

The Phase 0 foundation: tooling, CI, `proxy.ts` with headers and origin lock, trusted client-IP helper, baseline schema, infrastructure, spike reports (SP-04 decides the dual-stack probe, ASN forwarding and the large-network cap), accepted decisions.

## 4. What will be changed

New application code in `app/`, `components/`, `lib/client`, `lib/shared`, `lib/server`. Phase 1 migrations and pgTAP tests. Integration and e2e tests. (`proxy.ts` was planned to gain Supabase session refresh; it did not, DV1-6.)

## 5. What will NOT be changed

- Baseline security controls from Phase 0 (only extended).
- **No approval, PIN, join or membership step in local mode** (DEC-031).
- No remote-access paths of any kind. Local content is reachable only from its network, or by its creator.
- No endpoint accepts a network or space identifier.
- No Supabase Data API usage from the browser (Auth and Realtime only).
- No `next/image` optimization of user content.

## 6. Architecture decisions involved

DEC-031 (ACCEPTED), DEC-034 (ACCEPTED, frontend state), DEC-001 (ACCEPTED, Next.js), DEC-032, DEC-033 (Phase 1 subset), DEC-004, DEC-005, DEC-006, DEC-007, DEC-008, DEC-009, DEC-010, DEC-011, DEC-012, DEC-016 (Phase 1 subset), DEC-018 (Free only), DEC-019, DEC-020, DEC-025, DEC-026 (single PUT), DEC-027.

## 7. Files / modules involved

Key modules as built (2026-10-15). The whole layout is in [ARCHITECTURE.md §14](../ARCHITECTURE.md#14-current-project-structure) and [02 §7](../02-system-architecture.md#7-application-module-layout-target).

- `lib/server/network/{client-ip.ts, normalize.ts, key.ts, egress.ts, current.ts, observe.ts}`. There is no `probe.ts`: the dual-stack probe was not built (DV1-3).
- `lib/server/local/visibility.ts`. The local feed query is in `lib/server/shares/read.ts`.
- `lib/server/shares/{create.ts, complete.ts, text.ts, download.ts, end.ts, read.ts, dto.ts, expiry.ts}`
- `lib/server/storage/{s3.ts, keys.ts, sniff.ts}`. Presigning, HEAD, ranged reads, tombstones and deletes are in `s3.ts`; completion checks are in `shares/complete.ts`.
- `lib/server/{auth, devices, policy, entitlements, ratelimit, audit}/*` and `lib/server/flags.ts`. There is no `quota/` folder: reservations are SQL functions called from `shares/create.ts` and `shares/complete.ts`.
- `lib/client/{supabase.ts, runtime.tsx, config.tsx, api-client.ts, realtime.ts, network.ts, use-network.ts, uploader.ts, turnstile.ts, linkify.ts}`
- `lib/client/providers.tsx`, `lib/client/queries/{keys.ts, shares.ts}` (TanStack Query), `lib/client/stores/{ui-store.ts, session.ts, uploads.ts, presence.ts}` (Zustand), per [02 §3.3](../02-system-architecture.md#33-frontend-state-management-dec-034)
- `lib/shared/api/schemas.ts` (zod contracts), `lib/shared/plans.ts`
- `components/local/*`, `components/ui/*`
- `app/page.tsx` ("This network" home), `app/(app)/uploads/page.tsx`, and all Phase 1 route handlers under `app/api/v1/`

Planned names that were not used: `network/{classify.ts, presence.ts, probe.ts}`, `local/feed.ts`, `storage/{r2.ts, presign.ts, verify.ts}`, `quota/`, `lib/client/{device.ts, turnstile.tsx}` (plan in [05 §6](../05-implementation-roadmap.md#phase-1)).

## 8. Database changes

Tables:

- `devices`
- `network_spaces`, `network_presence`, `network_egress_ranges`
- If SP-04 adopts them: `network_probe_nonces`, `network_bindings`, `network_key_links`, `network_egress_asns`
- `shares` (scope `network`), `files`, `text_items`, `downloads`
- `storage_usage`, `storage_reservations`, `object_deletions`
- `audit_events`, `idempotency_keys`, `user_flags`

**Not in this phase:** `rooms`, `room_members`, `room_invites` (Phase 4). The tables `network_observations`, `network_rooms`, `room_join_requests`, `room_pins` and `room_blocks` from the earlier plan were removed by CR-001.

Also: functions `observe_network`, `refresh_network_status`, `reserve_storage`, `commit_reservation`, `release_reservation`, `end_share`, and the Phase 1 job functions; realtime triggers and policies (`net`, `user` topics); pg_cron schedules for the Phase 1 jobs. Details in [04](../04-database-and-storage-design.md).

## 9. API changes

All Phase 1 endpoints in [02 §6.2](../02-system-architecture.md#62-endpoint-catalogue-by-phase): devices, network observe (and probe, if adopted), local feed, my uploads, shares (create, complete), texts, share detail/edit/delete, file download and preview URLs.

## 10. Security considerations

- Isolation guarantees G1–G7. The IDOR matrix covers every route and method, including "device that left the network" and "device on a non-`ok` network" (a test fails if a route is missing).
- **The trusted client IP is the access boundary for local content.** The origin lock (T-008) and production refusal of test overrides are release blockers.
- Network keys are server-derived only. No raw IPs in the app's tables, database query parameters, logs or error monitoring (the egress lookup sends only a /24 or /48 prefix, §18.5.2). Supabase Auth keeps its own record of session IPs (F1-14, Q-031). No endpoint accepts a network identifier (T-010).
- Fail closed: non-`ok` networks hide existing local content and refuse posting.
- Creator-only edit, delete and (Phase 2) link creation.
- Upload validation: exact size match, magic-byte sniffing, risk flags, filename sanitization. Objects carry signed attachment headers.
- Realtime payloads are ID-only. Client broadcasts are denied. `net:` topics require fresh presence.
- CSRF: Origin allow-list, JSON-only. Every response `no-store`.
- Turnstile before anonymous sign-in. Supabase anonymous sign-in rate limit reviewed for CGNAT.
- Audit events for network status changes and the share lifecycle.

## 11. Dependencies

- **Phase:** Phase 0 VERIFIED.
- **Packages (to be approved at task-plan time):** `@supabase/supabase-js`, `@supabase/ssr`, `@tanstack/react-query` (+ devtools, dev only), `zustand`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `file-type`, `pino`, a Turnstile wrapper, a permissively licensed UA parser (or an internal one). **As built:** `@supabase/ssr`, devtools, `file-type`, `pino`, the Turnstile wrapper and a UA parser were not added; small internal modules and the Phase 0 logger are used instead (DV1-7, DV1-14).
- **Data:** Apple iCloud Private Relay egress CSV and the Tor exit list, loaded into `network_egress_ranges` with a documented manual procedure. An ASN list only if SP-04 confirms forwarding and a commercially licensed source.
- **Infrastructure (only if the dual-stack probe is adopted):** `v4.` and `v6.` probe hostnames configured as SP-04 recommends.

## 12. Testing requirements

From [09 §4](../09-testing-strategy.md#4-critical-test-catalogue):

- Local visibility and isolation: T-001 … T-010.
- Permissions and posting: T-011 (edit/delete part), T-013, T-014.
- Realtime: T-015 … T-018.
- Uploads, storage and downloads: T-019 … T-027, and the preview part of T-028.
- Expiry: T-041, T-042.
- API hygiene: T-046 … T-049.
- The IDOR matrix for all Phase 1 routes.
- Manual matrix scenarios 1–5 from [09 §8](../09-testing-strategy.md#8-manual-device-and-network-matrix-phases-13-verification).

## 13. Acceptance criteria

| ID | Criterion | Evidence |
|---|---|---|
| AC-1.1 | Two devices on the same simulated network: B opens the app and **immediately** sees A's existing local shares with no join step. New items appear on the other device within 2 s (T-002). | E2E run |
| AC-1.2 | A device on another network sees nothing (T-001, T-010). A device that leaves the network loses access on its next request (T-003). | CI run |
| AC-1.3 | Isolation tests T-001 … T-010 and T-015, T-016 pass. The IDOR matrix covers 100% of Phase 1 routes. | CI run |
| AC-1.4 | `shared_egress`, `too_large`, `blocked` and `unavailable` fail closed for viewing and posting (T-004, T-005, T-007, T-013). The creator keeps access in "My uploads" (T-014). | CI run |
| AC-1.5 | Text create, creator edit with conflict (409), creator delete, with realtime updates. Non-creators get 403 (T-011). | CI + E2E |
| AC-1.6 | 100 MB upload through a single PUT from desktop and mobile. Lying-client tests (T-019, T-020, T-021) and stale-upload handling (T-022) pass. | CI + manual matrix |
| AC-1.7 | Download and preview rules (T-024, T-025, T-027, T-028 preview part) | CI run |
| AC-1.8 | Expiry holds at request time (T-041). `end_share` behaviour (T-042). Jobs scheduled and observed running. Lifecycle backstop rule confirmed in the bucket. | CI + staging evidence |
| AC-1.9 | Quota race (T-026) and rate limits (T-049). Kill switches block the corresponding actions. | CI + staging |
| AC-1.10 | CSRF, caching and header checks (T-046 … T-048) | CI run |
| AC-1.11 | Manual device/network matrix recorded: which real networks group correctly, false negatives, and which networks are switched off by the guards | Matrix document |
| AC-1.12 | The audience line, one-time notice and non-`ok` status copy are reviewed and approved by the owner | Screenshots + sign-off |
| AC-1.13 | Docs updated: authorization matrix, data inventory, decisions (any change records), risks, this file's status | Doc diff |

## 14. Known risks

RISK-001 (undetected shared IPs), RISK-002 (spoofing), RISK-025 (everyone on the Wi-Fi sees content), RISK-026 (IP reassignment), RISK-006, RISK-007, RISK-010, RISK-012, RISK-013, RISK-020, RISK-023.

## 15. Open questions

Q-007 (Free quotas), Q-019, Q-021 (who may edit text), Q-023, Q-029 (large-network cap), Q-030 (default local expiry). All must be answered before this phase starts.

## 16. Implementation status

| Date | Status | Note |
|---|---|---|
| 2026-09-17 | PLANNED | Scope plan drafted (nearby discovery with admission). |
| 2026-09-23 | PLANNED | Rewritten for CR-001: automatic same-network visibility, no admission, no rooms in this phase. Starts only after Phase 0 is VERIFIED. |
| 2026-10-15 | IN PROGRESS | Owner instruction: start Phase 1 now. Task plan §17. |
| 2026-10-15 | **NEEDS REVIEW** | All in-repo tasks done and tested on the local stack (§18); independent security review fixes applied and re-tested (§18.4). Open: staging and real-R2 evidence, the manual device/network matrix, owner review of the copy, the assumed answers (§17.2), SP-02/SP-03/SP-04. **Not committed; not VERIFIED.** |
| 2026-10-15 | **NEEDS REVIEW** | Owner review follow-up (§18.5): deleted-share upload links and raw IPs in database parameters fixed with regression tests; locally testable verification added; the [manual and staging procedure](phase-1-manual-verification.md) written. Six criteria stay **BLOCKED** on staging, real devices or the owner. **Not committed; not VERIFIED.** |
| 2026-10-15 | **NEEDS REVIEW** | Owner follow-ups (§18.6): Firefox 128+ in the docs, phone header and dialog-title fixes, final audience and status copy. Q-031 stays an owner decision. Real-device, staging and network verification still **BLOCKED**. **Not committed; not VERIFIED.** |

### Verification record

*Empty until verified.*

---

## 17. Detailed task plan (2026-10-15)

### 17.1 Starting conditions and owner decision

The owner instructed on 2026-10-15: *"Start Phase 1 — Local Network Sharing … Implement only Phase 1."* That overrides the workflow rule "a phase starts only after the previous phase is VERIFIED" for this phase. What is not yet in place, and how Phase 1 proceeds without it:

| Missing dependency | Consequence for Phase 1 |
|---|---|
| Phase 0 owner items: branch protection and a green CI run, staging (Cloudflare, Supabase, R2), hosting | Phase 1 is built and tested **on the local stack only**: Supabase CLI (Postgres, Auth, Realtime), RustFS as the S3/R2 stand-in, `next start`. Acceptance criteria needing staging or real devices stay open. |
| SP-04 (dual-stack probe, ASN forwarding, real-world grouping) | The documented fallback applies ([03 §3.4–§3.5](../03-security-and-network-design.md#34-dual-stack-binding-conditional-on-sp-04)): **only the current request's key counts**, no probe endpoint, no binding or ASN tables. `shared_egress` comes from the egress-range lists only. T-009 and the ASN part of T-005 don't apply. |
| SP-03 (Supabase anonymous auth, private Realtime) | Verified on the local stack as part of this phase (integration tests T-015 … T-017). Hosted behaviour still needs SP-03. |
| SP-02 (R2 semantics) | RustFS checked on 2026-10-15 for signed headers (403 on a mismatched or missing header), stored `Content-Disposition`, ranged GET, presigned expiry, bucket CORS and idempotent delete. R2 itself still needs SP-02. |
| Open questions | Recommended defaults adopted as **assumptions**, each a single constant or runtime flag (§17.2). They are not answers; the owner confirms or changes them. |

### 17.2 Assumed answers (pending owner confirmation)

| Question | Assumed value (the documented recommendation) | Where it lives |
|---|---|---|
| Q-007 Free quotas | 100 MB per file, 20 files per share, text 100 KB, 2 GB active storage per user, 2 GB/day per user, 10 GB/day per network key | `lib/server/entitlements/plans.ts` |
| Q-019 Browsers | Chrome/Edge 111+, **Firefox 128+**, Safari 16.4+ (Next.js 16 minimums, with Firefox raised to 128 by Tailwind CSS 4; corrected in §18.6) | — |
| Q-021 Text edit | Creator only on local shares; everyone present can copy | Policy code + T-011 |
| Q-023 Release | Internal only; nothing is deployed in this phase | — |
| Q-029 Large-network cap | 50 distinct devices per 24 h | Runtime flag `network_large_cap` (DV1-5) |
| Q-030 Local expiry | Default 24 h; options 1 h, 24 h, 7 days | `plans.ts` |

### 17.3 Deviations from the scope plan

| # | Planned | Built | Reason |
|---|---|---|---|
| DV1-1 | Start after Phase 0 VERIFIED | Started 2026-10-15 | Owner instruction (§17.1) |
| DV1-2 | Q-007 … Q-030 answered first | Assumed defaults (§17.2) | Questions still open; values are one-line changes |
| DV1-3 | Dual-stack probe and ASN list "if SP-04 adopts them" | Neither | SP-04 not run; documented fallback |
| DV1-4 | MinIO for local storage tests (09 §1) | **RustFS** (S3-compatible, Apache-2.0) | MinIO no longer publishes container images (Docker Hub and Quay refused the pull on 2026-10-15) |
| DV1-5 | `NETWORK_LARGE_CAP` environment variable | Runtime flag `app.runtime_flags('network_large_cap')` | The `refresh-network-status` cron job needs the same value, and the cap should be tunable without a redeploy |
| DV1-6 | `proxy.ts` refreshes the Supabase session | No refresh in `proxy.ts`. The browser client refreshes its own session; the API answers 401 and the client retries once after refreshing. | No page reads the session on the server, and a refresh in the proxy would add an Auth round trip to every request |
| DV1-7 | `file-type`, `pino`, a Turnstile wrapper package, devtools | Small internal modules: magic-byte sniffer (the fixed set in 03 §7.4), UA labels, Turnstile loader; Phase 0 logger kept; no devtools | Fewer dependencies for a small fixed need |
| DV1-8 | Public config inlined at build time (`NEXT_PUBLIC_*`) | The root layout passes public config (Supabase URL and publishable key, Turnstile site key) to the client providers at request time | One build serves every environment |
| DV1-9 | Turnstile before anonymous sign-in | Required in staging and production (environment validation); off locally and in tests | Local Supabase has captcha off; real keys don't exist yet |
| DV1-10 | — | A multi-file share is all-or-nothing: if any file fails verification or times out, the whole share fails | Simplest correct rule; partial shares would need extra UI and states |
| DV1-11 | — | Kill switch `local_sharing_enabled = false` reports `networkStatus = unavailable` (reason `disabled`) | Keeps the five documented statuses |
| DV1-12 | API integration tests call handlers | Vitest integration tests call a real `next start` server over HTTP | Covers `proxy.ts`, cookies and headers exactly as in production |
| DV1-13 | Mutations must send JSON | `DELETE` without a body is accepted without `Content-Type`; the Origin check still applies | A body-less DELETE has nothing to declare; cross-site DELETE always needs a CORS preflight |
| DV1-14 | Supabase session **cookies** (`@supabase/ssr`) authenticate API calls (02 §6.1, 03 §8) | The browser sends its Supabase **access token as `Authorization: Bearer`**; the server only verifies it (`getClaims`) and never refreshes it. `@supabase/ssr` is not used. | A server that refreshes from cookies can rotate the browser's refresh token out from under it. A header the page must set explicitly can't be sent by another site (CSRF). The token sits in the browser's storage either way. |
| DV1-15 | Upload size verified after upload only (RISK-010: "no POST policy") | The presigned PUT also **signs `Content-Length`**; storage refuses any other size (verified on RustFS: ±1 byte → 403). Completion still checks the size. | Closes a storage-abuse gap: without it a client could announce a small file and PUT up to 5 GiB that lingers until cleanup. R2 behaviour is confirmed in SP-02. |
| DV1-16 | Next.js 16.3.5 | **16.3.8** (and `eslint-config-next` 16.3.8), plus pnpm overrides for three transitive packages | Security advisories published after Phase 0, including a critical RCE in `next/og` (F1-6) |
| DV1-17 | — | `files.position` column; upload targets carry `name` and `sizeBytes` | The client matches its files to presigned URLs by position; file order must survive the database |

DV1-18 … DV1-20 came from the security review and are listed in §18.4; DV1-21 … DV1-24 came from the second review pass (§18.5.8).

### 17.4 Tasks

Test-first: each task starts with failing tests (pgTAP, Vitest unit or integration, Playwright).

| # | Task | Files | Tests |
|---|---|---|---|
| P1-01 | Local stack: Supabase with Auth and Realtime (anonymous sign-ins on), RustFS container and bucket setup, `app_server` local login via `seed.sql`, scripts | `supabase/config.toml`, `supabase/seed.sql`, `scripts/*`, `package.json` | Stack health check |
| P1-02 | Phase 1 migration: tables, functions, triggers, Realtime policies, cron jobs, runtime flags | `supabase/migrations/*_phase1_local_sharing.sql` | `supabase/tests/phase1_*.test.sql` (grants, RLS, `observe_network`, guards, quota, `end_share`, jobs, triggers, topic access) |
| P1-03 | Environment and configuration for Phase 1 | `lib/server/env.ts`, `.env.example` | `env.test.ts` |
| P1-04 | Pure server modules: network key, filename sanitization, `Content-Disposition`, magic bytes, object keys, entitlements, expiry, device labels | `lib/server/{network,security,storage,entitlements,devices}/*` | Unit tests (T-006, T-023, T-024, T-025 unit part) |
| P1-05 | Server services: session and device auth, current network, observe, feed, shares, text, downloads, quota, rate limits, flags, audit, storage | `lib/server/**` | Integration |
| P1-06 | API routes (02 §6.2, Phase 1 rows) | `app/api/v1/**` | Integration incl. IDOR matrix |
| P1-07 | Integration harness and tests | `tests/integration/**`, `vitest.config.mts` | T-001 … T-005, T-007, T-010 … T-028 (Phase 1 parts), T-041, T-046 … T-049 |
| P1-08 | Realtime integration | `tests/integration/realtime.test.ts` | T-015 … T-017 |
| P1-09 | Client: config, Supabase client, bootstrap, API client, queries, stores, realtime bridge, uploader | `lib/client/**` | Component and unit tests (cache removal on network change, uploader) |
| P1-10 | UI: "This network" home, composer, uploader, feed, My uploads, status and audience copy, one-time notice | `app/page.tsx`, `app/(app)/uploads/page.tsx`, `components/**` | Component tests, E2E |
| P1-11 | E2E with two simulated devices | `playwright.config.ts`, `tests/e2e/local-*.spec.ts` | AC-1.1, T-001, T-002, T-003 (UI), upload and download |
| P1-12 | CI: full local stack, RustFS, integration job | `.github/workflows/ci.yml` | — |
| P1-13 | Documentation | `project-docs-workthrough/**` | Link check |

---

## 18. Implementation record (2026-10-15)

### 18.1 Implementation log

| Task | Result | Evidence |
|---|---|---|
| P1-01 Local stack | `pnpm stack:start` starts Supabase without unused services (Studio, Storage, Edge Runtime, logging, pooler, mail) and RustFS `1.0.1` with the bucket and CORS. `pnpm stack:env` prints a working `.env.local`. `supabase/seed.sql` gives `app_server` a local-only login. Anonymous sign-ins on; local anonymous rate limit raised for tests. | Stack used by every test below |
| P1-02 Migration | `20261015120000_phase1_local_sharing.sql`: 14 tables, RLS and `app_server` grants on all, 15 functions (`observe_network`, `set_space_status`, `rekey_network_space`, `refresh_network_status`, `reserve_storage`, `commit_reservation`, `release_reservation`, `end_share`, the five job bodies, `large_network_cap`, `app_realtime.can_access_topic`), 3 Realtime triggers with their 3 trigger functions, 2 `realtime.messages` policies, 6 pg_cron jobs, 5 runtime flags (3 kill switches, `network_large_cap`, `egress_ranges`) | pgTAP **89/89** (`phase1_local_sharing.test.sql`); cron log shows the jobs running with no failures |
| P1-03 Environment | Network key secrets (versioned, ≥ 32 chars, placeholder check), IPv6 prefix length, `RUNTIME_FLAGS_CACHE_SECONDS`, `TEST_CLIENT_IP_DEFAULT` (refused wherever the test override is); staging/production require database, Supabase, R2, network secret and Turnstile site key | `env.test.ts` (26 tests) |
| P1-04 Pure modules | Network key HMAC, filename sanitization, `Content-Disposition`, magic-byte sniffing, risk flags, object keys and stored content type, Free entitlements, device labels, the visibility rule | Unit tests (T-006, T-023, T-024, T-025 unit part) |
| P1-05 Services | Bearer-token session (DV1-14) and device binding, current network and observe, posting policy and kill switches, feed, My uploads, details, text create/edit (409), delete via `end_share` + best-effort object deletion, upload init (reservations, signed PUT incl. `Content-Length`, idempotency key), completion (HEAD, sniff, commit), download/preview URLs with a download log, rate limits with `Retry-After`, audit events | Integration suite |
| P1-06 API | 12 route files, 13 methods (02 §6.2 Phase 1 rows; no probe endpoint) | IDOR matrix coverage test |
| P1-07 Integration | Vitest against a real `next start` (NODE_ENV=test) on the local stack; random IPv6 /64 per test | **71/71** (6 files) |
| P1-08 Realtime | Topic authorization, delivery, presence, client broadcast refusal, rollback | Included in the 71 (T-015 … T-017) |
| P1-09 Client | Public config at request time (DV1-8), browser runtime and bootstrap (anonymous sign-in, Turnstile when configured, device), API client (bearer, one refresh-and-retry, zod parsing), query factories, Realtime bridge (signals → invalidation only, presence roster, hidden-tab disconnect), network-change cache removal, uploader (XHR progress throttled to 10/s), Zustand stores (UI, session, uploads, presence) | Unit + component tests |
| P1-10 UI | "This network" home, audience line, one-time notice, composer (text/files, expiry), upload progress, feed cards (copy, creator edit/delete, previews, risky-file confirmation), My uploads, device rename, status copy | Component tests; screenshots in `evidence/phase-1/` |
| P1-11 E2E | `local` Playwright project on a third server (full stack): two browser contexts per test as devices on simulated networks | **5/5** (plus the 13 Phase 0 smoke tests), three consecutive runs |
| P1-12 CI | Two jobs: `checks` (typecheck, lint, unit+component with coverage, audit) and `stack` (stack start, pgTAP, generated-types diff, build, integration, E2E) | YAML written; **not run**. The GitHub remote exists. CI's only run, on the push of the Phase 0 commit to `main` (2026-09-29), failed at `pnpm typecheck` (`Cannot find name 'LayoutProps'`); the Phase 1 branch has no pull request, so the current workflow has not run (Phase 0 AC-0.1). |
| P1-13 Docs | This file, 00, 02, 03, 04, 05, 06, 07, 08, 09, README; [runbooks/egress-lists.md](../runbooks/egress-lists.md) | Link check |

**Test totals after the second review pass** are in §18.5.5. **Totals after the first security review fixes (local, 2026-10-15):** typecheck and lint clean. Vitest unit + component **238/238** (29 files). pgTAP **117/117** (28 baseline + 89 Phase 1). API integration **71/71** (6 files). Playwright **18/18** (13 Phase 0 + 5 Phase 1); before the review fixes, three consecutive runs and one run with a developer `.env.local` present were also green. `pnpm build` clean. Generated database types unchanged by `pnpm db:types`. `pnpm audit --audit-level high`: clean with one documented exception (F1-6). Unit coverage is 44% of lines because services and UI are exercised by the integration and E2E suites, which don't report coverage.

### 18.2 Findings during implementation

| # | Finding | Action |
|---|---|---|
| F1-1 | The baseline's `alter default privileges … in schema app revoke execute … from public` does nothing: per-schema default privileges can only add to the global defaults. `anon` and `authenticated` could execute 13 new `app` functions (caught by a pgTAP test; the schema itself is not exposed to them). | Phase 1 migration sets a **global** default for `app_owner` and revokes execute on every existing `app` and `app_realtime` function; pgTAP asserts no client role can execute any `app` function. |
| F1-2 | `app_owner` cannot be granted `REFERENCES` on `auth.users`. | Tables that reference `auth.users` are created by the migration role and handed to `app_owner`; cascades verified. |
| F1-3 | `realtime.messages` has RLS and `realtime.send` is SECURITY INVOKER; `realtime.send` turns its own errors into warnings, so a missing privilege would silently drop every signal. | Trigger functions are SECURITY DEFINER owned by the migration role (as Supabase recommends); pgTAP asserts messages are actually written. |
| F1-4 | MinIO no longer publishes container images. | RustFS 1.0.1 (DV1-4), probed for every R2 behaviour the design relies on. |
| F1-5 | Strict-CSP issues that only a production build shows: zod 4 probes `new Function` (reported as `script-src eval` even though caught), and Radix's scroll lock inserts a `<style>` tag without a nonce. | Browser-side zod runs `jitless`; the layout passes the request's nonce to `get-nonce`, which the scroll lock reads. E2E asserts zero CSP violations across the multi-device flows. |
| F1-6 | New advisories since Phase 0: `next` (critical RCE in `next/og`, unused here, plus several high/moderate), `sharp`, `source-map-js`, `@modelcontextprotocol/sdk` (via the shadcn CLI), `braces` (no fix released). Installing a newer `shadcn` made pnpm add release-age exclusions automatically. | Next.js 16.3.8; overrides for `source-map-js`, `sharp` and the MCP SDK (each past pnpm's minimum release age); shadcn kept at 4.21.0 and the exclusions removed, so the lockfile passes pnpm's supply-chain policy. `braces` (dev tooling only, no fix) is ignored by advisory ID with the reason in `pnpm-workspace.yaml`. |
| F1-7 | Realtime presence reaches only channels that register a presence listener before subscribing. | The bridge registers it; the test helper too. |
| F1-8 | `next start` keeps an explicit `NODE_ENV=test`, so the test client-IP override can run against a production build while deployments (`NODE_ENV=production`) still refuse it. | Integration and E2E servers use `NODE_ENV=test`. |
| F1-9 | A presigned PUT does not limit the body size by itself. | `Content-Length` is signed (DV1-15). |
| F1-10 | Storage keeps headers a client adds that the signature does not cover: RustFS stored an unsigned `Content-Encoding: gzip` (browsers would undo it on download). It refuses unsigned `x-amz-meta-*`. | Completion compares the stored `Content-Type`, `Content-Disposition` and `Cache-Control` with the signed values and rejects any `Content-Encoding` (`metadata_mismatch`). Uploads are write-once (`If-None-Match: *` signed), so a verified object can't be replaced. R2 behaviour goes into SP-02. |
| F1-11 | Next.js loads a developer's `.env.local` for any `NODE_ENV` except `test`; the Phase 0 E2E servers (no `NODE_ENV`) would then pick up the local test override and refuse to boot. | All E2E servers run with `NODE_ENV=test`. |

### 18.3 Acceptance criteria status

| AC | Status | Evidence / what is missing |
|---|---|---|
| AC-1.1 | ✅ Met on the local stack | E2E: a second device sees existing shares with no join step; a new post appears on the other device in under 2 s (three runs). Integration: realtime delivery < 2 s. |
| AC-1.2 | ✅ Met on the local stack | T-001, T-003, T-010 (integration and E2E). CI run pending (no pull request yet). |
| AC-1.3 | ◐ **BLOCKED for T-009** | T-001 … T-008, T-010, T-015, T-016 pass; IDOR matrix covers 100% of Phase 1 routes and methods (enforced by a test). The fallback that applies without SP-04 (only the current request's key counts; a household's IPv4 and IPv6 never merge) is now tested locally. **T-009 itself (dual-stack binding) and the ASN part of T-005 need SP-04** on real Cloudflare and networks; until SP-04 decides, they can't be built or tested. |
| AC-1.4 | ✅ Met | `shared_egress`, `too_large`, `blocked`, `unavailable` (incl. kill switch) hide content and refuse posting; creators keep My uploads (T-004, T-005, T-007, T-013, T-014). |
| AC-1.5 | ✅ Met | Text create, creator edit with 409, creator delete, live updates on the other device; non-creators get 403 `NOT_CREATOR` (T-011, E2E). |
| AC-1.6 | ◐ **BLOCKED (real phones)** | 100 MB single PUT verified (integration). T-019 … T-022 pass, plus the deleted-share upload-URL regressions (§18.5). Emulated iPhone (WebKit) and Pixel (Chromium) runs pass the phone upload flow locally, but **emulation is not evidence**. Needs: steps S-8 and S-9 of the [manual procedure](phase-1-manual-verification.md#3-same-network-ac-111-part-1-ac-16-ac-11-on-real-devices) on a real iPhone and Android phone against staging. |
| AC-1.7 | ✅ Met | T-024, T-025, T-027, T-028 (preview part): attachment downloads, 60 s / 300 s URLs, raster-only previews, executables flagged with confirmation. |
| AC-1.8 | ◐ **BLOCKED (staging, R2)** | T-041, T-042, jobs observed running locally; the lifecycle and CORS files are now checked against the code (unit test). Needs: staging and a real R2 bucket, steps E-1 … E-8 of the [manual procedure](phase-1-manual-verification.md#6-staging-expiry-cleanup-and-the-r2-lifecycle-backstop-ac-18). |
| AC-1.9 | ◐ **BLOCKED (staging)** | T-026, T-049 and all three kill switches pass locally; the quota error now follows the 07 §4 contract. Needs: steps Q-1 … Q-4 on staging ([manual procedure](phase-1-manual-verification.md#7-staging-quota-race-rate-limits-kill-switches-ac-19)). |
| AC-1.10 | ✅ Met | T-046 (Origin, content type), T-047 (`no-store` everywhere), T-048 (nonce CSP, zero violations in multi-device E2E). |
| AC-1.11 | ❌ **BLOCKED (staging, real devices)** | Not started. A phone can't be tested against a laptop on the local network (it presents a private address, so local sharing is `unavailable`); it needs staging behind Cloudflare. Procedure: §3–§5 and §8 of the [manual procedure](phase-1-manual-verification.md). |
| AC-1.12 | ◐ **BLOCKED (owner sign-off)** | The owner decided the audience and status-bar copy and the phone layout fixes (§18.6); applied and tested. Still needed: sign-off of the notice, risky-download and network-off texts and of the updated screenshots ([manual procedure §9](phase-1-manual-verification.md#9-owner-copy-review-ac-112)). Copy lives in `components/local/copy.ts`. |
| AC-1.13 | ✅ Met | Documents updated (see the changelog in [README](../README.md)). |

### 18.4 Independent security review (2026-10-15)

A separate review pass read every Phase 1 file against 03 §3, §6, §7, §9, §10 and 04 §6. **No critical or high findings.** All six invariants it checked held: network derived per request, the visibility rule, creator-only actions, Realtime topics, quota, and the test override. Findings and what was done:

| # | Severity | Finding | Action |
|---|---|---|---|
| M1 | Medium | A verified object could be rewritten through its upload URL; unsigned headers (`Content-Encoding`) were stored | **Fixed:** write-once uploads and the stored-header check at completion (F1-10, DV1-18). The residual (a deleted share's upload URL could recreate the object for up to 15 min) is **fixed in the second pass** (F1-12, DV1-21, §18.5). |
| M2 | Medium | The egress-list guard failed open: no loader, no staleness check, and the status job lifted `shared_egress` without knowing the address | **Fixed (DV1-19):** `scripts/load-egress-ranges.cjs` and its [runbook](../runbooks/egress-lists.md) (real lists loaded locally: 285,091 Private Relay ranges, 1,210 Tor exits; lookup ≈ 0.3 ms). Staging and production fail closed when the lists are missing or older than 14 days. Only an observe, which has the address, lifts `shared_egress` after its sticky period. pgTAP and integration tests. |
| L1 | Low | The test client-IP override depended on runtime variables only | **Fixed (DV1-20):** refused together with `TRUST_PROXY_MODE=cloudflare`, and needs `APP_ENV` set explicitly to `local` or `test` (the default no longer counts). |
| L2 | Low | Lock-order inversion between completion, `end_share` and `fail_stale_uploads` could deadlock | **Fixed:** every path locks share → file → ledger. |
| L3 | Low | Presence payloads are client-controlled (a present device could inflate the roster count) | **Accepted for Phase 1:** only the count is shown, React escapes everything, and presence can't reach content. Revisit if labels are displayed (a server-provided roster). |
| L4 | Low | Chunked request bodies were buffered before the size check | **Fixed:** byte-counted streaming read. |
| L5 | Low | Observe sends the raw client IP to Postgres as a query parameter (egress lookup); parameter logging could record it | **Fixed in the second pass** (F1-13, DV1-23, §18.5): the database receives only a /24 or /48 prefix; tested with full statement logging. Supabase Auth's own IP storage is a separate finding (F1-14, Q-031). |
| L6 | Low | Paths containing a dot (for example `/uploads.x`) rendered the 404 page without a CSP | **Fixed:** only `/_next/` and the known public files skip the document CSP. |
| L7 | Low | Download URLs were limited per device only. Daily volume is charged at upload init, so a member can use up a network's daily volume by announcing uploads | **Partly fixed:** per-space limit on download and preview URLs. Refunding volume for failed uploads stays open (Phase 3/6). |
| L8 | Low | An idempotent replay skipped the posting rules | **Fixed:** posting rules first, then the replay. |
| Info | — | Existence timing difference in download URLs; hosted Realtime "Allow public access" must be off; Cloudflare Pseudo IPv4 would make every client `unavailable` | Recorded in the 08 deployment checklists. |

Deviations added by the review fixes:

| # | Planned | Built | Reason |
|---|---|---|---|
| DV1-18 | Signed PUT with type, disposition, cache control and length | Also signs **`If-None-Match: *`** (write-once). Completion compares the stored headers with the signed ones and rejects any `Content-Encoding` (`metadata_mismatch`). Bucket CORS allows `If-None-Match`. | M1. Storage keeps unsigned headers, and an object could otherwise be replaced after verification. |
| DV1-19 | Egress lists loaded manually in Phase 1 and daily from Phase 3 (04 §9.2); no rule for missing or stale lists | Manual loader now (`pnpm egress:load`, weekly runbook); staging and production report `unavailable` (reason `classification_unavailable`) when the lists are missing or older than 14 days. `refresh-network-status` no longer lifts `shared_egress`. | M2. Without a loader the guard did nothing, and failing open contradicts 03 §3.5. |
| DV1-20 | Test override allowed when `APP_ENV` is local/test and not deployed | Also needs `APP_ENV` set explicitly, and is refused with `TRUST_PROXY_MODE=cloudflare` | L1. Defence in depth for a misconfigured deployment. |

### 18.5 Review follow-up (second pass, 2026-10-15)

The owner asked for the remaining review items and verification gaps to be closed, without starting Phase 2 and without changing the approved model (automatic same-network visibility, no approval step, no PIN or QR; other networks see nothing). Everything below was done test-first: each regression test failed before its fix, except the three loader `collapse` unit tests, which were written together with the function.

#### 18.5.1 Fix: a deleted share's upload link could put bytes back (F1-12)

| | |
|---|---|
| Problem | Presigned PUT URLs (15 min) can't be revoked. After a share was deleted (or a file rejected), the object was deleted at once, so the still-valid write-once URL (`If-None-Match: *`) could create the object again: an orphan with attacker-chosen bytes, outside quota, until the lifecycle backstop. Reproduced: `PUT` after `DELETE` answered **200**. |
| Fix (DV1-21) | **The key is held, not freed, while any upload URL for it may be live.** `files.upload_url_expires_at` records the latest expiry of any URL issued (written in the same statement that issues it, before the URL is handed out). The storage executor (`app.claim_object_deletions` + `lib/server/shares/end.ts`) overwrites such an object with an empty **tombstone** (`x-amz-meta-tombstone: 1`, `no-store`) instead of deleting it: the content is gone at once, and storage itself refuses the URL (**412**, write-once). The outbox row stays open (`tombstoned_at`) until the URL expiry plus 5 min of clock-skew grace, then the tombstone is deleted. A small sweep of due deletions runs after each delete or rejection (Next.js `after()`), so held keys and objects of shares the jobs ended are cleaned up in Phase 1, without waiting for the Phase 3 janitor. |
| Binding (DV1-22) | URLs are issued only for a `pending` file of a `pending_upload` share that hasn't expired, and **never outlive the upload deadline or the share's expiry** (capped TTL). The issuing update and `end_share` lock the same file rows, so no URL is issued for a share that has ended. Completion re-checks, under the row locks and with the database clock, that the share is still `pending_upload` and unexpired (**422 `UPLOAD_REJECTED`**, reason `share_ended`) and that the upload deadline hasn't passed (**409 `UPLOAD_EXPIRED`**), even before the cleanup jobs run (F1-15). Deleted, failed or expired shares never come back. |
| Unchanged | Write-once uploads, signed `Content-Length`, the stored-header check, quota release in `end_share`. |
| Tests | Integration (`uploads.test.ts`): PUT after delete → 412 and the content is gone; cancel before upload → 412; re-PUT after a rejection → 412; completion after the deadline → 409, after expiry → 404; URLs capped at the deadline and none issued after it; held key released once the URL has expired (sweep); outright delete when no URL is live. pgTAP: the claim rule (hold until URL expiry + 5 min, locking, `not_before`, share filter). |

#### 18.5.2 Fix: the raw client IP reached the database as a query parameter (F1-13)

**Where the address goes** (browser → Cloudflare → host → Next.js → Postgres):

| Hop | Address present? | Retained? | Control |
|---|---|---|---|
| Cloudflare edge | Yes (it is the client) | Per Cloudflare plan logs; Logpush not used | Platform (08 §4) |
| Host / origin access logs | `CF-Connecting-IP`, depending on the host's log format | Host-dependent | **Deployment requirement** (08 §5) |
| Next.js (`proxy.ts`, `resolveClientIp`, `deriveNetworkKey`) | In memory for the request | No: app logs never contain it (only a request ID on the non-global warning) | Code (unchanged) |
| Postgres, before this fix | **Yes:** `app.observe_network(…, p_address inet)` on every observe | Never stored in a table, but any parameter logging records it: `log_statement = all`, `log_min_duration_statement` sampling, **`auto_explain` (loaded by the Supabase image with a 10 s threshold and `log_parameter_max_length = -1`, so a slow observe would log the full address)**, or pgaudit with parameter logging | — |
| Postgres, after this fix | **No.** It receives the keyed hash (as before) and, for the egress lookup, only the **IPv4 /24 or IPv6 /48** around the address | Only the prefix could be logged | Code + test |
| Browser → Supabase Auth and Realtime (direct, not via Next.js) | Yes | **Supabase Auth stores the client IP of each session in `auth.sessions.ip`** (all 92 local sessions have it) and in its audit log | **Owner decision Q-031** (F1-14) |

**Fix (DV1-23):** the egress-list lookup moved into the app. `observe` asks `app.egress_ranges_overlapping(<prefix>)` for the ranges overlapping the /24 or /48 (the usual anonymization granularity), checks exact containment itself (`lib/server/network/egress.ts`), and passes only the result (`p_egress_source`: the list name or null) to `app.observe_network`. The SQL function refuses longer prefixes, and no app function takes an `inet` argument any more (pgTAP). To keep the answer small, the loader merges adjacent ranges: on the real lists, 285,091 Private Relay ranges become 14,068 rows and 1,210 Tor exits 642 (identical address coverage, checked against Python's `collapse_addresses`), at most 106 rows per /48, lookup ≈ 0.4 ms. Classification is unchanged: an address in a /27 relay range is `shared_egress`, its neighbour in the same /24 is `ok` (integration test).

**Evidence:** `tests/integration/ip-logging.test.ts` turns on `log_statement = all` (with parameters) on the local Postgres, observes from a fresh IPv6 and IPv4 address, and reads the database log. A control query proves that a parameter carrying an address *is* logged under these settings; the observe calls log the /48 and /24 prefixes, but **neither address nor the IPv6 /64 appears**. Unit tests cover the prefix and the matching; pgTAP covers the prefix limits.

**What stays a deployment requirement** (08 §5; can't be tested locally): hosted Postgres logging settings (now only the prefix could leak, still worth confirming), the host's access-log format and retention, and the Supabase Auth IP storage decision (Q-031).

#### 18.5.3 Other changes

- **Error contract aligned with 07 §4 (F1-17, DV1-24):** a refused expiry is `422 EXPIRY_NOT_ALLOWED` (was `INVALID_EXPIRY`); a quota refusal carries `usedBytes` and `quotaBytes` (was `activeStorageBytes`). The uploader shows *"The upload took too long. Please start again."* for `UPLOAD_EXPIRED`.
- **Emulated phone E2E** (`tests/e2e/local-mobile.spec.ts`, projects `local-mobile-webkit` and `local-mobile-chromium`): a pre-check of the phone layout and upload flow with zero CSP violations, also on WebKit. **Not evidence for AC-1.6.** CI now installs WebKit.
- **R2 configuration check** (`tests/unit/r2-config.test.ts`): `infra/r2/lifecycle.json` has a backstop per retention class that outlives the longest share in it, and the CORS files allow exactly the signed upload headers.
- **T-009 fallback test:** a household's IPv4 and IPv6 networks never merge; only the current request's key counts.

#### 18.5.4 Findings

| # | Finding | Action |
|---|---|---|
| F1-12 | Deleted-share upload URL could recreate the object (review M1 residual) | Fixed (§18.5.1) |
| F1-13 | Raw client IP passed to Postgres; the Supabase image's `auto_explain` logs full parameters of statements over 10 s | Fixed (§18.5.2) |
| F1-14 | Supabase Auth stores the client IP of every session (`auth.sessions.ip`) and in its audit log. The docs' "raw IPs are never stored" was true for the app's tables only. | Docs corrected (03 §13, 02 principle 8, §10 here); **owner decision Q-031**; RISK-029 |
| F1-15 | Completion was accepted after the upload deadline until the cleanup job ran | Fixed (§18.5.1) |
| F1-16 | Supabase CLI 2.117 splits a migration wrongly at `case … end then` inside a PL/pgSQL `if` | Condition rewritten without `case` |
| F1-17 | Error codes differed from the 07 §4 contract | Code aligned (DV1-24) |
| F1-18 | Network re-checks on iOS Safari rely on tab focus and the 5-minute heartbeat (Safari has no connection-change event); old posts can stay on screen after a switch, although every request is refused | To measure in manual step T-2; change only on owner decision |
| F1-19 | The risky-download screenshot was taken mid-animation; phone-width screenshots were missing | Recaptured (§18.5.7) |

#### 18.5.5 Verification results (local, 2026-10-15)

| Check | Result |
|---|---|
| Typecheck, lint | Clean |
| Unit + component (Vitest) | **251/251** (32 files); line coverage 45% (services and UI are covered by the integration and E2E suites) |
| Database (pgTAP) | **134/134** (28 baseline + 106 Phase 1) |
| Generated types | Regenerated; a second generation is identical |
| Production build | Clean |
| API integration (real `next start`, Supabase, RustFS) | **83/83** (7 files); the new sweep test also passed three runs on its own |
| E2E (Playwright) | **20/20**: 13 Phase 0, 5 Phase 1 desktop, 2 emulated phones (WebKit, Chromium) |
| `pnpm audit --audit-level high` | Clean; one documented exception (`braces`, F1-6) |
| Documentation link check | 0 broken links |
| CI | Not run (no pull request; the remote exists, see §18.5.9) |

#### 18.5.6 Assumed product decisions (§17.2) against the documented recommendations

| Question | Documented recommendation | Implementation | Consistent? | What is needed |
|---|---|---|---|---|
| Q-007 Free quotas | 100 MB/file, 20 files/share, text 100 KB, 2 GB active/user, 2 GB/day/user, 10 GB/day per network key (07 §1) | Same values (`lib/shared/plans.ts`) | ✅ Values match. The error codes differed from 07 §4 and were fixed in code (DV1-24). | Owner confirms the values |
| Q-019 Browsers | Next.js 16 minimums: Chrome/Edge/Firefox 111+, Safari 16.4+ | Next.js defaults (no browserslist override), **but Tailwind CSS 4.3 compiles for Chrome 111, Safari 16.4 and Firefox 128** (its Lightning CSS targets) | ◐ Firefox floor is **128** in practice | Documentation corrected to Firefox 128+ (§18.6). No code change. Owner confirms. |
| Q-021 Text edit | Creator only on local shares; everyone present can copy | Creator-only edit and delete (403 `NOT_CREATOR`); Copy for everyone | ✅ | Owner confirms |
| Q-023 Release | Phases 1–2 internal or invite-only | Nothing deployed; staging is behind Cloudflare Access (08 §3). No app-level invite gate. | ✅ | Owner confirms |
| Q-029 Large-network cap | 50 devices per 24 h, configurable, fail closed while over | Runtime flag `network_large_cap` = 50; more than 50 → `too_large`, content hidden | ✅ | Owner confirms; tune with AC-1.11 data |
| Q-030 Local expiry | 24 h default; 1 h, 24 h, 7 days | Same | ✅ | Owner confirms |

#### 18.5.7 Screenshot review (AC-1.12)

Recaptured at desktop and phone width (393 px): [manual procedure §9](phase-1-manual-verification.md#9-owner-copy-review-ac-112). **Nothing was changed**; these are recommendations for the owner.

| # | Observation | Recommendation |
|---|---|---|
| S-1 | **The audience line appears twice**, word for word: in the status bar and under the composer, about 200 px apart. On a phone it wraps to two lines and both copies are on the first screen. DEC-033 asks for the audience *before posting*, which the composer line does. | Keep the line under the composer (the point of posting). Shorten the status-bar line to the network state, for example *"This network · 2 devices here now"*, or hide it while the composer is on screen. Owner decision. **Applied (§18.6).** |
| S-2 | **Phone header wraps badly:** "Local / Saver", "This / network", "My / uploads" each break onto two lines at 393 px. | Usability problem: put the tabs on their own row below the title on narrow screens. **Applied (§18.6).** |
| S-3 | **Phone notice title runs into the close (×) button.** | Give the dialog title room for the button. **Applied (§18.6).** |
| S-4 | The risky-download dialog doesn't name the file or say why it is risky. | *"setup.exe is a program. Anyone on this network could have posted it. Only open it if you know who sent it and trust it."* |
| S-5 | "Local sharing is off" leaves the page empty. | Add *"Your own posts are still in My uploads."* with a link. |
| S-6 | The device name in the header (for example "Bright Swan") is unexplained. | Label it *"This device: Bright Swan"* or add a tooltip. |

#### 18.5.8 Deviations added in this pass

| # | Planned | Built | Reason |
|---|---|---|---|
| DV1-21 | Ending a share deletes its objects (outbox, 04 §9.2); Phase 1 relies on the lifecycle backstop for leftovers | While an upload URL may be live: tombstone, key held until URL expiry + 5 min, then deleted. Sweep of due deletions after each delete. `files.upload_url_expires_at`, `object_deletions.tombstoned_at`, `app.claim_object_deletions`. | F1-12: presigned URLs can't be revoked. The Phase 3 janitor must follow the same rule (04 §9.2). |
| DV1-22 | 15-min upload URLs; completion checks the share status | URLs capped at the upload deadline and share expiry; completion re-checks deadline and expiry under lock | F1-12, F1-15 |
| DV1-23 | Egress lookup in SQL with the client address (03 §3.5 as built) | Coarse-prefix lookup (`app.egress_ranges_overlapping`), exact match in the app, `observe_network(…, p_egress_source)`; the loader merges adjacent ranges | F1-13 (review L5) |
| DV1-24 | 07 §4 error contract | Code aligned to it | F1-17 (a fix towards the plan) |

#### 18.5.9 What blocks VERIFIED

Every remaining item needs something only the owner can provide; the exact steps are in the [manual and staging procedure](phase-1-manual-verification.md).

| Blocked item | Needs |
|---|---|
| AC-1.3 T-009 (and the ASN part of T-005) | SP-04 on real Cloudflare and networks, then (if adopted) the dual-stack probe |
| AC-1.6 mobile upload | Staging + a real iPhone and Android phone (S-8, S-9) |
| AC-1.8 staging and R2 lifecycle | Staging + R2 bucket (E-1 … E-8; the backstop check takes 9 days) |
| AC-1.9 staging run | Staging (Q-1 … Q-4) |
| AC-1.11 real devices and networks | Staging + devices + networks (§3–§5, §8) |
| AC-1.12 copy approval | Owner review (§18.5.7) |
| Decisions | Q-007, Q-019 (Firefox 128), Q-021, Q-023, Q-029, Q-030 confirmations; **Q-031** (Supabase Auth IP storage) |
| CI | A pull request so the current workflow runs, a green run, and branch protection (Phase 0 AC-0.1). The GitHub remote exists. CI's only run, on the push of the Phase 0 commit to `main` (2026-09-29), failed at `pnpm typecheck` (`Cannot find name 'LayoutProps'`); the Phase 1 branch has no pull request, so the current workflow has not run. |

### 18.6 Owner follow-up (third pass, 2026-10-15)

The owner approved four follow-ups from §18.5 and nothing else: no Phase 2, no change to the same-network model, the state-management architecture or the database. Tests were changed first and failed for the expected reasons (the copy tests could not find the new lines; at 393 px the notice title overlapped the close button) before the fixes.

| Item | Change | Evidence |
|---|---|---|
| Firefox floor (Q-019) | Docs now say **Chrome/Edge 111+, Firefox 128+, Safari 16.4+** (01, 02, 06 Q-019, §17.2, §18.5.6). No code change: Tailwind CSS 4 already compiles for Firefox 128. | Doc diff |
| Phone header (S-2) | Below 640 px the title and the device name share the first row and the two tabs get their own row; no label breaks mid-label (`whitespace-nowrap`), and a long device name is truncated instead of overflowing. From 640 px up the header stays one row as before. (`components/local/app-shell.tsx`) | E2E at 320, 360, 375, 393, 412 and 430 px, on emulated iPhone (WebKit) and Pixel (Chromium), and one row at 768 and 1280 px |
| Dialog title and close button (S-3) | A dialog with a close button keeps its title 2 rem clear of it, so a wrapping title no longer runs under the ×. Applies to all three dialogs (notice, risky download, rename). (`components/ui/dialog.tsx`) | E2E: no line of the notice title overlaps the close button at any tested width |
| Audience and status copy (S-1) | Under the composer: **"Visible to everyone on this network"**, the DEC-033 statement before posting, shown only there. Status bar: **"This network · N devices here now"**. Behaviour unchanged. (`components/local/copy.ts`, `network-status.tsx`, `composer.tsx`) | Component tests; E2E: the audience text appears exactly once on the page |

Not changed: the notice, risky-download and network-off texts, and suggestions S-4 … S-6 in §18.5.7 (name the risky file, point to My uploads when sharing is off, label the device name). Observation for the AC-1.12 review: on phones the status line starts with "This network" right under the "This network" tab.

Screenshots after the fixes (desktop and 393 px): [first-visit notice](evidence/phase-1/1-first-visit-notice-phone.png), ["This network"](evidence/phase-1/2-this-network-phone.png), [risky download](evidence/phase-1/3-risky-download-phone.png), [local sharing off](evidence/phase-1/4-local-sharing-off-phone.png); desktop versions without `-phone`.

#### 18.6.1 Verification results (local, 2026-10-15)

| Check | Result |
|---|---|
| Typecheck, lint | Clean |
| Unit + component (Vitest) | **252/252** (32 files): one new composer test; the status-line tests now expect the approved copy |
| E2E (Playwright) | **30/30**: 13 Phase 0; 13 Phase 1 desktop (5 multi-device, 8 layout); 2 + 2 emulated phones (layout, upload flow) |
| Production build | Clean |
| Also re-run | API integration **83/83**, pgTAP **134/134**, `pnpm audit --audit-level high` clean (one documented exception) |
| Documentation link check | 0 broken links |

No test was removed or weakened. The changed assertions are the two status-line component tests and the multi-device E2E check, which now expect the approved copy and additionally assert the audience text appears once.

#### 18.6.2 Q-031 stays an owner decision (not solved)

**Supabase Auth stores the client IP address of every session** (`auth.sessions.ip`) **and records IPs in its audit log**, for as long as the session exists. The app's own tables, database query parameters and logs hold no raw IPs (§18.5.2), but the Supabase project's database does. Nothing has been implemented for this: no privacy-notice text, no retention job, no session time-boxing. It remains **Q-031** (owner decision) and **RISK-029** (open), with the options listed in [06](../06-decisions-and-risks.md).

#### 18.6.3 Still blocked

Unchanged from §18.5.9: AC-1.3 (T-009, needs SP-04), AC-1.6 (real phones), AC-1.8 (staging and R2 lifecycle), AC-1.9 (staging), AC-1.11 (real devices and networks), AC-1.12 (owner sign-off of the remaining texts and screenshots), the six assumed answers and Q-031, and CI (no pull request run yet). The steps are in the [manual and staging procedure](phase-1-manual-verification.md). Phase 1 stays **NEEDS REVIEW** until that verification is done.
