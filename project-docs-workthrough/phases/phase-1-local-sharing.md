# Phase 1 — Anonymous Local Sharing (same network, automatic)

| Field | Value |
|---|---|
| **Status** | **PLANNED** (detailed scope). Not started. |
| Plan depth | Scope-level plan. A task-by-task plan is written after Phase 0 is VERIFIED and this plan is approved. |
| Depends on | Phase 0 VERIFIED (including the SP-04 report). Q-007 (Free quotas), Q-019, Q-021, Q-023, Q-029, Q-030 answered. |
| Unblocks | Phase 2 |
| Release | **Internal alpha only** (staging behind Cloudflare Access) |
| Last updated | 2026-09-23 (rewritten for CR-001: automatic same-network visibility) |

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
| Device bootstrap | Turnstile + Supabase anonymous sign-in, `@supabase/ssr` session cookies with `proxy.ts` refresh, `devices` registration with generated labels and coarse platform, device rename |
| Network | `POST /network/observe`: trusted IP, normalization, HMAC network key, network space upsert, classification (Private Relay and Tor lists loaded manually in this phase; ASN list only if SP-04 confirms ASN forwarding), presence (10 min), heartbeat every 5 min and on `focus`/`online`/connection change. **Dual-stack probe only if SP-04 adopts it.** |
| Guards | Statuses `ok` / `shared_egress` / `too_large` / `blocked` / `unavailable`. Fail closed for viewing and posting. Sticky ≥ 7 days. Status messages. Kill switch `local_sharing_enabled`. |
| Local feed | `GET /local/shares` for the caller's current eligible network. "My uploads" (`GET /me/shares`) from any network. |
| Realtime | Private `net:{spaceId}` and `user:{id}` channels, `realtime.messages` policies (presence-based for `net:`), database triggers with ID-only payloads, Presence for "N devices here now", re-observe and re-subscribe on network change, hidden-tab disconnect |
| Text shares | Create, versioned edit by the creator (409 on conflict, Q-021), delete by the creator. Free cap 100 KB (Q-007). Everyone present can copy. |
| File shares | Upload init (single presigned PUT ≤ 100 MB, signed headers), completion verification (HEAD + sniff), raster image previews, downloads for devices on the network (60 s URLs), delete by the creator |
| Expiry | Options per Q-030 (proposed 1 h / 24 h / 7 days, default 24 h for local shares). Request-time enforcement. `app.end_share()`. Jobs: `expire-shares`, `fail-stale-uploads`, `refresh-network-status`, `purge-ephemeral`, `release-stale-reservations`, `purge-idle-spaces`. R2 lifecycle backstop. `object_deletions` outbox populated, with a best-effort synchronous delete for creator deletes and rejected uploads. |
| Quotas and limits | Storage ledger (Free 2 GB active per user, proposed), daily upload volume per user and per network key, rate limits from [03 §10](../03-security-and-network-design.md#10-rate-limiting-and-abuse-protection), kill switches |
| Security | Origin/CSRF checks, zod validation, filename sanitization, attachment-only downloads, raster-only previews, executable warning and download confirmation on local shares, audit events, download log, log redaction |
| UI | "This network" home: network status, local feed, composer and uploader with progress, **audience line** (*"Visible to everyone on this network · N devices here now"*), one-time notice, expiry badges, "My uploads", empty and error states, status copy for non-`ok` networks |

### Out of scope (later phases)

Remote share links, QR, short codes and "Link only" posting (Phase 2). Burn after download and the janitor Edge Function (Phase 3). Accounts, Pro features, private rooms and invites, multipart (Phase 4). Workspaces (Phase 5). Malware scanning and (if not adopted in Phase 1) ASN classification (Phase 6).

**Known limitation of this phase:** there is no fallback yet when local mode misses a device (R5) or is off on a network. Links, QR codes and share codes arrive in Phase 2.

## 3. Existing system state (expected at start)

The Phase 0 foundation: tooling, CI, `proxy.ts` with headers and origin lock, trusted client-IP helper, baseline schema, infrastructure, spike reports (SP-04 decides the dual-stack probe, ASN forwarding and the large-network cap), accepted decisions.

## 4. What will be changed

New application code in `app/`, `components/`, `lib/client`, `lib/shared`, `lib/server`. Phase 1 migrations and pgTAP tests. Integration and e2e tests. `proxy.ts` gains Supabase session refresh.

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

See [05 §6 — Phase 1](../05-implementation-roadmap.md#phase-1). Key modules:

- `lib/server/network/{key.ts, classify.ts, presence.ts, probe.ts}` (`probe.ts` only if the dual-stack probe is adopted)
- `lib/server/local/{feed.ts, visibility.ts}`
- `lib/server/shares/{create.ts, complete.ts, text.ts, download.ts, end.ts}`
- `lib/server/storage/{r2.ts, keys.ts, presign.ts, verify.ts, sniff.ts}`
- `lib/server/{policy, quota, ratelimit, entitlements, audit}/*`
- `lib/client/{supabase.ts, realtime.ts, uploader.ts, api-client.ts, device.ts, network.ts, turnstile.tsx}`
- `lib/client/providers.tsx`, `lib/client/queries/*` (TanStack Query), `lib/client/stores/*` (Zustand), per [02 §3.3](../02-system-architecture.md#33-frontend-state-management-dec-034)
- `app/page.tsx` ("This network" home), `app/(app)/uploads/page.tsx`, and all Phase 1 route handlers under `app/api/v1/`

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
- Network keys are server-derived only. No raw IPs anywhere (database, logs, error monitoring). No endpoint accepts a network identifier (T-010).
- Fail closed: non-`ok` networks hide existing local content and refuse posting.
- Creator-only edit, delete and (Phase 2) link creation.
- Upload validation: exact size match, magic-byte sniffing, risk flags, filename sanitization. Objects carry signed attachment headers.
- Realtime payloads are ID-only. Client broadcasts are denied. `net:` topics require fresh presence.
- CSRF: Origin allow-list, JSON-only. Every response `no-store`.
- Turnstile before anonymous sign-in. Supabase anonymous sign-in rate limit reviewed for CGNAT.
- Audit events for network status changes and the share lifecycle.

## 11. Dependencies

- **Phase:** Phase 0 VERIFIED.
- **Packages (to be approved at task-plan time):** `@supabase/supabase-js`, `@supabase/ssr`, `@tanstack/react-query` (+ devtools, dev only), `zustand`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `file-type`, `pino`, a Turnstile wrapper, a permissively licensed UA parser (or an internal one).
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

### Verification record

*Empty until verified.*
