# Phase 3 — Expiry, Cleanup and One-Time Download

| Field | Value |
|---|---|
| **Status** | **PLANNED** (detailed scope). Not started. |
| Plan depth | Scope-level plan. A task-by-task plan is written after Phase 2 is VERIFIED. |
| Depends on | Phase 2 VERIFIED. Q-008 answered. Edge Function limits confirmed. |
| Unblocks | Phase 4, and the **public beta gate** ([05 §4.1](../05-implementation-roadmap.md#41-public-beta-gate-checklist)) |
| Last updated | 2026-09-23 |

---

## 1. Goal

Make the storage lifecycle **reliable, prompt and auditable**:

- objects deleted within minutes of a share ending,
- no orphans,
- quota always correct,
- anonymous identities cleaned up.

Also deliver **optional burn-after-download** with exactly-once claim semantics ([03 §5](../03-security-and-network-design.md#5-one-time-download-burn-after-download--dec-015)).

## 2. Scope

### In scope

| Area | Contents |
|---|---|
| Storage janitor | Supabase Edge Function `storage-janitor`, triggered by pg_cron + pg_net with a Vault secret. Processes `object_deletions` in batches (`SKIP LOCKED`), aborts stale multipart uploads, backs off on failure. Guard rails: key regex, active-share check, dry-run flag, volume alerts. A `reconcile` mode finds orphans and missing objects. |
| Jobs | `trigger-storage-janitor`, `finalize-burn-claims`, `purge-tombstones`, `cleanup-anonymous-users`, `reconcile-storage-usage`, `reconcile-r2-orphans` (weekly), `refresh-egress-ranges` (scheduled), `cron-heartbeat` |
| Deletion path | User and owner deletes and rejected uploads go **only** through the outbox (the Phase 1 synchronous best-effort call is removed) |
| Tombstones and retention | `metadata_purge_after` and `retention_until` enforced. Free tombstones purged 30 days after the share ends. Downloads and audit retention by snapshot. |
| Burn after download | Schema (claim columns and checks), `app.claim_burn_share()`, grace window formula, ≤ 3 issuances per file, creator exemption, text "Reveal", no previews, `confirm-received`, finalize job, realtime `share.changed` on claim, UI (toggle in composer and uploader, share-page confirmation, "already downloaded" state). On a local share the **first device on the network** to open it claims it; the composer says so (*"The first person on this network to open it gets it"*). |
| Plan gating | `features.burnAfterDownload` from entitlements. Production default per Q-008 (Pro-only at paid launch). |
| Health and runbooks | `GET /api/v1/health/cron`. Runbooks for janitor backlog, cron failure, incident response, secret rotation, database restore drill. |
| Public beta gate | Complete the Phase 3-owned items of the gate checklist |

### Out of scope

Accounts and Pro (Phase 4). Completion-tracked downloads through a Worker gateway (Phase 6+ option). Malware scanning (Phase 6).

## 3. Existing system state (expected at start)

- Phases 1–2: shares end through `end_share`, and the outbox is written.
- Objects are removed by a synchronous best-effort delete or by the R2 lifecycle backstop.
- No janitor, burn, tombstone purge or anonymous-user cleanup yet.

## 4. What will be changed

The janitor function and jobs are added. The download services (device on the network and link viewer) gain the claim path. `end_share` handles `consumed`. The UI gains burn controls. Runbooks are written.

## 5. What will NOT be changed

- Request-time expiry remains the authority. Jobs only reclaim storage.
- The R2 lifecycle backstop rules remain.
- No change to the local visibility rule (DEC-031, DEC-032) or link authorization rules.

## 6. Architecture decisions involved

DEC-015, DEC-016, DEC-017, DEC-019 (reconciliation), DEC-018 (burn gating).

## 7. Files / modules involved

- `supabase/functions/storage-janitor/index.ts` (+ `deno.json`)
- `supabase/migrations/<ts>_phase3_*.sql` (claim function, jobs, retention)
- `lib/server/shares/{burn.ts, download.ts, end.ts, create.ts}`
- `app/api/v1/shares/[shareId]/confirm-received/route.ts`, `app/api/v1/health/cron/route.ts`
- UI in `components/{upload, room, share}/**`
- `project-docs-workthrough/runbooks/{janitor.md, cron.md, incident.md, secret-rotation.md, restore-drill.md}`

## 8. Database changes

- Burn columns and constraints on `shares` (defined in [04 §7.1](../04-database-and-storage-design.md#71-appshares); added here if not created in Phase 1).
- Functions `claim_burn_share`, `finalize_claims`, `purge_tombstones`.
- Anonymous-user cleanup and storage reconciliation functions.
- The janitor database role (least privilege: `object_deletions`, `files` read, `shares` read).
- pg_cron schedules and Vault secret.

## 9. API changes

- `POST /api/v1/shares/{shareId}/confirm-received`
- `GET /api/v1/health/cron`
- Download-URL endpoints return `410 ALREADY_DOWNLOADED` for claimed shares when the caller is not the claimant.
- Share creation accepts `burnAfterDownload` (entitlement-gated).

## 10. Security considerations

- Exactly-once claims through a single conditional `UPDATE` (no read-then-write).
- Claims are POST-only with an Origin check. Share pages confirm before claiming. Link unfurlers cannot claim.
- The grace window is bounded (≤ 6 h) and tied to one device or link session. The claimant must still pass the visibility rule on each retry (for a local share: still on the network, or holding a link grant).
- Janitor safety: it deletes only database-generated outbox keys, checks the key format, never deletes when the share is active or claimed, and runs dry-run first in staging.
- `cleanup-anonymous-users` never deletes users with active shares. Its cascades are covered by tests.
- Runbooks exist before public beta (incident, rotation, restore).

## 11. Dependencies

- **Phase:** Phase 2 VERIFIED.
- **Packages:** Deno `npm:` imports in the Edge Function (`aws4fetch` or `@aws-sdk/client-s3`, `postgres`).
- **Verification:** Supabase Edge Function execution and time limits for batch sizing.

## 12. Testing requirements

- T-037 … T-045, and the burn part of T-028.
- Failure-mode tests: janitor disabled → access still denied, backlog alert fires. R2 errors → retries and backoff.
- Timing measurement on staging: seconds from `expires_at` to object deletion (p95).
- Restore drill of the staging database from backup.
- Manual: burn flow on desktop and mobile (09 §8 scenario 8).

## 13. Acceptance criteria

| ID | Criterion | Evidence |
|---|---|---|
| AC-3.1 | **50 concurrent claims → exactly one winner** (T-037). Claimant retry and grace rules (T-038). Creator exemption (T-039). Text reveal (T-040). | CI |
| AC-3.2 | Expired and consumed objects deleted within **5 minutes at p95** on staging. No outbox row older than 1 h under normal operation. | Staging metrics |
| AC-3.3 | Janitor guard rails verified (T-043). Orphan reconciliation safe (T-044). | CI |
| AC-3.4 | Anonymous-user cleanup (T-045). Tombstone purge honours retention. | CI |
| AC-3.5 | Storage reconciliation runs daily with zero unexplained drift over a 7-day staging soak | Job logs |
| AC-3.6 | Access stays denied while the janitor or cron is stopped. Alerts fire (heartbeat, backlog). | Chaos test notes |
| AC-3.7 | Runbooks written. Restore drill completed with the measured restore time recorded. | Runbooks + drill notes |
| AC-3.8 | Burn UI copy reviewed. Unfurler and scanner GETs never claim. | E2E |
| AC-3.9 | Phase 3-owned public-beta checklist items done (monitoring, alerts, kill switches tested, incident runbook, backups verified) | Checklist |
| AC-3.10 | Docs updated (decisions, risks, data inventory, roadmap) | Doc diff |

## 14. Known risks

RISK-008, RISK-011, RISK-012, RISK-018, RISK-006 (anonymous-user cleanup reduces MAU carry-over).

## 15. Open questions

Q-008 (burn for Free?), Q-013 (Cloudflare plan before public beta), Q-022 (operator ownership for public beta).

## 16. Implementation status

| Date | Status | Note |
|---|---|---|
| 2026-09-17 | PLANNED | Scope plan drafted |
| 2026-09-23 | PLANNED | CR-001: burn wording for local shares (first device on the network claims) |

### Verification record

*Empty until verified.*
