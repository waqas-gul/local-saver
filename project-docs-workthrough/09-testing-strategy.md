# 09 — Testing Strategy

| Field | Value |
|---|---|
| Document status | PROPOSED |
| Last updated | 2026-10-18 (Phase 4, P4-26: §4.14 the final run; §7 what CI must settle before running Phase 4; §8 the Phase 4 procedure written; §9 Phase 4's state). 2026-10-18 (Phase 4, P4-25: §4.14 Phase 4 test map with the mutation checks, the latest full run and the known flaky tests; §4.10 points to it; §5 matrix actors as built; §7 CI has not run Phase 4; §8, §9 the Phase 4 procedure is P4-26's; §2 RustFS and the `room:` topic). 2026-10-16 (§4.12: report copy makes no review promise, owner decision on abuse notification). 2026-10-15 (Phase 2 suites implemented: §4.12 test map, §5 matrix actors as built, §8 Phase 2 manual procedure). Earlier the same day: Phase 1 suites, §3 as built, §4.11 test map; RustFS instead of MinIO |
| Applies to | All phases. Each phase document lists which tests from this catalogue it must deliver. |

---

## 1. Principles

1. **Test-first** for services, SQL functions and every security-critical rule (authorization, claims, quotas, tokens).
2. **Every authorization rule has positive and negative tests.** Access-denied tests matter more than happy paths.
3. **Real Postgres for authorization and concurrency.** No database mocks for policy logic. Use the local Supabase stack.
4. **Storage:** unit tests mock the S3 client. Integration tests use an S3-compatible server (**RustFS** since Phase 1: MinIO no longer publishes images, phase 1 DV1-4). **Nightly contract tests against a real R2 staging bucket** cover R2-specific behaviour.
5. **Multi-device end-to-end tests:** Playwright browser contexts act as separate devices on simulated networks.
6. **Evidence-based verification:** a phase is `VERIFIED` only with recorded evidence for every acceptance criterion (§9).

---

## 2. Test layers and tools

| Layer | Tool | Scope | When |
|---|---|---|---|
| Unit | Vitest | IP normalization, network key derivation, the visibility rule, HMAC and timing-safe helpers, ID/secret/code generation and normalization, filename sanitization, `Content-Disposition` encoding, entitlement resolution, expiry validation, zod schemas, error mapping | Every PR |
| Component | Vitest + Testing Library (jsdom) | Uploader state machine, text conflict handling, network status states and audience line, burn confirmation UI | Every PR |
| Database | pgTAP (`supabase test db`) | Constraints, grants (client roles denied on `app`), `realtime.messages` policies, `can_access_topic` (`net`, `user`, and `room` since Phase 4), SQL functions (`reserve_storage`, `end_share`, `claim_burn_share`, `rate_limit_hit`, `observe_network`, `refresh_network_status`), triggers | Every PR |
| API integration | Vitest + local Supabase + RustFS (not MinIO, phase 1 DV1-4); since Phase 4 also Mailpit and a fake billing provider (§4.14) | Route handlers with a real DB: authentication, IDOR matrix, CSRF/Origin, rate limits, upload init → PUT → complete, download issuance, link unlock, codes | Every PR |
| Concurrency | Vitest with parallel requests or connections | Burn claim exactly once, quota boundary, concurrent `observe` upserts, seat limits, idempotency keys | Every PR (fast), nightly (heavy) |
| Realtime integration | Vitest + local Supabase Realtime | Channel join allowed/denied, presence permissions, trigger emission after commit only | Every PR |
| End-to-end | Playwright (Chromium, WebKit, Firefox) | Multi-device user flows | PR smoke, nightly full |
| R2 contract | Vitest against the staging bucket | Signed `Content-Type` enforcement, stored `Content-Disposition`, CORS preflight, multipart rules, deletes, lifecycle rules present | Nightly |
| Security scanning | Dependency audit, secret scanning, OWASP ZAP baseline on staging, header/CSP checks | Nightly/weekly and before each release gate |
| Load | k6 | Observe, local feed, share create/complete, download URL, unlock, Realtime connection soak | Before public beta and paid launch |
| Manual / exploratory | Real devices and networks (§8) | Real-world network grouping, mobile uploads, iOS downloads, QR scanning, burn UX | Each phase verification |

---

## 3. Simulating networks safely

- In test environments only (`NODE_ENV=test` **and** `ALLOW_TEST_CLIENT_IP=1`), `lib/server/network/client-ip.ts` reads `X-Test-Client-IP`.
- A unit test proves that **loading production configuration with `ALLOW_TEST_CLIENT_IP` set throws at boot**.
- Playwright fixture `deviceOn(network)` creates an isolated browser context (its own storage, so its own anonymous user) that sends `X-Test-Client-IP`:

| Fixture network | Address | Purpose |
|---|---|---|
| `homeA` | `203.0.113.10` | Baseline network A |
| `homeB` | `198.51.100.20` | Different network |
| `homeA_v6_1` / `homeA_v6_2` | `2001:db8:a:1::10` / `2001:db8:a:1::99` | Same /64 as each other |
| `otherV6` | `2001:db8:a:2::10` | Different /64 |
| `mappedV4` | `::ffff:203.0.113.10` | Must equal `homeA` |
| `relay` | An address inside a seeded `network_egress_ranges` CIDR | `shared_egress` |
| `cgnatV4` + `cgnatV6_1` / `cgnatV6_2` | `203.0.113.50` with `2001:db8:c:1::10` and `2001:db8:c:2::10` (via dual-stack binding) | The IPv4 space becomes `shared_egress` |
| `mobileAsn` | Any address plus `X-Test-Client-ASN` of a seeded mobile-carrier ASN (test mode only) | IPv4 → `shared_egress`; IPv6 stays `ok` |
| `privateAddr` | `192.168.1.5` | Must be `unavailable` |

The ASN override follows the same rule as the IP override: honoured only in test mode, refused at production boot.

**Documentation ranges (found in Phase 0):** the fixtures use RFC 5737 / RFC 3849 documentation addresses (`203.0.113.0/24`, `198.51.100.0/24`, `2001:db8::/32`), which the production rules reject as non-global. `normalizeClientIp` accepts them only with `allowDocumentationRanges`, which `resolveClientIp` sets **only for the test override**. Addresses arriving through Cloudflare never get this exemption (covered by a unit test).

**As implemented in Phase 0:** the override is honoured only when `ALLOW_TEST_CLIENT_IP=1`, `NODE_ENV` is not `production`, and `APP_ENV` is `local` or `test`. `proxy.ts` strips `X-Test-Client-IP` from every request otherwise.

