# 09 — Testing Strategy

| Field | Value |
|---|---|
| Document status | PROPOSED |
| Last updated | 2026-09-23 (CR-001; Phase 0 test harness implemented) |
| Applies to | All phases. Each phase document lists which tests from this catalogue it must deliver. |

---

## 1. Principles

1. **Test-first** for services, SQL functions and every security-critical rule (authorization, claims, quotas, tokens).
2. **Every authorization rule has positive and negative tests.** Access-denied tests matter more than happy paths.
3. **Real Postgres for authorization and concurrency.** No database mocks for policy logic. Use the local Supabase stack.
4. **Storage:** unit tests mock the S3 client. Integration tests use MinIO. **Nightly contract tests against a real R2 staging bucket** cover R2-specific behaviour.
5. **Multi-device end-to-end tests:** Playwright browser contexts act as separate devices on simulated networks.
6. **Evidence-based verification:** a phase is `VERIFIED` only with recorded evidence for every acceptance criterion (§9).

---

## 2. Test layers and tools

| Layer | Tool | Scope | When |
|---|---|---|---|
| Unit | Vitest | IP normalization, network key derivation, the visibility rule, HMAC and timing-safe helpers, ID/secret/code generation and normalization, filename sanitization, `Content-Disposition` encoding, entitlement resolution, expiry validation, zod schemas, error mapping | Every PR |
| Component | Vitest + Testing Library (jsdom) | Uploader state machine, text conflict handling, network status states and audience line, burn confirmation UI | Every PR |
| Database | pgTAP (`supabase test db`) | Constraints, grants (client roles denied on `app`), `realtime.messages` policies, `can_access_topic` (`net`, `user`, later `room`), SQL functions (`reserve_storage`, `end_share`, `claim_burn_share`, `rate_limit_hit`, `observe_network`, `refresh_network_status`), triggers | Every PR |
| API integration | Vitest + local Supabase + MinIO | Route handlers with a real DB: authentication, IDOR matrix, CSRF/Origin, rate limits, upload init → PUT → complete, download issuance, link unlock, codes | Every PR |
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

---

## 8. Manual device and network matrix (Phases 1–3 verification)

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