**As implemented in Phase 1:**

- Test servers are the production build started with `NODE_ENV=test` (`next start` keeps it), so the override works there while deployments (`NODE_ENV=production`) refuse it (F1-8).
- Tests use a **random IPv6 /64 per test** (`2001:db8:xxxx:yyyy::/64`) instead of fixed fixtures, so repeated runs never accumulate presence and trip `too_large`. Relay and blocked networks are made by inserting an egress range or setting a space's status for that random network.
- `TEST_CLIENT_IP_DEFAULT` (local development only) gives requests without the header one simulated network, so two local browsers share it.
- The `mobileAsn` and `cgnatV4` fixtures don't apply until SP-04 (no ASN list, no dual-stack binding).
- In Playwright, each browser context is a device and adds `X-Test-Client-IP` only to same-origin `/api/v1/` requests (route interception), so storage and Supabase calls are unchanged.

---

## 4. Critical test catalogue

IDs are stable. Phase documents reference them.

### 4.1 Local visibility and network isolation

| ID | Test | Layer | Phase |
|---|---|---|---|
| T-001 | A device on network B sees **nothing** of network A: A's shares are absent from B's feed, their IDs return 404 for details, download and preview URLs, and B cannot join `net:{A's space}` (G1, G7) | E2E + integration | 1 |
| T-002 | A second device on network A sees A's existing and new local shares **automatically, with no join step**, downloads them, and receives new items in realtime | E2E + integration | 1 |
| T-003 | **Leaving the network:** the same device changes from A's IP to B's. Its next request for A's shares returns 404. Its observe from B ends its presence on A. The UI moves to B's feed, and **A's items are removed from the TanStack Query cache**, not just hidden (G3, RISK-027, DEC-034). | Integration + E2E | 1 |
| T-004 | **Large-network cap:** 51 distinct devices within 24 h → space `too_large`. The feed is empty, posting is refused, existing local shares are hidden for everyone on that network, and the creator still sees them in "My uploads". The status stays for ≥ 7 days. | Integration | 1 |
| T-005 | **Shared egress:** a relay-range IP, a seeded VPN ASN, or a mobile-carrier ASN on IPv4 → `shared_egress`, local mode off. The same mobile ASN on IPv6 stays `ok`. | Integration | 1 |
| T-006 | Normalization: mapped/NAT64 → IPv4 key. Same IPv6 /64 → same key. Different /64 → different key. | Unit | 1 |
| T-007 | Non-global addresses → `unavailable` plus an alert log | Unit + integration | 1 |
| T-008 | Origin lock (production mode): a missing or wrong `X-Origin-Auth` gets 403. `CF-Connecting-IP` is ignored when the lock fails. `X-Forwarded-For` is never used. | Integration + SP-01 manual | 0–1 |
| T-009 | **Dual-stack binding** (if adopted): a binding is honoured only while the current request's key is one of its keys. Expired, reused or other-device nonces are refused. An IPv4 bound to two IPv6 /64s within an hour becomes `shared_egress` (`cgnatV4` fixture). | Integration | 1 |
| T-010 | **No network input:** no route accepts a network or space ID. Parameters or headers naming another space (for example `?spaceId=`, a body field) are ignored or rejected, and responses for a share on another network are identical (apart from the request ID) to those for a non-existent share. | Integration (IDOR matrix) | 1 |

### 4.2 Local share permissions and posting

| ID | Test | Layer | Phase |
|---|---|---|---|
| T-011 | Only the creator can edit a local text share, delete a local share, or create and revoke its links. Other devices on the network get 403 `NOT_CREATOR`. | Integration | 1–2 |
| T-012 | A `link_only` share never appears in any network feed or realtime topic | Integration | 2 |
| T-013 | Kill switch `local_sharing_enabled = false` and `network_spaces.status = 'blocked'` hide local content and refuse posting | Integration | 1 |
| T-014 | The creator sees their local shares in "My uploads" from any network, including while their original network is `too_large` or blocked | Integration + E2E | 1 |

### 4.3 Realtime

| ID | Test | Layer | Phase |
|---|---|---|---|
| T-015 | A device without fresh presence cannot join `net:{spaceId}`. A present device can, while the space is `ok`. Client broadcast sends are denied. Present devices may track Presence. | Realtime integration | 1 |
| T-016 | `user:{id}` is joinable only by that user | Realtime integration | 1 |
| T-017 | Triggers emit nothing for rolled-back transactions | DB / realtime integration | 1 |
| T-018 | Trigger payloads contain only IDs and state (asserted against an allow-list of keys). A local share emits to `net:{spaceId}` and the creator's `user:` topic only. | DB | 1 |

### 4.4 Uploads and storage

| ID | Test | Layer | Phase |
|---|---|---|---|
| T-019 | Declared size above the plan limit → 413 | Integration | 1 |
| T-020 | An object larger or smaller than declared → completion rejects, object deleted, reservation released | Integration (MinIO) + contract (R2) | 1 |
| T-021 | A PUT with a `Content-Type` different from the signed one is refused by R2 | R2 contract | 0 (SP-02), 1 |
| T-022 | A stale pending upload is rejected by the job, with deletion enqueued and reservation released | DB + integration | 1 |
| T-023 | Filename sanitization: bidi overrides, control characters, reserved names, separators, > 255-byte names | Unit | 1 |
| T-024 | Object key format has no filename. `Content-Disposition` is correct for UTF-8 names. | Unit + contract | 1 |
| T-025 | Magic bytes: a PE file named `.png` gets the `executable` flag and no preview. HTML declared as `image/png` gets no preview. | Integration | 1 |
| T-026 | Parallel reservations near the quota never exceed it. Release on end restores capacity. | Concurrency + DB | 1 |

### 4.5 Downloads

| ID | Test | Layer | Phase |
|---|---|---|---|
| T-027 | Download URLs expire after 60 s. Expired or ended shares deny issuance. | Integration + contract | 1 |
| T-028 | Preview URLs only for verified raster images, never for burn shares | Integration | 1, 3 |

### 4.6 Remote links

| ID | Test | Layer | Phase |
|---|---|---|---|
| T-029 | A link viewer on another network can access only the target. No other local shares, space or room IDs, presence or device data appear in DTOs. | Integration (IDOR) | 2 |
| T-030 | A wrong secret and an unknown link ID give identical 404 bodies and comparable timing. State is revealed only after a valid secret. | Integration | 2 |
| T-031 | A revoked or expired link invalidates the grant on the next request | Integration | 2 |
| T-032 | Short codes: normalization (O/0, I/L/1, hyphens, spaces), expiry, failure limits, Turnstile escalation, never returns the secret | Unit + integration | 2 |
| T-033 | Unfurler simulation: `GET /s/{linkId}` without a fragment returns no share data and changes no state | E2E | 2 |
| T-034 | Private-room invite accept requires the secret. Pairing invites are single use and expire. No invite or link can target a network feed. | Integration | 4 |
| T-035 | An executable in an anonymous remote link → 422 | Integration | 2 |
| T-036 | Abuse report → operator block → link and share inaccessible, objects enqueued, audit written | Integration + E2E | 2 |

### 4.7 Burn after download

| ID | Test | Layer | Phase |
|---|---|---|---|
| T-037 | **50 concurrent claims → exactly 1 success and 49 × 410** | Concurrency | 3 |
| T-038 | The claimant retries within grace (≤ 3 per file). Another device fails. After grace → 410. Finalize consumes and enqueues deletion with `not_before` after grace. | Integration | 3 |
| T-039 | Downloads by the creator never claim | Integration | 3 |
| T-040 | Text burn: Reveal is the claim | Integration + E2E | 3 |

### 4.8 Expiry and cleanup

| ID | Test | Layer | Phase |
|---|---|---|---|
| T-041 | Once `expires_at` has passed, every access path denies, **even before any job runs** | Integration | 1 |
| T-042 | `end_share` is idempotent, nulls text, releases quota, enqueues deletions and emits a signal | DB | 1 |
| T-043 | Janitor: processes only due rows, retries with backoff, refuses invalid key formats, refuses active shares, honours dry-run | Integration (MinIO) | 3 |
| T-044 | Orphan reconciliation deletes only objects older than 48 h without live rows | Integration | 3 |
| T-045 | Anonymous-user cleanup removes inactive users without active shares, with cascades | DB | 3 |

### 4.9 API hygiene

| ID | Test | Layer | Phase |
|---|---|---|---|
| T-046 | Mutations with a missing or wrong `Origin`, or a non-JSON body, are rejected | Integration | 1 |
| T-047 | API responses send `Cache-Control: no-store`. Share, invite and code pages are `noindex` and `no-referrer`. | Integration | 1–2 |
| T-048 | CSP with a nonce on app pages. No unnonced inline scripts. No `X-Powered-By`. | E2E / header check | 0–1 |
| T-049 | Every rate-limited action returns 429 with `Retry-After` at its threshold | Integration | 1–2 |

### 4.10 Entitlements, billing, accounts, workspaces

| ID | Test | Layer | Phase |
|---|---|---|---|
| T-050 | Every row of [07 §3](07-plans-and-entitlements.md#3-enforcement-points) has a negative test | Integration | 4 |
| T-051 | Downgrade: existing passwords still enforced, new Pro features blocked, uploads blocked when over quota | Integration | 4 |
| T-052 | Billing webhooks: invalid signature → 400, duplicate event processed once, out-of-order ignored, redirect parameters never grant Pro | Integration | 4 |
| T-053 | Anonymous → permanent keeps shares ("My uploads") and private-room memberships. Merge requires a valid anonymous token and cannot take over another user's anonymous data. | Integration | 4 |
| T-054 | Cross-workspace isolation, admin vs member actions, seat-limit race, retention policy, branding assets PNG/JPEG only | Integration + concurrency | 5 |

**As built (Phase 4, 2026-10-18):** T-050 … T-053 are implemented and automated **locally**, T-052 against a fake billing provider only. [§4.14](#414-phase-4-test-map-as-built-2026-10-18) maps them to suites and lists what still needs staging (the provider sandbox and one real transaction, AC-4.3). T-054 stays Phase 5: no workspace code exists.

### 4.11 Phase 1 test map (as built, 2026-10-15)

| Tests | Where |
|---|---|
| T-005 (real loader with fixture lists, merged ranges, exact-address matching, refusal to empty a list) | `tests/integration/egress-loader.test.ts`, `tests/unit/egress-loader.test.ts` |
| No client address reaches Postgres, even with full statement logging (phase 1 F1-13) | `tests/integration/ip-logging.test.ts`, `tests/unit/egress-list.test.ts`, pgTAP (no `inet` arguments, prefix limits) |
| Upload URLs after a share ends: tombstones, 412 on re-PUT, URL expiry recorded and capped, completion deadline (phase 1 F1-12, F1-15) | `tests/integration/uploads.test.ts`, pgTAP (`claim_object_deletions`) |
| T-009 fallback without SP-04: IPv4 and IPv6 networks never merge | `tests/integration/local-sharing.test.ts` |
| R2 lifecycle and CORS files match the code (AC-1.8 config part) | `tests/unit/r2-config.test.ts` |
| Emulated phones (WebKit iPhone, Chromium Pixel): layout and upload flow, **not real-device evidence** | `tests/e2e/local-mobile.spec.ts` |
| Phone-width layout at 320–430 px (header labels on one line, dialog title clear of the close button, no sideways scroll) and one-row header at 768/1280 px | `tests/e2e/local-layout.spec.ts` |
| Audience line only under the composer; status bar "This network · N devices here now" | `tests/component/local-ui.test.tsx`, `tests/e2e/local-sharing.spec.ts` |
| Stale egress lists fail closed, write-once uploads and stored-header check (security review M1, M2) | `tests/unit/egress-list.test.ts`, `tests/integration/uploads.test.ts`, `supabase/tests/phase1_local_sharing.test.sql` |
| T-001, T-002, T-003, T-004, T-005 (lists), T-007, T-011, T-013, T-014, T-041 | `tests/integration/local-sharing.test.ts`; T-001/T-002/T-003/T-011 also `tests/e2e/local-sharing.spec.ts` |
| T-006, T-023, T-024 (unit), T-025 (unit) | `tests/unit/network-key.test.ts`, `filenames.test.ts`, `storage-keys.test.ts`, `sniff.test.ts` |
| T-008 | `tests/e2e/origin-lock.spec.ts` (Phase 0) and `tests/unit/network-client-ip.test.ts` |
| T-010, T-046, T-047, T-049 | `tests/integration/api-hygiene.test.ts` |
| T-015, T-016, T-017, T-018 (delivery) | `tests/integration/realtime.test.ts` |
| T-018 (payload allow-list), T-022, T-042, guards, quota ledger, topic authorization | `supabase/tests/phase1_local_sharing.test.sql` |
| T-019, T-020, T-021, T-024, T-025, T-026, T-027, T-028 (preview), 100 MB single PUT | `tests/integration/uploads.test.ts` |
| IDOR matrix (§5) | `tests/integration/authz-matrix.test.ts` (fails if a route or method has no entry) |
| T-048 | `tests/e2e/smoke.spec.ts` and zero-violation checks in `tests/e2e/local-sharing.spec.ts` |
| Cache removal on network change (T-003, RISK-027), API client, uploader store, status copy, share card | `tests/unit/client-*.test.ts`, `tests/component/local-ui.test.tsx` |
| T-009 | Not applicable until SP-04 adopts the dual-stack probe |

### 4.12 Phase 2 test map (as built, 2026-10-15)

| Tests | Where |
|---|---|
| T-011 (links: creator only, 403 for others on the network, 404 elsewhere) | `tests/integration/remote-links.test.ts`, `authz-matrix.test.ts` |
| T-012 (link-only never in a feed or `net:` topic) | `remote-links.test.ts`, `realtime.test.ts`, `supabase/tests/phase2_remote_sharing.test.sql`, `tests/e2e/local-remote-sharing.spec.ts` |
| T-029 (viewer sees only the target; this share vs another share) | `remote-links.test.ts`, the IDOR matrix (`linkViewer`, `otherLinkViewer`), E2E |
| T-030 (identical 404 for wrong secret, unknown and malformed link; comparable timing; 410 only after proof) | `remote-links.test.ts` |
| T-031 (revoked, expired, ended share, expired grant) | `remote-links.test.ts`, E2E |
| T-032 (codes: normalization, expiry, replacement, limits, Turnstile escalation, 24-hour block, secret never returned) | `tests/unit/short-code.test.ts`, `link-secrets.test.ts`, `tests/integration/short-codes.test.ts`, `tests/component/remote-ui.test.tsx`, E2E |
| T-033 (unfurlers) | `tests/integration/remote-hygiene.test.ts`, E2E |
| T-035 (executables refused for links; archives with a warning) | `tests/unit/file-policy.test.ts`, `sniff.test.ts`, `remote-links.test.ts`, E2E (archive warning) |
| T-036 (report → takedown → access gone, objects queued, audit) | `tests/integration/abuse.test.ts`, pgTAP, E2E |
| T-047 (share and code pages: `no-store`, `noindex`, `no-referrer`) | `remote-hygiene.test.ts`, `tests/unit/security-headers.test.ts`, E2E |
| T-049 (link-related 429s: unlock, daily URL cap, code block, reports) | `remote-links.test.ts`, `short-codes.test.ts`, `abuse.test.ts` |
| Secrets and codes never in database statements or server logs | `remote-hygiene.test.ts` (full statement logging, server log file) |
| Session fixation, cookie attributes | `remote-links.test.ts`, `tests/unit/link-cookies.test.ts` |
| QR content | `tests/component/share-qr.test.tsx` (decodes the rendered SVG), E2E (decodes the creator's QR and opens it) |
| Kill switches `remote_links_enabled`, `short_codes_enabled` | `remote-links.test.ts`, `short-codes.test.ts` |
| Report copy promises no review, since no alert reaches a person (owner decision 2026-10-16) | `tests/component/remote-ui.test.tsx` (report dialog and report page) |
| Real phone cameras and keyboards, takedown rehearsal, real Turnstile and R2 | Manual: [phase 2 procedure](phases/phase-2-manual-verification.md) (not run) |

### 4.13 Phase 3 test map (as built, 2026-10-16)

New IDs T3-01 … T3-12 are from [phase 3 §17.15](phases/phase-3-expiry-one-time-download.md#1715-test-plan). Results: [phase 3 §18.8](phases/phase-3-expiry-one-time-download.md#188-tests).

| Tests | Where |
|---|---|
| T-037 (50 claims → one winner): SQL level with 50 connections, ×20; API level with 50 devices; mixed devices and viewers; a mutation check at both levels; isolation refused | `tests/integration/burn-concurrency.test.ts` |
| T-038 (claimant retries ≤ 3 per file, others 410, after grace 410, finalize), T3-01 (10 parallel retries → 3 URLs) | `tests/integration/burn.test.ts`, `burn-concurrency.test.ts`, `supabase/tests/phase3_burn.test.sql`, E2E `local-burn.spec.ts` |
| T-039 (creator never claims; downloads until consumed, D-7) | `burn.test.ts`, pgTAP, E2E |
| T-040 (text Reveal is the claim) | `burn.test.ts`, pgTAP, `tests/component/burn-ui.test.tsx`, E2E |
| T-028 burn part (no previews for burn shares) | `burn.test.ts` |
| T-043 (guard rails: active and claimed shares, key format; backoff; dry run) | `tests/integration/janitor.test.ts`, `supabase/tests/phase3_janitor.test.sql`, `tests/unit/janitor-core.test.ts` |
| T-044, T3-08, T3-09 (orphans queued, young and live kept, unknown keys counted, missing objects marked, cursor across invocations) | `janitor.test.ts`, pgTAP |
| T-045 (anonymous-user cleanup with cascades; suspended users kept, D-9) | `supabase/tests/phase3_retention.test.sql`, `tests/integration/retention.test.ts` |
| T3-02, T3-03, T3-06 (R2 errors, dropped connections, tombstone failure, five failures → health 503) | `janitor.test.ts` (`tests/integration/support/fault-proxy.ts`) |
| T3-04, T3-05 (a crashed run's locks; the janitor switched off: access denied, bytes wait) | `janitor.test.ts` |
| T3-07 (pg_cron stopped: access denied; health 503) | `tests/integration/cron-health.test.ts` |
| T3-10, T3-11 (a claimed share's lifecycle; deletion after the 5-minute margin; end to end through cron and the function) | `burn.test.ts`, `uploads.test.ts` |
| T3-12 and AC-3.8 (unfurlers and a page left open never claim) | `burn.test.ts`, E2E |
| Purge with evidence exclusions (D-3), legal hold and release (D-2) | pgTAP, `retention.test.ts`, `janitor.test.ts` |
| Legal-hold copies out of the lifecycle rules' reach (RISK-031): the copy, a missing source, the original deleted as R2 would, release deleting both; no lifecycle rule on `hold/` | `janitor.test.ts`, pgTAP, `tests/unit/{janitor-core,s3-fetch,r2-config}.test.ts` |
| The janitor never uses the injected Supabase secrets (RISK-036): a static scan of `supabase/functions`; the real function with `app_janitor` blocked | `tests/unit/functions-env.test.ts`, `janitor.test.ts` |
| Storage-usage reconciliation and its race | pgTAP, `retention.test.ts` |
| Egress loader under `app_egress_loader` (D-4) | `tests/integration/egress-loader.test.ts`, pgTAP |
| `/health/cron`, `/me/entitlements` | `cron-health.test.ts`, `burn.test.ts`, the IDOR matrix |
| The deletion tests of Phase 1 after D-1 (the janitor runs, every assertion kept) | `tests/integration/uploads.test.ts` |
| Real phones, staging soak, chaos with alerts, restore drill | Manual: [phase 3 procedure](phases/phase-3-manual-verification.md) (not run) |

### 4.14 Phase 4 test map (as built, 2026-10-18)

New IDs (T-052.n, T-053.n and T4-A, T4-E, T4-EN, T4-B, T4-M, T4-X, T4-P, T4-R, T4-H) are from [phase 4 §17.19](phases/phase-4-pro-accounts.md#1719-test-plan), the plan. What each task built and ran is in its own tests subsection, [phase 4 §18.6](phases/phase-4-pro-accounts.md#186-tests) … [§31.7](phases/phase-4-pro-accounts.md#317-tests); suite sizes per task are in [ARCHITECTURE §16](ARCHITECTURE.md#16-testing-architecture). **All of this is local evidence:** Phase 4 is uncommitted, CI has not run it (§7), and nothing in it is VERIFIED.

| Tests | Where |
|---|---|
| **Accounts** ([§18.6](phases/phase-4-pro-accounts.md#186-tests)): T4-A1, T4-A1b (sign-up and a second sign-in by email code), T4-A1c (by code; since P4-23 an E2E journey also opens the emailed link through the callback's **Continue**), T4-A1d (Google, stubbed only), T4-A11 (the cache cleared on a user change), password sessions refused (F4-2) | `tests/integration/accounts.test.ts`, `tests/unit/accounts.test.ts`, `tests/component/{account-ui,runtime-auth}.test.tsx`, `supabase/tests/phase4_accounts.test.sql`, `tests/e2e/local-accounts.spec.ts` |
| **Merge** ([§18.6](phases/phase-4-pro-accounts.md#186-tests)): T-053.1 (the upgrade keeps the user ID), T-053.2 … T-053.19 (the threat rows M1 … M16: fault injection at 12 tables, the coverage list, concurrency; T-053.10 with 10 parallel redemptions, not 20: DV4-12) | `tests/integration/{merge,merge-concurrency}.test.ts`, `phase4_accounts.test.sql`, `local-accounts.spec.ts` |
| **Devices** ([§18.6](phases/phase-4-pro-accounts.md#186-tests)): T4-A7 (the cap of 10 with concurrent registrations, a revoked device's `DEVICE_REVOKED`, a suspended user's `403`), T4-A8/9 (list and revoke), T4-A10 (`net:` isolation per device, C4-2), E26 | `tests/integration/devices.test.ts`, the account cases in `realtime.test.ts`, `phase4_accounts.test.sql` |
| **Entitlements** ([§19.7](phases/phase-4-pro-accounts.md#197-tests)): T-050 as the rows of the [enforcement matrix as built](phases/phase-4-pro-accounts.md#193-the-enforcement-matrix-as-built), each with positive, negative and boundary cases (rows built later are tested in their own task's suite, below); T4-EN1 … EN5 (resolution at each status boundary, overrides, snapshot v2, `/me/entitlements`, spoofing); T-051 (the [downgrade rows](phases/phase-4-pro-accounts.md#194-snapshot-and-downgrade-rules-as-built-1716), plus each later feature's own) | `tests/integration/entitlements.test.ts`, `tests/unit/entitlements.test.ts`, `supabase/tests/phase4_entitlements.test.sql`, `tests/component/billing-ui.test.tsx` (hints, pricing page), `tests/e2e/local-entitlements.spec.ts`; `proOther` in the IDOR matrix |
| **Billing**, against the fake provider only ([§20.7](phases/phase-4-pro-accounts.md#207-tests)): T-052.1 … 15 (the threat rows B1 … B16 except B15, a runbook item; B17 is a staging item), T4-B1 (checkout), T4-B2 (portal), T4-B3 (the lifecycle), T4-B4 (reconciliation), T4-B5 (redirect spoofing), E31 | `tests/integration/billing.test.ts`, `supabase/tests/phase4_billing.test.sql`, `tests/unit/billing-{env,fake-adapter,boundaries}.test.ts`, `tests/component/billing-settings.test.tsx`, `tests/e2e/local-billing.spec.ts` |
| **Multipart** ([§21.7](phases/phase-4-pro-accounts.md#217-tests)): T4-M0 … M13 except M6 (no `Content-MD5`, so it doesn't apply), E25; the browser journey (interrupted, reloaded, the file picked again, the object checked byte for byte) at 120 MiB in every run and once at 5 GiB (`E2E_MULTIPART_LONG=1`) | `tests/integration/multipart.test.ts`, `supabase/tests/phase4_multipart.test.sql`, `tests/unit/{multipart,client-multipart,janitor-core}.test.ts`, `tests/component/upload-resume.test.tsx`, `tests/e2e/local-multipart.spec.ts` |
| **Expiry 30/90 days and extend** ([§22.7](phases/phase-4-pro-accounts.md#227-tests)): T4-X1 … X6 (in place, and by copy through the real janitor Edge Function, with faults through the proxy), E5, E6 | `tests/integration/extend.test.ts`, `supabase/tests/phase4_extend.test.sql`, `tests/unit/{janitor-core,s3-fetch}.test.ts`, `tests/component/extend-ui.test.tsx`, `tests/e2e/local-extend.spec.ts` |
| **Link passwords** ([§23.6](phases/phase-4-pro-accounts.md#236-tests)): T4-P1 … P7 and P9 (locks, Turnstile after a lock, codes, change and removal, a change racing a verification, no password in logs), T4-P8 (the scrypt format and the attempt order, DV4-70), E11, E12 | `tests/integration/passwords.test.ts`, `tests/unit/password.test.ts`, `supabase/tests/phase4_link_passwords.test.sql`, `tests/component/password-ui.test.tsx`, `tests/e2e/local-passwords.spec.ts` |
| **Private rooms and invite links** ([§24.8](phases/phase-4-pro-accounts.md#248-tests)): T4-R1 … R4, R7 … R11, R13, R14, T-034 (invite links), E17 … E19, E21, E23, E29, E30, the downgrade, the `room:` topic | `tests/integration/rooms.test.ts`, `supabase/tests/phase4_rooms.test.sql`, `tests/unit/{room-labels,visibility,visibility-burn}.test.ts`, `tests/component/room-ui.test.tsx`, `tests/e2e/local-rooms.spec.ts`; T4-R7's cells also in the IDOR matrix |
| **QR pairing** ([§25.6](phases/phase-4-pro-accounts.md#256-tests)): T-034 for pairing codes (one use, 10 minutes), T4-R3, R8, R9 for pairing codes, E20, T4-R15's render-and-decode half | `tests/integration/pairing.test.ts`, `supabase/tests/phase4_pairing.test.sql`, `tests/unit/invite-schemas.test.ts`, `tests/component/pairing-ui.test.tsx`, `tests/e2e/local-pairing.spec.ts`; the IDOR matrix's pairing pass |
| **Read-only room links** ([§26.6](phases/phase-4-pro-accounts.md#266-tests)): T4-R5, R6, R12, E15, E16, E22 | `tests/integration/room-links.test.ts`, `supabase/tests/phase4_room_links.test.sql`, `tests/unit/room-link-schemas.test.ts`, `tests/component/room-link-ui.test.tsx`, `tests/e2e/local-room-links.spec.ts` |
| **Transfer history** ([§27.6](phases/phase-4-pro-accounts.md#276-tests)): T4-H1, T4-H2 (own shares only; no identities, IPs, network keys or secrets in any field), T4-H3 (in integration, not pgTAP as planned: DV4-127; the purge itself is Phase 3's pgTAP), E24 | `tests/integration/history.test.ts`, `tests/component/history-ui.test.tsx`, `tests/e2e/local-history.spec.ts` (no migration, so no pgTAP file) |
| **Merge and deletion coverage** ([§28.7](phases/phase-4-pro-accounts.md#287-tests)): T-053.3, .12, .13 with rooms, history and links; T4-A5's execution (what the deletion job removes and keeps); the merge racing room activity | `supabase/tests/phase4_account_coverage.test.sql`, `tests/integration/account-coverage.test.ts`, `tests/unit/http-handler.test.ts` |
| **Account deletion** ([§29.7](phases/phase-4-pro-accounts.md#297-tests)): T4-A5 (the request: a recent sign-in, or `aal2` with an authenticator; the grace; the job), T4-A6 (cancel restores writes), E30, races with sign-in, a merge and room activity | `tests/integration/account-deletion.test.ts`, `supabase/tests/phase4_account_deletion.test.sql`, `tests/component/{account-deletion-ui,runtime-auth}.test.tsx`, `tests/unit/accounts.test.ts`, `tests/e2e/local-account-deletion.spec.ts` |
| **Email, local part** ([§30.7](phases/phase-4-pro-accounts.md#307-tests); no catalogue ID): every Auth email is ours, codes in the body only, links only through the callback, the password reset carries nothing; delivery to Mailpit, a mail scanner, replay, expiry, unknown addresses | `tests/unit/email-templates.test.ts`, `tests/integration/email.test.ts`, `tests/component/account-ui.test.tsx`, `local-accounts.spec.ts` |
| **MFA** ([§31.7](phases/phase-4-pro-accounts.md#317-tests)): T4-A12 with real TOTP codes (enrolment ends the other sessions; a new sign-in gets no device or Realtime until `aal2`; removal needs `aal2`; nothing the client sends counts); 4A's `aal2` rule for revocation (D4-30) | `tests/integration/mfa.test.ts`, `supabase/tests/phase4_mfa.test.sql`, `tests/component/{mfa-ui,runtime-auth}.test.tsx`, `tests/e2e/local-mfa.spec.ts`; 4A's rule in `tests/integration/devices.test.ts` |
| IDOR matrix (§5): the Phase 4 actors, and a row for every new route and method | `tests/integration/authz-matrix.test.ts` |
| **Not automated** (staging, real devices, the owner): T4-B6 (provider sandbox) and T4-B7 (one real transaction), blocked on Q-005 and P4-13; real email delivery and the [`infra/email`](../infra/email/README.md) §7 checks; real Google sign-in; hosted Supabase (TOTP settings, rate limits, the `auth.users` delete); R2 (5 GiB multipart with an interrupted network, `CopyObject`, lifecycle rules, the janitor's abort); T4-R15's real-phone scan and a room across Wi-Fi and mobile data; desktop Safari, Firefox and Edge (Phase 4's E2E journeys ran in desktop Chromium only, phone widths by viewport); the AC-4.7 deletion rehearsal | Manual and staging: the Phase 4 procedure is P4-26's (§8), not written yet |

**Mutation checks.** Phase 4 kept Phase 3's practice ([phase 4 §17.19.8](phases/phase-4-pro-accounts.md#17198-idor-matrix-and-regression)): each task deliberately broke its own code, one change at a time (server code rebuilt and run against `next start`, database objects changed live, UI code against its component tests), ran the tests that should notice, then restored the file or object and checked it by checksum or catalogue fingerprint. The tables are in [§18.5](phases/phase-4-pro-accounts.md#185-security-findings-and-how-they-were-tested), [§19.6](phases/phase-4-pro-accounts.md#196-security-findings-and-how-they-were-tested) and [§20.6](phases/phase-4-pro-accounts.md#206-findings-while-building-and-how-they-were-handled) for 4A–4C, and in each 4D task's tests subsection (§21.7 … §31.7). Rows per task: 4A 8, 4B 14, 4C 15, P4-14 17, P4-15 20, P4-16 28, P4-17 39, P4-18 28, P4-19 32, P4-20 9, P4-21 10, P4-22 16, P4-23 10, P4-24 13. All were caught except one equivalent change (P4-14's MM-6, replaced by MM-6b) and two that survive by design because a second check guards the same rule (P4-17's MU-7a, a redundant signal; P4-19's ML-1, caught as ML-1c when both checks go). Where a mutation first survived (MX-5, MR-5a, ML-3b) or was caught for the wrong reason (MT-5), a test was added or fixed and the mutation then failed. Mutation IDs repeat across tasks (MD-1, MP-1 …): read them per section.

**Test tooling added in Phase 4.** Mailpit, started by `pnpm stack:start`, receives Auth's emails; `mailCode` and `latestMail` in `tests/integration/support/accounts.ts`, and `mailCode`, `mailLink` and `signInThroughUi` in `tests/e2e/support/accounts.ts`, read them as a person reads an inbox. `tests/support/totp.ts` computes RFC 6238 codes from the key Auth gives at enrolment (integration and E2E). `tests/support/fake-billing.ts` is the fake provider (signed webhooks, a control API that moves subscriptions), driven by `tests/integration/support/billing.ts`. Area helpers: `tests/integration/support/{entitlements,multipart,rooms}.ts` and `tests/e2e/support/rooms.ts`.

**Earlier suites.** Every Phase 1–3 test still runs. Phase 4 changed earlier assertions only on purpose, each recorded as a deviation with its intent kept (D4-28; for example DV4-2, DV4-18, DV4-19, DV4-20, DV4-22, DV4-35, DV4-43).

**Latest full run:** P4-26's final run, 2026-10-18, the Phase 4 completion gate, after one database reset for P4-26's migration ([§33.5](phases/phase-4-pro-accounts.md#335-the-final-run)).

| Step | Result |
|---|---|
| Typecheck, lint, `next build` | Passed |
| Unit + component | 69 files, **647 of 647** |
| `db reset` | All 19 migrations; the regenerated types unchanged; the edge janitor `202` after restarting the edge runtime |
| pgTAP | 18 files, **1,078** passed |
| API integration | 33 files, **522 of 522** (520 s) |
| E2E (75 tests) | **72 passed in the full run; the 3 failures passed when rerun alone** (`--last-failed`, 3 of 3). All three were timing under load: the merge journey's 30-second limit (its trace shows the changed device route was never reached), an archive not in the feed within 5 s, and T-002's 2-second live post. This is the first complete E2E run since P4-23's, and it closes P4-24's pending rerun. |

**Known flaky tests and environment failures.** Each is recorded where it happened, and each passed on a rerun or alone; the E2E run the full C: drive stopped was completed in P4-26. Rerun before calling one a regression.
- **A test defect, not fixed:** `passwords.test.ts` (T4-P6) and Phase 2's `remote-hygiene.test.ts:94` make a "wrong" secret by replacing its last character with `A`, which gives the real secret about one run in 16 ([§30.7](phases/phase-4-pro-accounts.md#307-tests)).
- **Timing under load, not fixed:** P4-26's final run: `local-accounts.spec.ts:33` (the merge, then sign-out) at its 30 s limit, `local-remote-sharing.spec.ts:52` (an archive in the feed within 5 s) and T-002 (`local-sharing.spec.ts:11`, a live post within 2 s) ([§33.5](phases/phase-4-pro-accounts.md#335-the-final-run)); the shared E2E sign-in helper's 5-second wait for *Send code*, and T4-M1 counting 7 of 8 parts ([§26.6](phases/phase-4-pro-accounts.md#266-tests)); P4-17's room Realtime test missing `member.changed` within 3 s, and Phase 3's reconcile race on a database grown without a reset ([§27.6](phases/phase-4-pro-accounts.md#276-tests)); 4A's `account-ui.test.tsx` timing out at 5 s ([§28.7](phases/phase-4-pro-accounts.md#287-tests)); two 4C billing tests that need the host and database clocks to agree, and the janitor's legal-hold test ([§22.7](phases/phase-4-pro-accounts.md#227-tests)); Phase 3's burn confirmation on an emulated WebKit phone ([§19.7](phases/phase-4-pro-accounts.md#197-tests)).
- **Fixed in the test:** the multipart Cancel test's wait (5 s → 60 s, [§21.7](phases/phase-4-pro-accounts.md#217-tests)); P4-16's race test limit (120 s → 300 s, [§23.6](phases/phase-4-pro-accounts.md#236-tests)); P4-20's T4-H1 racing the expiry job ([§27.6](phases/phase-4-pro-accounts.md#276-tests)); the `account.changed` test now proves its channel is live first, and Phase 1's emulated-Pixel preview check waits for the image (DV4-43) ([§20.6](phases/phase-4-pro-accounts.md#206-findings-while-building-and-how-they-were-handled) #5, #8).
- **The environment, not the code:** other projects' test suites on the same machine ([§22.7](phases/phase-4-pro-accounts.md#227-tests)); a stalled run during a host clock correction, its full cause not established ([§21.7](phases/phase-4-pro-accounts.md#217-tests)); the local edge runtime stopped ([§20.6](phases/phase-4-pro-accounts.md#206-findings-while-building-and-how-they-were-handled) #7); Docker Desktop stopping ([§27.6](phases/phase-4-pro-accounts.md#276-tests)); the computer sleeping ([§28.7](phases/phase-4-pro-accounts.md#287-tests)); the full C: drive ([§31.7](phases/phase-4-pro-accounts.md#317-tests)).

---

## 5. IDOR matrix as code

- `tests/integration/authz-matrix.ts` declares, for **every** API route and method, the expected status for each actor fixture:
  - device on the **same** network (not the creator)
  - device on **another** network
  - device that **left** the network (was on it, now elsewhere)
  - device on a network that is `too_large`, `shared_egress` or `blocked`
  - share creator on the same network, and on another network
  - link viewer of **this** share
  - link viewer of **another** share
  - (Phase 4) private-room member, owner, removed member, non-member
  - (Phase 5) member and admin of another workspace
- A test enumerates `app/api/v1/**/route.ts` and **fails if a route or method has no matrix entry**. New endpoints cannot ship without authorization tests.
- **As built (Phase 2, 2026-10-15):** `tests/integration/authz-matrix.test.ts` covers all 24 handlers with nine actors: anonymous, same network, other network, left the network, blocked network (standing for every non-`ok` status), viewer of this share's link, viewer of another share's link, creator on the share's network, creator's second device elsewhere. Viewer actors send only the link-session cookie.
- **As built (Phase 4, 2026-10-18):** the same file covers 66 handlers (every method of the 57 `route.ts` files) with 15 actors.
  - **Changed:** the creator is now an account, and the creator's second device is a real second sign-in of it. Phase 1–3 reused the creator's token, which the device-session binding now refuses ([phase 4 DV4-2](phases/phase-4-pro-accounts.md#184-deviations-from-the-plan)).
  - **New actors:** `proOther` (4B: a Pro account on another network; a plan raises limits, never access, so it gets exactly what a Free stranger gets); `roomOwner` (a Pro account), `roomMember` (an anonymous browser that joined by an invite link) and `removedMember` (P4-17); `roomLinkViewer` and `otherRoomLinkViewer` (P4-19: grants for a read-only link to this room or to another room, no Supabase session).
  - **Non-members** are every other actor: a room is someone else's, so `404`, as for a room that doesn't exist.
  - **Extra passes:** the invites row runs again with a pairing body (P4-18); the deletion rows run with the creator's deletion scheduled (P4-22).
  - Two actors of the plan ([phase 4 §17.19.8](phases/phase-4-pro-accounts.md#17198-idor-matrix-and-regression)) are not separate: the non-member accounts are the network actors and `proOther`; a deletion-pending account is only the deletion rows' setup, and `account-deletion.test.ts` covers its read-only grace. Workspace actors stay Phase 5.
- The matrix mirrors [03 §9](03-security-and-network-design.md#9-authorization-matrix). Changing one requires changing the other.

---

## 6. Performance and load targets (proposal)

| Metric | Target | Environment |
|---|---|---|
| p95 latency: observe, local feed, download URL | < 300 ms at 50 requests/s | Staging sized like production |
| p95 latency: upload init + complete (excluding transfer) | < 500 ms | Staging |
| Realtime signal delivery after commit | p95 < 1 s | Staging |
| Presence upserts (observe every 5 min) and feed reads at 10,000 active devices | Database CPU < 50%, no sequential scans on hot paths | Staging with synthetic data |
| Janitor throughput | ≥ 10,000 deletions/hour without errors | Staging |

---

## 7. CI gating

| Gate | Required checks |
|---|---|
| Pull request merge | Typecheck, lint, unit, component, pgTAP, API integration (incl. IDOR matrix), concurrency (fast), build, e2e smoke, dependency audit (no high/critical) |
| Staging deploy | All of the above on `main`, staging migrations applied, staging smoke tests |
| Production release | Staging smoke green, nightly e2e and R2 contract green in the last 24 h, owner approval |
| Release gates (public beta, paid, team) | Checklists in [05 §4](05-implementation-roadmap.md#4-release-gates) plus load tests and a security scan |

Coverage is a signal, not a goal. **Requirement:** 100% of authorization matrix entries and 100% of the enforcement rows in [07 §3](07-plans-and-entitlements.md#3-enforcement-points) have tests.

**As built (2026-10-18):** `.github/workflows/ci.yml` runs on pull requests and on pushes to `main`: a checks job (typecheck, lint, unit and component tests with coverage, `pnpm audit --audit-level high`) and a stack job (pgTAP, generated-type drift, build, integration, E2E in Chromium and WebKit). It was last changed in Phase 1. There are no nightly, staging or release workflows yet (no staging; SP-01, DEC-022). **CI has not run Phase 4:** the Phase 4 work is uncommitted and nothing has been pushed, so every Phase 4 result in §4.14 comes from local runs, and Phase 4's "Automated" level ("green locally and in CI", [phase 4 §17.20](phases/phase-4-pro-accounts.md#1720-acceptance-gates)) is met locally only. Whether the workflow passes Phase 4's suites unchanged is unknown until it runs. P4-26's audit found what to settle first ([phase 4 §33.3](phases/phase-4-pro-accounts.md#333-the-audit-findings), finding 5):
- when `playwright.config.ts` can't read the stack's status, it drops every `local-*` project, Phase 4's specs among them, with only a warning, so the E2E step would pass without them;
- nothing checks the edge runtime, which has exited at `db reset` locally;
- the step labels are Phase 1's;
- the job's 30-minute limit hasn't been measured against Phase 4's suites.

---

## 8. Manual device and network matrix (Phases 1–3 verification)

Phase 1's executable procedure, with steps, expected results and the recording sheet, is [phases/phase-1-manual-verification.md](phases/phase-1-manual-verification.md); Phase 2's (scenarios 6 and 7: QR scans and codes on phones, plus the takedown rehearsal) is [phases/phase-2-manual-verification.md](phases/phase-2-manual-verification.md); Phase 3's is [phases/phase-3-manual-verification.md](phases/phase-3-manual-verification.md). **Phase 4's is [phases/phase-4-manual-verification.md](phases/phase-4-manual-verification.md)** (P4-26): hosted Supabase and sign-in, email, MFA, entitlements, the billing sandbox and one real transaction, R2, real devices, the deletion rehearsal and operations, each with an evidence slot. **None of its steps has been run** (no staging, no provider, no real-device session). Real-device tests need staging behind Cloudflare: a phone on the developer's Wi-Fi presents a private address and local sharing is `unavailable`.

| Devices / browsers | Networks |
|---|---|
| iPhone (Safari), Android (Chrome), Windows (Chrome, Edge), macOS (Safari, Chrome), desktop Firefox | Home Wi-Fi dual-stack, home Wi-Fi IPv4-only, mobile data (CGNAT), phone hotspot, iCloud Private Relay on, commercial VPN, guest network, public/café Wi-Fi where available |

Scenarios to record (pass/fail, notes, screenshots):

1. Automatic local visibility on each network pair: which devices see each other's posts, and which don't (expected false negatives documented, with the network status shown).
2. Leaving and rejoining: a phone moves from Wi-Fi to mobile data and back. Local content disappears and reappears, and the audience line and status messages are correct.
3. 100 MB upload on mobile data, with the app backgrounded and resumed (single PUT retry behaviour).
4. Download on iOS (Files app handling of `attachment`) and Android.
5. Text sync latency between devices, and reconnect after sleep.
6. Share-link QR scanning on another network (Phase 2). Private-room QR pairing (Phase 4).
7. Short-code entry on mobile keyboards (Phase 2).
8. Burn-after-download flow, including the "someone else already downloaded" message (Phase 3).

---

## 9. Verification protocol (how a phase becomes VERIFIED)

1. **Acceptance evidence:** each criterion in the phase document links to evidence (CI run and commit SHA, test IDs, manual matrix results, spike reports, screenshots).
2. **Security checklist:** authorization matrix updated, threat notes for new endpoints, redaction reviewed, data inventory updated.
3. **Documentation:** phase status, decisions, risks, roadmap and changelogs updated.
4. **Owner sign-off:** recorded in the phase document's verification record with date and name.
5. Status changes from `COMPLETED` to `VERIFIED`. If anything fails, the phase goes back to `IN PROGRESS`, or `BLOCKED` with the reason recorded.

**Phase 4 (2026-10-18):** every task is IMPLEMENTED / NEEDS REVIEW; none is VERIFIED. Its evidence so far is the local test records (§4.14), with no CI run or commit SHA (the work is uncommitted), no manual results and no owner sign-off. P4-26 ran every suite once on a reset database, wrote the manual procedure with evidence slots, and fixed the device routes ([phase 4 §33](phases/phase-4-pro-accounts.md#33-phase-4-final-task-p4-26-final-verification-2026-10-18)). P4-13 (the provider's adapter) waits for Q-005.
