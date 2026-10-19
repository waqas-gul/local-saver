# Phase 3 — Expiry, Cleanup and One-Time Download

| Field | Value |
|---|---|
| **Status** | **CODE COMPLETE / NEEDS REVIEW** (2026-10-16). Implemented and tested on the local stack; staging, real devices and production pending (§18). Not VERIFIED. |
| Plan depth | Scope plan (§1–§15) and a detailed task plan (§17, 2026-10-16), written on the owner's instruction before Phase 2 is VERIFIED |
| Depends on | Phase 2 VERIFIED. Q-008 answered. Edge Function limits confirmed. |
| Unblocks | Phase 4, and the **public beta gate** ([05 §4.1](../05-implementation-roadmap.md#41-public-beta-gate-checklist)) |
| Last updated | 2026-10-16 (§18 implementation) |

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
| 2026-10-16 | PLANNED | Detailed task plan written (§17), planning only, on the owner's instruction. Not started: no code, migrations or packages. Open: Q-008, Q-013, Q-022 and decisions D-1 … D-9 (§17.19). |
| 2026-10-16 | CODE COMPLETE / NEEDS REVIEW | Owner decisions Q-008 and D-1 … D-9 applied (§18.1); P3-00 run (§18.2); implemented and tested locally (§18.3–§18.11). Staging, real-device and production verification pending. Not committed. |

### Verification record

*Empty until verified.*

---

## 17. Detailed task plan (2026-10-16)

**Written as a plan, before implementation.** §18 records what was built on 2026-10-16 and where it differs (§18.7). It was written against the code on branch `phase-2-remote-sharing` at commit `3e03120` (Phase 2, committed and pushed by the owner) and [ARCHITECTURE.md](../ARCHITECTURE.md) as of 2026-10-16. Sections 1–16 above stay as the scope plan; where this section differs from them, it says so and why (§17.3).

### 17.1 Starting conditions and readiness

The owner asked on 2026-10-16 for this plan before Phase 2 is VERIFIED. The header above said the task plan would follow Phase 2 VERIFIED. The request: *"Create the detailed implementation plan for Phase 3 … This is a PLANNING-ONLY task … Work from the actual current codebase, not assumptions."*

| Dependency | State on 2026-10-16 | Effect on Phase 3 |
|---|---|---|
| Phase 2 VERIFIED | CODE COMPLETE / NEEDS REVIEW, committed on `phase-2-remote-sharing` (`3e03120`), not merged. Phase 1 is NEEDS REVIEW. | Under 05 §1, Phase 3 starts only after Phase 2 is VERIFIED, unless the owner instructs otherwise (as for Phases 1 and 2). In-repo work would build on that branch. |
| Q-008 (burn for Free?) | OPEN | Nobody can create a burn share: every caller resolves to Free, and Free has `burnAfterDownload: false` (§17.10) |
| Edge Function limits | Documented limits read (§17.5); not measured | Batch sizes, and whether the egress refresh fits in an Edge Function, need the measurement in P3-00 |
| Staging, R2 bucket, hosted Supabase, CI (Phase 0 owner items) | None exist | AC-3.2, AC-3.5, AC-3.7 and AC-3.9, and the "alerts fire" part of AC-3.6, can't be met. In-repo work and local tests can go ahead. |
| Alert channel and named on-call owner (Q-022, DEC-029) | None. Phase 2 decided not to deliver alerts. | AC-3.6 and the public beta gate need one (D-5) |
| Packages | The Deno `npm:` imports for the Edge Functions are not approved | P3-04, P3-05 and P3-09 need approval (§17.20) |

**Readiness:** the in-repo work can be planned and could start on the owner's instruction: migrations, services, Edge Functions on the local stack, UI and tests. Nothing that needs staging can be verified.

### 17.2 What exists today and what Phase 3 adds

| Area | Exists after Phases 1–2 (as built) | Phase 3 adds |
|---|---|---|
| Share states | `shares.status` already allows `claimed` and `consumed`. `burn_after_download boolean default false`. Checks `shares_claim_requires_burn` and `shares_open_status` (`claimed` counts as open). `end_share` already maps reason `consumed` to status `consumed`. Nothing sets any of these. | Claim columns, the claim function, the finalize job, the API and the UI |
| Visibility | `isShareVisible` (`lib/server/local/visibility.ts`) shows only `active` shares (and `pending_upload` to their creator). The local feed selects `status = 'active'`; My uploads `pending_upload, active`. For link viewers, `accessFor` (`lib/server/links/grants.ts`) answers `410 LINK_EXPIRED` for any status but `active`. | Rules for the claimant and the creator while a share is `claimed` |
| Share DTO | `SHARE_STATUSES = ["pending_upload", "active"]`; no burn fields; text content always included | `claimed`, burn fields, text hidden until Reveal |
| Download log | `downloads.event`: `url_issued`, `preview_issued`. `actor_kind`: `network_device`, `creator`, `link_viewer`. `link_id` (Phase 2). | Events `burn_claimed`, `burn_retry`, `text_revealed` |
| Deletion outbox | `object_deletions`: reasons `share_ended`, `upload_rejected`, `upload_timeout`; `attempts`, `locked_until`, `last_error`, `tombstoned_at`, `completed_at`; no `bucket` or `multipart_upload_id`. `app.claim_object_deletions(share, limit)` claims rows for 2 minutes and returns `hold_until` (tombstone rule). | Janitor-only execution, guard rails, backoff, an optional legal hold (D-2), an `orphan` reason, a purge of completed rows |
| Storage executor | Node, in the web tier (`lib/server/shares/end.ts`): runs after a creator delete and an upload rejection, then sweeps 10 due rows with `after()`. A failure adds 1 to `attempts`, but `not_before` stays, so there is no backoff and no alert. | Moved to the `storage-janitor` Edge Function; the web-tier executor is removed (C-1) |
| Jobs (pg_cron) | `expire-shares`, `fail-stale-uploads`, `refresh-network-status`, `purge-ephemeral`, `release-stale-reservations`, `purge-idle-spaces` | The eight Phase 3 jobs (§17.6) |
| Quota ledger | `storage_usage` and `storage_reservations`; `end_share` releases committed bytes | Daily reconciliation |
| Retention | `end_share` sets `metadata_purge_after` (`historyRetentionDays`, 30 on Free). `downloads.retention_until` comes from the snapshot (30 days). `audit_events.retention_until` defaults to 90 days. Nothing purges any of them. | Purge jobs (§17.7) |
| Users | Anonymous Supabase users. `devices.last_seen_at` is updated by observe and by device registration. Nothing deletes users. | Inactive-user cleanup |
| Egress lists | Manual loader `scripts/load-egress-ranges.cjs`; deployments fail closed after 14 days | Scheduled refresh |
| Infrastructure | `pg_cron` and `pg_net` are created in the baseline; Vault is not used. `supabase/config.toml` enables the edge runtime, but `pnpm stack:start` excludes it (`-x … edge-runtime`). The R2 lifecycle file is written but not applied. RustFS runs locally without lifecycle rules. | Edge Functions, Vault secrets, a janitor role |
| Entitlements | Free only, typed in code (`lib/server/entitlements/plans.ts`); `resolveEntitlements` returns Free for everyone. No `entitlement_overrides` table, no Pro. | The burn gate (§17.10) |
| Health | `GET /api/v1/health` (liveness and readiness) | `GET /api/v1/health/cron` |
| Multipart | None. Single PUT ≤ 100 MB (DEC-026); `files.upload_mode` allows only `single`. | A report-only multipart check (C-5) |
| Database pool | The app uses 5 connections (`lib/server/db/client.ts`) | Matters for concurrency tests (§17.8.3) |

### 17.3 Conflicts between the plan and the code

None of these is resolved silently. Each lists the smallest approach that fits the current architecture; the ones that need the owner are listed in §17.19.

| # | Conflict | Impact | Smallest compatible approach |
|---|---|---|---|
| C-1 | §2 says the Phase 1 synchronous delete is removed. Today a creator delete (and an upload rejection) tombstones or deletes the objects in the same request, and the Phase 1 tests check exactly that (`tests/integration/uploads.test.ts`, "deleting a file share" and "upload URLs after a share ends"). | After a creator delete, bytes would stay in storage until the janitor's next run (about 1–2 minutes). Access still ends at once. | Keep one executor, as scoped: the janitor. Remove the web-tier executor only after the janitor runs in the same environment (P3-06 after P3-05). Change those tests to run the janitor between the delete and the check, and keep every assertion: content gone, key held, the upload URL refused. Owner confirms (D-1). |
| C-2 | The tombstone rule is implemented in Node (`end.ts`), but the janitor runs in Deno | Two implementations of the rule that can drift apart | One runtime-agnostic core (`supabase/functions/_shared/janitor-core.ts`), with storage and database passed in. The SQL claim function stays the only place that decides hold or delete. Vitest runs the core in Node with the existing AWS SDK adapter; the Edge Function wraps it with a fetch-based adapter. |
| C-3 | `pnpm stack:start` excludes the edge runtime. pg_net in the database container must reach the functions, and the functions must reach RustFS on the host. | No local janitor without stack changes | Stop excluding `edge-runtime`. `scripts/local-stack.cjs` writes local-only Vault secrets. Reach RustFS at `host.docker.internal:9000`, to be verified on Docker Desktop for Windows and on CI's Linux runner (P3-00). |
| C-4 | 03 §12 plans `SUPABASE_SECRET_KEY` for the janitor; §8 above and 08 §5 plan a least-privilege role. Supabase also injects `SUPABASE_DB_URL` and the service-role key into every function by default. | Using the defaults gives the janitor full database access | A dedicated `app_janitor` role that may only call janitor functions. The function reads `JANITOR_DATABASE_URL` and refuses to start without it; it never reads the injected defaults (code review and a unit test). Correct 03 §12 when this is built. |
| C-5 | §2 has the janitor abort stale multipart uploads. Multipart arrives in Phase 4 (DEC-026); there is no `multipart_upload_id` column. | Nothing to abort through the outbox | Reconcile mode lists in-progress multipart uploads, reports them, and aborts any older than 24 hours (the same as the lifecycle rule). Outbox handling of multipart waits for Phase 4. |
| C-6 | §7 lists `components/{upload, room, share}`. The composer and uploader are `components/local/composer.tsx`, `upload-queue.tsx` and `lib/client/uploader.ts`; rooms are Phase 4. | The file list in §7 is wrong for this codebase | Plan against the real files (§17.22) |
| C-7 | 02 §6.2 has only `confirm-received` for Phase 3. Text Reveal needs an endpoint; link viewers have no device, so they need their own reveal and confirm routes; the UI must know whether burn is allowed. | Missing endpoints | Add `POST /shares/{id}/reveal`, `POST /links/{id}/reveal`, `POST /links/{id}/confirm-received` and `GET /me/entitlements`. Record them as deviations. |
| C-8 | 04 §7.1 names `claimed_link_session_id`, but link sessions are keyed by `id_hash bytea` (Phase 2) | Type mismatch | Name the column `claimed_link_session_hash bytea` |
| C-9 | 03 §5.4 doesn't say what happens when a share expires during its grace window. 04 §9.1 says nothing is served after `expires_at`. | An unclear rule | Grace ends at the earlier of the formula and `expires_at`. A clarification, not a change (D-6). |
| C-10 | Today a takedown leaves the bytes in storage until a sweep, and the takedown runbook says not to delete child-safety evidence by hand. A prompt janitor deletes a blocked share's objects within minutes. After 30 days the tombstone purge would also delete the share row, and `abuse_reports.share_id` is `ON DELETE SET NULL`. | Evidence the law may require could be lost (RISK-031) | A legal hold on a blocked share's outbox rows, and a purge that skips shares with abuse reports, both pending Q-022 (D-2, D-3) |
| C-11 | The beta gate and AC-3.6 need alerts. Error monitoring is planned as a Phase 6 package, and Phase 2 decided not to deliver alerts. | AC-3.6 and AC-3.9 can't be met | `/api/v1/health/cron` sums up job health and answers `503` when something is wrong, so any external uptime monitor can raise the alert without building a delivery system. The channel and its owner are Q-022 and DEC-029 (D-5). |
| C-12 | Edge Functions get 2 s of CPU per request, not counting async I/O (§17.5). The egress loader merges about 285,000 Apple ranges, CPU-bound. | `refresh-egress-ranges` may not fit in an Edge Function | Measure in P3-00. Fallback per DEC-017's alternatives: a scheduled GitHub Actions job running the existing script, or a Cloudflare Worker (D-4). |
| C-13 | 03 §12 says "Incident rotation runbook (Phase 6)"; 08 §11 and §2 above say Phase 3 | Two phases for one runbook | Write it in Phase 3, because the beta gate needs it. Correct 03 §12 later. |
| C-14 | `downloads.share_id` is `ON DELETE CASCADE`, so purging a share deletes its download records whatever their `retention_until` | Download history would go before its retention date if a share is purged first | On Free it doesn't happen: download rows are issued before the share ends, and both retentions are 30 days. Phase 4 (longer history) must revisit this. Record it; no change now. |

### 17.4 Deletion lifecycle

#### 17.4.1 Today (traced from the code)

1. **Creator delete.** `DELETE /shares/{id}` runs `deleteShare` (`lib/server/shares/end.ts`). In one transaction: `app.end_share(id, 'deleted_by_creator')` marks the share, files, text and links, releases quota, and inserts one outbox row per verified or pending file with `not_before = now()`; plus an audit event. After the commit, `executePendingDeletions` claims up to 100 of this share's rows (`app.claim_object_deletions`) and handles each one; then `after()` sweeps up to 10 due rows of any share.
2. **Upload rejection.** `rejectUpload` (`lib/server/shares/complete.ts`): in one transaction it rejects the file, releases its reservation, inserts an `upload_rejected` outbox row (from app code) and calls `end_share(…, 'upload_failed')`. Then it runs the same executor.
3. **Expiry.** The `expire-shares` job calls `end_share(…, 'expired')`. The outbox rows wait for the next sweep, which runs only when somebody deletes a share or an upload is rejected. The lifecycle backstop isn't applied anywhere.
4. **Stale uploads.** `fail-stale-uploads` writes `upload_timeout` rows and fails the share. Same wait.
5. **Takedown.** `admin_block_share` calls `end_share(…, 'blocked')` and returns the object keys and hold times. The runbook covers deleting them by hand.
6. **Each claimed row.** `claim_object_deletions` returns `hold_until` when an upload URL for the object may still be live (`files.upload_url_expires_at` + 5 minutes). The executor then writes an empty tombstone (once), sets `tombstoned_at` and `not_before = hold_until`, and releases the lock; a later sweep deletes the object. Otherwise the executor deletes the object, sets `completed_at` and stamps `files.object_deleted_at`.
7. **Failures.** `attempts + 1` and `last_error` are recorded and the lock is released. `not_before` stays, so the next sweep retries at once. There is no backoff and no alert.
8. **Missing pieces.** Nothing purges completed rows, finds orphans or detects missing objects.

#### 17.4.2 Phase 3

```text
Share ends (creator delete, expiry, upload failure, consumed, takedown)
    ↓  app.end_share(): status, text erased, quota released, links revoked, audit, signal
object_deletions row (same transaction; not_before = now(), or now() + 5 min for "consumed")
    ↓  pg_cron every minute: trigger-storage-janitor posts only if due rows exist
storage-janitor (Edge Function)
    ↓  app.janitor_claim_deletions(): due, not held, guard rails pass, locked for 2 min
R2: tombstone (an upload URL may be live) → row rescheduled to hold_until
    or DeleteObject → row completed, files.object_deleted_at set
    ↓  failure: attempts + 1, not_before = now() + backoff, alert at 5
purge-tombstones: completed rows deleted after 30 days
```

```text
R2 object exists, but the database says it shouldn't (or has no row for it)
    ↓  reconcile-r2-orphans (weekly, janitor "reconcile" mode)
List {class}/{yyyy}/{mm}/{dd}/ prefixes, page by page, with a saved cursor
    ↓  per key: format check → no live file row → older than 48 h → no open outbox row
app.janitor_enqueue_orphan(): an outbox row with reason "orphan" (rechecked in SQL)
    ↓
The normal janitor path deletes it, with every guard rail
```

| Question | Answer |
|---|---|
| What changes | Only the janitor executes the outbox. The web tier stops calling `DeleteObject` and the tombstone PUT (C-1). Failures back off. Rows of shares that aren't ended are refused. Reconciliation is added. Completed rows are purged. `consumed` gets a 5-minute margin. A legal hold is optional (D-2). |
| What stays | `end_share` is the only way to end a share. The outbox schema and its unique open-key index. The tombstone rule, still decided in SQL. Request-time checks as the security boundary. The R2 lifecycle rules as the backstop. Deleting a missing key counts as success. |
| Retries | Backoff after the 1st … 5th failure: 1 minute, 5 minutes, 30 minutes, 2 hours, 12 hours, then every 12 hours. `janitor.delete_failed` is logged on each failure; from `attempts ≥ 5`, `janitor.failing` is logged and `/health/cron` reports `janitorFailures: failing`. Rows never give up on their own; an operator can complete a row by hand (runbook). |
| Tombstones | Unchanged. The claim function returns `hold_until` from `files.upload_url_expires_at` + 5 minutes; the janitor writes an empty, write-once-blocking tombstone and reschedules the row. The purge job never deletes a share row while any of its outbox rows is open, so the hold information can't disappear (§17.7). |
| Active shares | Guard rails in SQL at claim time: the file's share must be ended (`ended_at is not null`), and not `claimed` (a claimed share is still open). A refused row isn't processed: it gets `last_error = 'guard:<reason>'` and `not_before = now() + 1 day`, and `janitor.guard_refused` is logged at error level. Every outbox row today comes from an ended share, because a rejection fails the whole share (DV1-10), so a refusal always means a bug. |
| Expired shares | Access is denied at `expires_at` (request time). Within about a minute `expire-shares` ends the share; within about another minute the trigger runs the janitor. Target: p95 under 5 minutes from `expires_at` to deletion (AC-3.2). |
| R2 failures | Backoff as above. The object stays in storage, but nobody can reach it. The lifecycle backstop removes it at the latest after the class period + 1 day (once applied on R2). |
| Orphans | Weekly reconciliation queues them; the janitor deletes them with the same guard rails. Keys that don't match the format are only reported, never deleted. |

### 17.5 Storage janitor

**Edge Function limits** (from [Supabase's limits page](https://supabase.com/docs/guides/functions/limits), read 2026-10-16; P3-00 measures them):

- 256 MB of memory;
- 2 s of CPU per request, not counting async I/O;
- wall clock 150 s on Free and 400 s on paid plans;
- a 150 s idle timeout before a response;
- a 20 MB bundle when deployed with the CLI.

| Aspect | Design |
|---|---|
| Name and location | `supabase/functions/storage-janitor/index.ts` and `deno.json`, with the core in `supabase/functions/_shared/janitor-core.ts` (C-2) |
| Trigger | pg_cron `trigger-storage-janitor` every minute: `app.trigger_storage_janitor('delete')` posts with `net.http_post` only if due rows exist. It reads the URL and the secret from Vault by name. The weekly reconcile run posts `{"mode":"reconcile"}`. |
| Authentication | `verify_jwt = false` for this function only (08 §5), because the function checks its own secret: `Authorization: Bearer <JANITOR_TRIGGER_SECRET>`, compared in constant time, with `JANITOR_TRIGGER_SECRET_PREVIOUS` also accepted during a rotation. Anything else gets `401` with no detail. The body must be exactly `{"mode":"delete"}` or `{"mode":"reconcile"}`. |
| Response | `202` straight away; the work runs in the background (`EdgeRuntime.waitUntil`, to confirm in P3-00), so pg_net's short timeout can't cut a run short |
| Database access | `postgres` (npm) as role `app_janitor`, through `JANITOR_DATABASE_URL` (Supavisor, transaction mode, prepared statements off). It may only execute the janitor functions (§17.11). |
| Storage access | Fetch-based SigV4 (`aws4fetch`, package approval D-8) with a separate janitor R2 token for the one bucket (`infra/cloudflare/README.md` §8) |
| Batching | Claim batches of N rows (default 100, sized in P3-00) with bounded concurrency (default 8). Claim the next batch until there are no due rows or the time budget runs out (default 100 s, below every wall-clock limit). The 2-minute `locked_until` is longer than any one batch's work, so another run never takes over rows mid-batch. Overlapping runs are safe: `SKIP LOCKED` plus the lock. |
| `SKIP LOCKED` | In `app.janitor_claim_deletions`, as in `claim_object_deletions` today |
| Outcomes | `app.janitor_finish_deletion(id, outcome, error)` with outcome one of: `deleted` (completed, file stamped); `tombstoned` (tombstoned, `not_before = hold_until`); `failed` (backoff); `dry_run` (lock released, nothing changed) |
| Dry run | `JANITOR_DRY_RUN=true`: claim, log `janitor.would_delete` or `would_tombstone` with row ID and key class only, release. No storage writes. Staging runs in dry-run first (§17.21). |
| Key validation | In SQL (the check constraint on `object_deletions.object_key`, and again in the claim function) and in the core, with the same pattern as `lib/server/storage/keys.ts` |
| Kill switch | Runtime flag `storage_janitor_enabled`. When it is off, the trigger doesn't post and the function exits at once. Used during incidents and legal holds. |
| Volume alerts | Each run records its counts in `app.job_heartbeats` ('storage-janitor'). `/health/cron` reports `janitorBacklog: failing` when more than 1,000 rows are due or the oldest has been due for over an hour (08 §8), and `janitorVolume: unusual` when a day's deletions exceed the configured threshold. |
| Reconcile mode | One prefix page at a time (ListObjectsV2, 1,000 keys per page), with the cursor saved in `app.storage_reconcile_runs`, so a weekly run spans several invocations and fits the CPU limit. Orphans are queued, never deleted directly. Missing objects (a verified file of an open share with no object) set `files.object_missing_at` and log `reconcile.missing_object` at error level. Multipart uploads are reported (C-5). |
| Logs | Structured JSON with IDs, counts and key classes only; never full keys of open shares, file names or presigned URLs |

### 17.6 Jobs

Each job body is a SQL function, run in batches with `FOR UPDATE SKIP LOCKED` where it changes rows. Each records its outcome in `app.job_heartbeats` (§17.11) through `app.record_job_run(job, ok, result)`. pg_cron runs every job as the migration role; no job function is granted to `app_server`. Supabase recommends at most 8 concurrent jobs, each under 10 minutes (04 §9.1).

#### `trigger-storage-janitor`

| | |
|---|---|
| Purpose | Start the janitor only when there is work |
| Schedule | `* * * * *` |
| Inputs | Due rows: `completed_at is null and not_before <= now() and (locked_until is null or locked_until <= now())` and not held. Vault secrets `storage_janitor_url` and `storage_janitor_secret`. Flag `storage_janitor_enabled`. |
| Database | Reads only. `net.http_post` queues the request. |
| Storage | None |
| Failure | A missing Vault secret: no post, and `job_heartbeats` gets `failed` with reason `missing_secret`. pg_net is asynchronous, so a failed POST only shows in `net._http_response`. The janitor's own heartbeat is therefore the signal that it ran. |
| Retry | The next minute |
| Idempotency | Several posts at once are safe (`SKIP LOCKED`) |
| Monitoring | `storage-janitor` heartbeat older than 5 minutes while rows are due → `/health/cron` 503 |
| Security | The function is owned by the migration role (Vault and pg_net), not granted to `app_server` or `app_janitor`. The secret never appears in logs, `cron.job` or migrations. |
| Tests | pgTAP: no post without due rows; one post with them; nothing when the flag is off; no grants. Integration: the local stack posts to the local function. |

#### `finalize-burn-claims`

| | |
|---|---|
| Purpose | End claimed shares when their grace window is over |
| Schedule | `* * * * *` → `app.finalize_claims(500)` |
| Inputs | `status = 'claimed' and claim_grace_until <= now()` |
| Database | Each share locked (`SKIP LOCKED`), then `end_share(id, 'consumed')`, whose outbox rows get `not_before = now() + 5 minutes` (§17.8.6) |
| Storage | None directly; the janitor deletes after the margin |
| Failure | The transaction rolls back and the share stays `claimed`. Access is still limited by the request-time check `now() < claim_grace_until`. |
| Retry | The next minute |
| Idempotency | `end_share` does nothing for an ended share; a finished share no longer matches |
| Monitoring | Heartbeat. `/health/cron` reports `burnFinalize: late` if any claimed share is more than 10 minutes past grace. |
| Security | Not granted to `app_server` |
| Tests | pgTAP: past grace → consumed, deletions due after the margin, signal sent; inside grace → untouched; idempotent. T-038 (finalize part). |

#### `purge-tombstones`

| | |
|---|---|
| Purpose | Delete ended shares and expired records after their retention dates |
| Schedule | `0 3 * * *` → `app.purge_tombstones(1000)` |
| Inputs | Ended shares with `metadata_purge_after <= now()`; `downloads` and `audit_events` with `retention_until <= now()`; `object_deletions` completed more than 30 days ago |
| Database | Delete shares in batches (`SKIP LOCKED`). Cascades: `files`, `text_items`, `downloads`, `share_links` (then `link_grants`); `abuse_reports.share_id` and `link_id` are set to null. Skip shares with an open outbox row, and (pending Q-022, D-3) shares with any abuse report. |
| Storage | None. Objects are already deleted or queued. |
| Failure | The batch rolls back; the next day retries |
| Retry | Daily, with a batch limit and a loop up to a time budget |
| Idempotency | Deleting what is due is naturally idempotent |
| Monitoring | Heartbeat with counts; a sudden count jump shows in the heartbeat result |
| Security | Not granted to `app_server`. Never touches open shares (pgTAP proves it). |
| Tests | pgTAP: due → gone with cascades; not due, open, outbox open or reported → kept; downloads, audit and completed outbox rows purged on their own dates |

#### `cleanup-anonymous-users`

| | |
|---|---|
| Purpose | Delete inactive anonymous Supabase users (RISK-006, and fewer stored Auth session IPs, RISK-029) |
| Schedule | `30 3 * * *` → `app.cleanup_anonymous_users(1000)` |
| Inputs | `auth.users` where `is_anonymous`, created more than 30 days ago, and inactive for 30 days: no device with `last_seen_at` in the last 30 days and `last_sign_in_at` older than 30 days. Also: no share with status `pending_upload`, `active` or `claimed` created by them; no `claimed` share with them as claimant; no active storage reservation. |
| Database | `delete from auth.users` in batches. Cascades: `devices` (and so `network_presence`), `user_flags`, `idempotency_keys`. Set to null: `shares.created_by_*`, `share_links.created_by_*`. Explicit deletes: `storage_usage` rows with nothing committed or reserved. Kept as plain IDs until their retention ends: `downloads.user_id`, `audit_events.actor_user_id`, `abuse_reports.reporter_user_id`. |
| Storage | None |
| Failure | The batch rolls back; the next day retries |
| Retry | Daily |
| Idempotency | Yes |
| Monitoring | Heartbeat with the count deleted. A sudden spike is an anomaly to alert on. |
| Security | `app_owner` can't touch the `auth` schema, so the function is owned by the migration role, run only by pg_cron, granted to nobody. Never deletes non-anonymous users (Phase 4 accounts). Suspended users: D-9. |
| Tests | T-045 (pgTAP): inactive and empty → deleted with cascades; active device, open share, claimant, reservation or not anonymous → kept |

#### `reconcile-storage-usage`

| | |
|---|---|
| Purpose | Catch quota drift (DEC-019, RISK-012) |
| Schedule | `0 4 * * *` → `app.reconcile_storage_usage(1000)` |
| Inputs | Each `storage_usage` row, plus subjects that have verified files but no row |
| Database | Per subject: (1) lock the `storage_usage` row (`FOR UPDATE`); (2) in a new statement, recount committed bytes and files (verified files of that billing subject) and reserved bytes (active reservations); (3) write any difference; (4) log drift above max(1 MB, 0.1%) and write an audit event. Locking first and recounting second is race-free: a completion that has verified its file but not yet committed its reservation must wait for this row lock, and the recount sees that file's bytes still as reserved, which is consistent. |
| Storage | None |
| Failure | Per-subject transactions; the next day retries |
| Retry | Daily |
| Idempotency | Recounting is idempotent |
| Monitoring | `storage_usage.drift` warn (error above 1 GB, 08 §8); the heartbeat holds counts. AC-3.5: zero unexplained drift over a 7-day soak. |
| Security | Not granted to `app_server` |
| Tests | pgTAP: corrupted counters corrected; correct ones unchanged. Integration: reconciliation running while 20 uploads complete never produces a false correction (race test). |

#### `reconcile-r2-orphans`

| | |
|---|---|
| Purpose | Find orphan objects and missing objects (04 §8.6) |
| Schedule | Weekly, `0 5 * * 0` → `app.trigger_storage_janitor('reconcile')`; the run continues on later invocations until its cursor is done |
| Inputs | Bucket listing; `files`, `object_deletions`, `storage_reconcile_runs` |
| Database | `app.janitor_enqueue_orphan(key, last_modified)` rechecks in SQL: the key format, no `files` row with this key that is `pending` or `verified`, no open outbox row, and `last_modified` more than 48 hours ago. Only then is an `orphan` row inserted. `app.janitor_mark_missing(file_id)` sets `files.object_missing_at`. |
| Storage | ListObjectsV2 by prefix; HEAD for verified files that weren't listed; ListMultipartUploads (C-5). No deletes in this mode. |
| Failure | The cursor stays and the next invocation continues; a run unfinished after 24 hours is logged |
| Retry | Next invocation |
| Idempotency | The unique open-key index stops duplicate orphan rows |
| Monitoring | `reconcile.orphans_queued` (count), `reconcile.missing_object` (error), `reconcile.unknown_key` (warn); heartbeat |
| Security | Never deletes directly. Unknown key formats are reported, never queued. The 48-hour minimum age protects uploads in progress and right after a restore. |
| Tests | T-044: a live file's object is kept; a young orphan is kept; an old orphan is queued and then deleted; an unknown key is reported; a verified file with no object is marked missing |

#### `refresh-egress-ranges`

| | |
|---|---|
| Purpose | Load the Apple Private Relay and Tor exit lists daily (DV1-19), replacing the weekly manual run |
| Schedule | Daily (for example `20 2 * * *`), through pg_net to a `refresh-egress-ranges` Edge Function, or the fallback runtime from P3-00 (D-4) |
| Inputs | The two public list URLs from `scripts/load-egress-ranges.cjs` |
| Database | `app.replace_egress_ranges(source, cidrs)` (definer, role `app_egress_loader`) replaces one source in one transaction and updates `runtime_flags('egress_ranges')`. It refuses an empty list (as the script does today). |
| Storage | None |
| Failure | The old lists stay. After 14 days, deployments turn local sharing off everywhere (the existing fail-closed rule). `egress.refresh_failed` is logged at error level. |
| Retry | The next day; an operator can run the manual script |
| Idempotency | Replacing a source is idempotent |
| Monitoring | Heartbeat; `/health/cron` reports `egressLists: stale` once the lists are 3 days old (well before the 14-day cut-off) |
| Security | Fetches only the two fixed URLs. Its own secret and database role. The merge logic is shared with the script (`supabase/functions/_shared/egress-merge.ts`), so both produce the same ranges. |
| Tests | Unit: the shared merge gives the same output as today's loader tests. Integration: replace one source; refuse an empty list; the flag is updated. |

#### `cron-heartbeat`

| | |
|---|---|
| Purpose | Show that pg_cron itself is running |
| Schedule | `*/5 * * * *` → `app.record_job_run('cron-heartbeat', true, '{}')`, which also sets `runtime_flags('cron_heartbeat').value = {"at": now()}` (the §2 design) |
| Inputs, storage | None |
| Failure | None to handle: a missing heartbeat **is** the signal |
| Monitoring | `/health/cron` answers `503` when the heartbeat is more than 10 minutes old (08 §8); an external uptime monitor alerts (C-11) |
| Security | Not granted to `app_server`. `/health/cron` reads it. |
| Tests | Integration: an old heartbeat → `503`; a fresh one → `200`. Chaos (staging): pause pg_cron → the alert fires. |

### 17.7 Retention

| Data | Rule | Where it's enforced | Interaction |
|---|---|---|---|
| Ended shares (tombstones) | `metadata_purge_after` = `ended_at` + `historyRetentionDays` from the snapshot (30 on Free), set by `end_share` | `purge-tombstones` | Waits for the share's outbox rows to complete. With D-3, shares with abuse reports are kept. |
| Files, text, links, grants | Deleted with the share (cascade) | Same | Text is already erased at the end; objects are already deleted |
| `downloads` | `retention_until` from the snapshot (30 days on Free) | `purge-tombstones` (own clause) | Also deleted when the share row is (C-14) |
| `audit_events` | `retention_until`, 90 days by default | `purge-tombstones` (own clause) | Keeps `share.ended`, `admin.block` and burn events for 90 days after the share row is gone |
| `object_deletions` | Completed more than 30 days ago | `purge-tombstones` | Open rows are never purged |
| `abuse_reports` | No job (Q-022) | — | D-3: keep the shares they point to until Q-022 sets evidence retention |
| `storage_reservations` | Settled rows aren't purged today | — | Not in scope. Proposed for Phase 6 cleanup; recorded as a gap. |
| Network spaces | `purge-idle-spaces` needs no share rows | Existing job | Purging tombstones lets idle spaces go 30 days later. Intended. |
| Anonymous users | 30 days inactive, nothing open | `cleanup-anonymous-users` | Runs after `purge-tombstones` |

**Order each night:**

1. 03:00 `purge-tombstones`;
2. 03:17 `purge-idle-spaces` (existing);
3. 03:30 `cleanup-anonymous-users`;
4. 04:00 `reconcile-storage-usage`.

The order doesn't affect correctness: each job checks its own conditions.

**Burn:** a consumed share is a tombstone like any other. Its claim columns stay for audit until the purge; the `burn_claimed` and `burn_retry` download rows follow their own `retention_until`.

**Legal and evidence (Q-022):**

- With a prompt janitor, a blocked share's files are gone within minutes (C-10).
- Holding them conflicts with data minimization, and possibly with laws on possessing illegal material.
- Deleting them may break evidence-preservation duties (for example US 18 U.S.C. § 2258A for CSAM reported to NCMEC).
- That choice belongs to legal review. The plan builds the hold mechanism (D-2) and leaves its default to the owner.

### 17.8 Burn after download

#### 17.8.1 Schema (on `app.shares`, `app.downloads`)

| Column | Type | Notes |
|---|---|---|
| `claimed_at` | timestamptz null | |
| `claimed_by_user_id` | uuid null | A device claimant's user; plain ID, no foreign key (like `downloads.user_id`) |
| `claimed_device_id` | uuid null | A device claimant's device |
| `claimed_link_session_hash` | bytea null, 32 bytes | A link-viewer claimant: the SHA-256 of their session cookie, never the cookie (C-8) |
| `claimed_link_id` | text null → `share_links` ON DELETE SET NULL | Which link the viewer used, for audit |
| `claim_grace_until` | timestamptz null | |

New checks:

- **`shares_claim_columns`:** claim columns are null unless `status in ('claimed', 'consumed')`.
- **`shares_claim_complete`:** when `status = 'claimed'`, `claimed_at` and `claim_grace_until` are set, and **exactly one** claimant kind is set: either `claimed_by_user_id` and `claimed_device_id` with no session hash, or the session hash alone.
- **`shares_claim_grace`:** `claim_grace_until <= claimed_at + interval '6 hours'` and `claim_grace_until <= expires_at`.
- **`shares_consumed_requires_burn`:** `status <> 'consumed' or burn_after_download`.

The existing `shares_claim_requires_burn` stays. A `consumed` share keeps the claim columns of its claim, which is why the first check allows them.

New index: `(claim_grace_until) where status = 'claimed'` (04 §7.1).

`downloads.event` gains `burn_claimed`, `burn_retry` and `text_revealed`. No claimant identity is added to `downloads`: issuances during grace are counted by `(share_id, file_id, event)`, because only the claimant can get URLs then.

#### 17.8.2 `app.claim_burn_share()` contract

`app.claim_burn_share(share_id, file_id null, claimant_kind, user_id, device_id, link_session_hash, link_id, purpose 'file'|'text', download-row fields)` returns `(outcome, claim_grace_until, issuance)`. The function is `security invoker`, granted to `app_server`, and called **inside the request's transaction**.

1. Check the arguments: exactly one claimant kind, and `file_id` given if and only if `purpose = 'file'`.
2. **The claim, one conditional UPDATE** (03 §5.3):
   - It sets `status = 'claimed'`, `claimed_at = now()`, the claimant columns, `claimed_link_id`, and `claim_grace_until = least(now() + grace, expires_at)`.
   - Grace is `least(15 minutes + ceil(total_bytes / 1 MiB) seconds, 6 hours)`.
   - It applies only where `id = share_id and status = 'active' and burn_after_download and expires_at > now()`, and returns the row.
3. **One row returned:** this call won. Insert the download row (`burn_claimed` for a file, `text_revealed` for text). Return `claimed` with issuance 1.
4. **No row returned:** `SELECT … FOR UPDATE` the share row. This reads the latest committed state, so a claim by another transaction is visible now.
   - If it is `claimed` by **this** claimant, `now() < claim_grace_until` and `expires_at > now()`, count issuances. For a file: `burn_claimed` plus `burn_retry` rows for that file. For text: `text_revealed` rows.
     - Under 3: insert `burn_retry` or `text_revealed` and return `retry` with n.
     - Otherwise return `retry_limit`.
   - If it is `claimed` by someone else, or `consumed`: return `already_downloaded`, with `by_you` when the claimant matches.
   - Anything else (not burn, ended, expired): return `not_claimable`. The caller answers as it would for a non-burn share.

**The caller** (`lib/server/shares/burn.ts`):

1. Runs the visibility check (device) or the grant check (viewer) **before** step 2.
2. Presigns the URL **before committing**. SigV4 is a local computation; if it fails, the transaction rolls back and the claim with it.
3. Commits.

Nothing reads the state first and decides afterwards.

#### 17.8.3 Race analysis

**Isolation level.** The claim must run under READ COMMITTED, the Postgres and Supabase default and what Kysely transactions use today. Under REPEATABLE READ or SERIALIZABLE, the losing UPDATE would fail with `40001 could not serialize` instead of updating zero rows. The service must never raise the isolation level for this path; a unit test checks that the transaction is opened without one.

**Two people at the same moment** (devices A and B, or a device and a link viewer):

| Step | Transaction A | Transaction B |
|---|---|---|
| 1 | Visibility check passes | Visibility check passes |
| 2 | UPDATE … WHERE `status = 'active'`: finds the row, takes its row lock, sets `claimed` (not committed yet) | UPDATE … WHERE `status = 'active'`: finds the same row, **waits** for A's row lock |
| 3 | Inserts `burn_claimed`, presigns, **commits**; the lock is released | — |
| 4 | — | Wakes up. READ COMMITTED re-checks the WHERE clause on the committed row: `status` is now `claimed`, so **0 rows** |
| 5 | Gets `200` with the URL | `SELECT … FOR UPDATE` sees A as claimant, not B → `already_downloaded` → **`410 ALREADY_DOWNLOADED`** (`byYou: false`); its transaction rolls back with nothing written |

If A rolls back instead (presign failed, connection lost), B's UPDATE re-checks against the unchanged `active` row and **B wins**. The share is never left claimed without a URL issued.

**Fifty at once:** the same thing 49 times. The row lock queues every UPDATE behind the first; each one after it re-checks against `claimed` and updates 0 rows. Exactly one `burn_claimed` row and one claimant are recorded.

- Through the API, the server's pool of 5 database connections limits how many transactions reach the database at the same moment.
- So T-037 has two parts:
  - a **SQL-level** test with 50 separate connections released together, which gives the real contention;
  - an **API-level** test with 50 devices posting at once, which proves the whole path.

**The claimant's own double click:** the second request blocks on the row lock (step 2, then 4), then sees itself as claimant → `retry`, issuance 2. Per-file counts hold under any parallelism, because counting and inserting happen under the share's row lock.

**Claim against other changes:**

- **Expiry job, creator delete, takedown.** `end_share` locks the row first. The claim waits, then updates 0 rows, then reads an ended share → `not_claimable` → `404` (or `410 LINK_EXPIRED` for a viewer, as today).
- **The other way round.** If the claim locks first, `end_share` waits for it and then ends a `claimed` share. That is allowed: `claimed` is still open.
- **Finalize against a retry.** Both lock the row. If finalize goes first, the retry reads `consumed` → `410`. If the retry goes first, it succeeds only while `now() < claim_grace_until`, so finalize changes nothing for it.

**Time:** every comparison uses the database's `now()`, as Phase 1 and 2 code does (`db_now`).

#### 17.8.4 Claimant identity and rules

| Who | Identity | Rules on the claim and on every retry |
|---|---|---|
| Device on the network | `claimed_by_user_id` (from the verified Supabase token) + `claimed_device_id` (`X-Device-Id`, which `requireCaller` checks belongs to that user) | The visibility rule must still pass: still on an eligible network for the share's space (03 §5 "still on the network"). Leaving the network during grace loses access (R3-5). |
| Link viewer | `claimed_link_session_hash` (the session the server issued; never a value the client chose, Phase 2) | `requireViewerAccess` must pass on every retry, through any link to the share: session and grant alive, link not revoked, share not ended. If the grant expires inside grace, access is lost (R3-5). |
| Creator (same user) | — | **Never claims** (DEC-015). The creator may still get URLs while the share is `active` or `claimed`, until it is consumed (D-7). The exemption needs the verified user: a creator who opens their own link in a browser is a link viewer and **does claim** (R3-4, copy needed). |
| Anyone else on the network | — | `410 ALREADY_DOWNLOADED` (`byYou: false`) once the share is claimed. Callers who couldn't have seen the share get the same `404` as today. |

**Visibility changes** (`lib/server/local/visibility.ts`):

- The function returns `visible`, `claimed_by_other` or `hidden`.
- A `claimed` share is `visible` to its creator, and to its device claimant while that device is on an eligible network.
- It is `claimed_by_other` for anyone else who would have seen it while it was `active`.
- The context gains the caller's device ID.

**Link viewers** (`lib/server/links/grants.ts`): `accessFor` checks `consumed` and `claimed` **before** link revocation. This matters because `end_share` revokes the links when a share is consumed. The claimant gets access; anyone else gets `410 ALREADY_DOWNLOADED` instead of `LINK_EXPIRED`.

#### 17.8.5 Grace window and issuances

- **Grace:** `least(15 min + ceil(total_bytes / 1 MiB) s, 6 h)`, capped at `expires_at` (C-9). On Free (at most 20 × 100 MB) that is at most about 49 minutes.
- **Issuances:** at most 3 download URLs per file during grace: the claim plus two retries. Each URL lives 60 s.
- **Text:** at most 3 reveals.
- **Several files:** one claim covers the whole share; each file has its own count of 3.
- **Previews:** none (§17.8.8).

#### 17.8.6 `confirm-received`, finalize and `consumed`

- **`confirm-received`** (the claimant only) calls `end_share(id, 'consumed')` at once, in a transaction that first locks the share and checks the claimant.
- **Finalize** (§17.6) does the same when grace ends.
- **The 5-minute margin:** `end_share` gives the outbox rows of a `consumed` share `not_before = now() + 5 minutes`, so a download that started from a URL issued just before the end can finish (04 §8.7). This is the only change to `end_share`'s outbox behaviour (and D-2).
- **What `consumed` does:** text is erased, links are revoked (Phase 2), the quota is released, `share.changed` is sent, and the purge date is set.

#### 17.8.7 Realtime and lists

- **Realtime.** The existing `shares_emit_changed` trigger already sends `share.changed {shareId, status}` to `net:{space}` and `user:{creator}` on every status change, including `active` → `claimed` and `claimed` → `consumed`. No trigger change. The payloads carry IDs only, never content.
- **The local feed** keeps `status = 'active'` and adds `status = 'claimed' and claimed_device_id = caller device`, so the claimant keeps the card. On every other device the invalidated feed simply no longer returns the share.
- **My uploads** adds `claimed`: the creator sees "opened, deleted at …".
- **Share page.** Link viewers have no Realtime. The share page's 30-second poll picks the change up as `410` or the claimant state.
- **Client cache.** The TanStack cache for a share that answers `404` or `410` is removed (DEC-034 rule 4). Burn text is never stored in the query cache (§17.9).

#### 17.8.8 Restrictions: previews, text, unfurlers, scanners

- **No previews for burn shares.**
  - At completion `preview_kind` stays `none` for them.
  - DTOs say `previewable: false`.
  - Both preview endpoints answer `422 PREVIEW_UNAVAILABLE` (T-028).
- **Text burn shares.**
  - DTOs and viewer content return `text: null` with `burn.textHidden: true` to everyone but the creator.
  - Only `POST …/reveal` returns the content.
- **Claims are POST only.**
  - JSON body, exact Origin check, and `confirm: true` in the body.
  - Without `confirm: true`, a burn claim answers `409 CONFIRMATION_REQUIRED` and changes nothing. A client that doesn't know about burn (for example an older tab) can't claim by accident.
  - GETs never claim. The feed, share detail, viewer content and the share page are GETs.
- **Scanners.**
  - An email scanner or link unfurler that runs the share page's JavaScript only reaches the unlock POST, which doesn't claim.
  - Claiming needs a click on Download or Reveal and then a confirmation.
  - No download URL is ever fetched in advance.

#### 17.8.9 Retries

| Case | Result |
|---|---|
| The claimant's response was lost | Retrying within grace is issuance 2 for that file |
| The download failed on the phone | "Download again" while issuances are left; then `409 BURN_RETRY_LIMIT` |
| Grace is over, or confirmed received | `410 ALREADY_DOWNLOADED` (`byYou: true`) |
| The claimant left the network, or the grant expired | Same answers as today (`404`, or `404 LINK_UNAVAILABLE`). The content is lost when grace ends (R3-5; copy needed). |

### 17.9 Burn UI

Logic stays in services and hooks (`lib/client`), not in components. The burn text from Reveal is kept only in component state, never in Zustand or the query cache (like Phase 2's link secret), and is never fetched again on remount, because that would use up a retry.

| Place (actual file) | Change | Copy |
|---|---|---|
| Composer, Text and Files tabs (`components/local/composer.tsx`; Files is the uploader, C-6) | A burn toggle, shown only when `GET /me/entitlements` says `burnAfterDownload` (§17.10); sent as `burnAfterDownload` on create (`lib/client/uploader.ts`, text post) | Network destination: *"The first person on this network to open it gets it"* (§2, defined). Toggle label: **not defined: owner review.** Link-only destination: **not defined.** |
| Share card (`components/local/share-card.tsx`, `use-share-actions.ts`) | A burn badge; no previews; Download or Reveal opens a confirmation, then sends `confirm: true`. The claimant's card shows "available until …", downloads left, and "I've got it" (`confirm-received`). Others' cards disappear (Realtime). | Confirmation: *"This will be deleted after you open it."* (03 §5.4, defined). Local warning: the §2 line above. Badge, downloads-left and "I've got it" text: **owner review.** |
| My uploads (`components/local/my-uploads.tsx`) | The creator sees claimed and consumed state | **Owner review** |
| Share page (`components/share/shared-view.tsx`, `copy.ts`) | Files without previews; Download → confirm → claim. Text → **Reveal** → confirm → reveal. The claimant's state; an "already downloaded" state from `410 ALREADY_DOWNLOADED`, different when `byYou`. | *"Reveal"* (03 §5.4, defined). Confirmation as above. "Someone else already downloaded it" (09 §8 scenario 8 names the state but gives no wording): **owner review.** Grace-loss warning ("if your device fails before it's saved, it's gone", 03 §5.5 asks for it): **owner review.** |
| Share-link dialog (`components/share/share-link-dialog.tsx`) | For burn shares, warn that opening the link yourself uses it up (R3-4) | **Not defined: owner review** |
| Mobile | Dialogs are the existing Radix ones (touch, focus trapped). On iOS a download may open in the browser rather than save; the remaining count and "Download again" cover a failed save. A background tab drops nothing: the share page polls and the claimant's state comes from the server. | — |

AC-3.8 needs the owner to review every **owner review** item above.

### 17.10 Entitlements and the burn gate

**Today:**

- `FREE_PLAN.features.burnAfterDownload` is `false`.
- `resolveEntitlements` returns Free for every principal.
- There is no Pro plan, no override table and no account.
- So **nobody** could create a burn share.

**Where the gate belongs:** on the server, at **share creation only** (`createFileShare` in `lib/server/shares/create.ts` and `createText` in `text.ts`), through `assertBurnAllowed(caller, env)` in a new `lib/server/shares/burn.ts`. Without the feature it answers `403 FEATURE_NOT_IN_PLAN` with `requiredPlan` (07 §4). Claims and retries don't check the plan again: the share's `entitlement_snapshot` records the feature, and plan changes never act retroactively (07 §5). A kill switch, `burn_after_download_enabled`, stops new burn shares (`503 BURN_AFTER_DOWNLOAD_DISABLED`) and leaves existing ones working. The UI learns availability from `GET /me/entitlements`.

**What the gate checks depends on Q-008:**

| Q-008 answer | Gate | Production effect in Phase 3 |
|---|---|---|
| Pro only at paid launch, nothing for Free | `features.burnAfterDownload` only | Burn ships switched off in production until Phase 4. It is tested on staging with the flag below. |
| Pro at paid launch, Free during the beta (the documented recommendation's option) | The feature **or** the runtime flag `free_burn_after_download` | The owner turns Free burn on or off without a deploy |
| Free permanently | `FREE_PLAN.features.burnAfterDownload = true` | Always on |

The `free_burn_after_download` flag is also how the test suites create burn shares, whatever the answer. It doesn't build any Pro infrastructure. **Q-008 stays open** (§17.19).

### 17.11 Database changes

Already there (no change needed):

- `shares.burn_after_download` and the `claimed` and `consumed` statuses;
- `shares_claim_requires_burn`; `end_share` mapping `consumed`;
- `object_deletions` with `tombstoned_at`, `locked_until` and the open-key unique index; `claim_object_deletions`;
- `storage_usage`; `downloads.retention_until`; `audit_events.retention_until`; `shares.metadata_purge_after` and its index;
- the `shares_emit_changed` trigger;
- the `pg_cron` and `pg_net` extensions.

Proposed migrations (three, for review): `<ts>_phase3_burn.sql`, `<ts>_phase3_janitor_jobs.sql`, `<ts>_phase3_retention.sql`.

| Kind | Change |
|---|---|
| Columns | `shares`: the claim columns (§17.8.1). `files.object_missing_at timestamptz`. `object_deletions`: `last_attempt_at timestamptz`; `legal_hold boolean not null default false` and `hold_reason text` (only if D-2 is accepted). |
| Constraints | `shares_claim_columns`, `shares_claim_complete`, `shares_claim_grace`, `shares_consumed_requires_burn`. `downloads.event` widened. `object_deletions.reason` widened with `orphan`. |
| Indexes | `shares (claim_grace_until) where status = 'claimed'`; `object_deletions (completed_at) where completed_at is not null` (purge); `files (object_missing_at) where object_missing_at is not null` |
| Tables | `app.job_heartbeats` (`job` PK, `last_started_at`, `last_succeeded_at`, `last_failed_at`, `last_error` ≤ 200 characters with no secrets, `last_result jsonb` with counts only). `app.storage_reconcile_runs` (`id`, `started_at`, `finished_at`, `cursor jsonb`, `counts jsonb`, `status`). |
| Functions (app_server) | `claim_burn_share` (§17.8.2); `confirm_burn_received(share, claimant…)`. `end_share` updated: the 5-minute margin for `consumed`, and the hold if D-2. |
| Functions (jobs, granted to nobody) | `finalize_claims(batch)`, `purge_tombstones(batch)`, `reconcile_storage_usage(batch)`, `record_job_run(job, ok, result)`. `cleanup_anonymous_users(batch)` and `trigger_storage_janitor(mode)`, both owned by the migration role because they need the `auth` schema, Vault and pg_net. |
| Functions (`app_janitor`, security definer, owned by `app_owner`, `search_path = ''`) | `janitor_claim_deletions(limit)`: due, not held, not locked, key format valid, the file's share ended and not claimed (or, for `orphan` rows, no live file row with that key); claimed for 2 minutes. `janitor_finish_deletion(id, outcome, error)`: backoff, completion, `object_deleted_at`. `janitor_enqueue_orphan(key, last_modified)`. `janitor_mark_missing(file_id)`. `janitor_reconcile_cursor(...)`. `record_job_run` for the janitor. |
| Functions (`app_egress_loader`) | `replace_egress_ranges(source, cidrs)` (definer) |
| Functions (operators only) | `admin_release_hold(share, operator, reason)`, if D-2 |
| Triggers | None new. `shares_emit_changed` covers `claimed` and `consumed`. |
| Cron | `finalize-burn-claims`, `trigger-storage-janitor`, `purge-tombstones`, `cleanup-anonymous-users`, `reconcile-storage-usage`, `reconcile-r2-orphans`, `refresh-egress-ranges`, `cron-heartbeat`. Schedules in §17.6. |
| Roles | `app_janitor` and `app_egress_loader`, both `NOLOGIN` in the migration. An operator enables login and sets the password per environment, as for `app_server`. |
| Permissions | `app_janitor` and `app_egress_loader`: `USAGE` on `app` and `EXECUTE` on their own functions only; no table privileges. `app_server` gains `claim_burn_share` and `confirm_burn_received`, keeps `end_share`, gets `SELECT` on `job_heartbeats`, and loses `claim_object_deletions` once P3-06 removes the web-tier executor. `revoke execute … from public` again at the end. |
| RLS | Enabled on both new tables. `job_heartbeats`: one `SELECT` policy for `app_server`. `storage_reconcile_runs`: no client or `app_server` policy (definer functions only). |
| Vault | `storage_janitor_url`, `storage_janitor_secret`, `egress_refresh_url`, `egress_refresh_secret`. Created per environment **outside** migrations: by the operator runbook in staging and production, by `pnpm stack:start` locally with local-only values. The trigger functions read them by name and do nothing (recording a failed heartbeat) when one is missing. |
| Runtime flags | `storage_janitor_enabled`, `burn_after_download_enabled`, `free_burn_after_download` (§17.10), `cron_heartbeat` |

### 17.12 API changes

All mutations keep the Phase 1 rules: exact Origin, JSON body, strict schemas, `withApi` error shape, and redaction (no text content, presigned URLs, cookies or session hashes in logs).

| Endpoint | Authorization | Validation | State change | Errors | Idempotency | Rate limit | Logging | Tests |
|---|---|---|---|---|---|---|---|---|
| `POST /api/v1/shares`, `POST /api/v1/texts` | Device (as today) | `burnAfterDownload?: boolean` (strict) | New share with `burn_after_download` | `403 FEATURE_NOT_IN_PLAN` (`requiredPlan`), `503 BURN_AFTER_DOWNLOAD_DISABLED`, existing errors | Existing `Idempotency-Key` on file shares: a replay returns the original share, burn flag included (the key decides, not the body; Phase 1 behaviour) | Existing | `share.created` audit metadata gains `burn: true` | Gate on and off; flag off; snapshot records the feature |
| `POST /api/v1/files/{fileId}/download-url` | Device; visibility | Body `{ confirm?: true }` | Burn and not creator: `active` → `claimed`, or a retry | `409 CONFIRMATION_REQUIRED`, `410 ALREADY_DOWNLOADED` (`byYou`), `409 BURN_RETRY_LIMIT`, `404` as today | The claimant's repeats are retries (counted) | Existing `downloadUrl` (per device) and `downloadUrlSpace` | `downloads` event; `burn.claimed` info log (share ID, claimant kind) | T-037, T-038, T-039 |
| `POST /api/v1/files/{fileId}/preview-url` | As today | — | — | Burn: `422 PREVIEW_UNAVAILABLE` | — | Existing | Existing | T-028 |
| `POST /api/v1/links/{linkId}/files/{fileId}/download-url` and `…/preview-url` | Grant (Phase 2) | As above | As above, claimant = link session | As above, plus Phase 2 errors and the daily cap | As above | Existing `viewerUrl` and the per-link daily cap | As above, with `link_id` | T-037 (mixed claimants), T-038 |
| `GET /api/v1/links/{linkId}/content` | Grant | — | None; never claims | Claimed by another or consumed: `410 ALREADY_DOWNLOADED` | Read-only | Existing | — | Burn text never returned; claimant state |
| `GET /local/shares`, `/me/shares`, `/shares/{id}` | As today | — | None; never claim | Claimed by another: `410` on detail, left out of the feed | Read-only | Existing | — | DTO tests |
| `POST /api/v1/shares/{shareId}/reveal` **(new, C-7)** | Device; visibility | `{ confirm: true }` | Text burn: claim or retry | As for download-url; not a text burn share → `404` | Counted retries | Same counters as download URLs | `text_revealed`; never the content | T-040 |
| `POST /api/v1/links/{linkId}/reveal` **(new)** | Grant | As above | As above | As above | As above | `viewerUrl` | As above | T-040 (viewer) |
| `POST /api/v1/shares/{shareId}/confirm-received` | Device; must be the claimant | `{}` | `claimed` → `consumed` (`end_share`, deletion after the margin) | Not the claimant, not claimed, or not visible: `404` | Already consumed by this claimant: `204` | New `confirmReceived`: 30/min per device | Audit `burn.confirmed` | Confirm ends grace; others `404`; repeat `204`; deletion `not_before` |
| `POST /api/v1/links/{linkId}/confirm-received` **(new)** | Grant; must be the claimant | `{}` | As above | As above | As above | `confirmReceived` per link session | As above | As above |
| `GET /api/v1/health/cron` | None (for the uptime monitor) | — | None | `503` when any check fails | Read-only | Cloudflare only (cheap, indexed queries) | — | Each check's ok and failing case |
| `GET /api/v1/me/entitlements` **(new, C-7)** | Device | — | None | — | Read-only | 60/min per device | — | Free with the flag off and on |

`/health/cron` returns `{ status: "ok" | "degraded", checks: { heartbeat, janitorBacklog, janitorFailures, burnFinalize, reconcile, storageDrift, egressLists } }`. Each check is `ok` or a short state word: no counts, keys or IDs. It sends `Cache-Control: no-store`.

### 17.13 Storage lifecycle and RustFS versus R2

The two lifecycles are the diagrams in §17.4.2.

| | Local and CI (RustFS) | Staging and production (R2) |
|---|---|---|
| Who runs the janitor | The local edge runtime (`supabase functions serve` through `pnpm stack:start`, C-3); Vitest runs the core in Node | Supabase Edge Functions |
| Reaching storage | `host.docker.internal:9000` from the edge container (P3-00) | The R2 S3 endpoint |
| Credentials | The fixed local keys in `scripts/local-stack.cjs` | A separate janitor R2 token. R2 tokens have no delete-only scope (to confirm in SP-02), so it is read and write for the one bucket (R3-3). |
| Lifecycle backstop | None. RustFS has no rules applied, so leftovers stay until the janitor. | `infra/r2/lifecycle.json` once applied (SP-02) |
| Write-once and tombstones | Verified (Phase 1) | SP-02 |
| ListObjectsV2, `LastModified`, DeleteObjects batches, ListMultipartUploads | Verified in P3-05's integration tests | SP-02. DeleteObjects is used only if R2 confirms it (RISK-011). |
| Deleting while a GET is streaming | Measured once in P3-00 | SP-02. That is why `consumed` has the 5-minute margin. |

### 17.14 Threat model

| Threat | Mitigation | Test |
|---|---|---|
| Double claim | One conditional UPDATE under the row lock; READ COMMITTED only | T-037 (SQL, 50 connections; API, 50 devices; mixed devices and viewers) |
| Race conditions with end, expiry and finalize | Every path locks the share row; the claim WHERE clause requires `active` and unexpired; retries re-check under the lock (§17.8.3) | pgTAP race cases with two sessions; integration: delete during claim, finalize during retry |
| Replay | A replayed request needs the claimant's own credentials and uses up their retries; the 60 s URLs are bearer tokens (RISK-009) | T-038 retry limit |
| Forged claimant identity | Device: verified token plus a device ID owned by that user. Viewer: the hash of a server-issued httpOnly cookie, never adopted from the client. | Another user's device ID → `401`; a chosen cookie can't retry (Phase 2 pattern) |
| Link-session abuse | One claim per share; the claimant's session needs a live grant on every retry; per-session and per-link limits | Revoked link → claimant `404`; grant expired → `404` |
| Creator exemption abuse | The exemption needs `created_by_user_id` = the verified user; viewers are never exempt | T-039; a viewer who happens to be the creator still claims |
| Expired grants and shares | Grace capped at `expires_at`; request-time checks on every issuance | URL refused at `expires_at` inside grace |
| Unauthorized downloads | The visibility or grant check comes before the claim; burn files only through the claim path | IDOR matrix extended with the new routes and claimant actors |
| Stale signed URLs | 60 s download URLs; deletion at least 5 minutes after grace | `not_before` assertion; a URL requested after `consumed` is refused |
| Janitor deleting active files | SQL guard at claim (share ended, not claimed); outbox rows come only from database functions or app transactions that end the share; dry-run first on staging; volume check | T-043 (an active share's injected row is refused and logged) |
| Malicious object keys | A check constraint on outbox keys; the claim function checks the format again; the core checks it a third time; reconcile never queues unknown formats | T-043 invalid key; unknown key reported |
| Orphan reconciliation deleting valid files | SQL recheck: no live file row, older than 48 hours, no open outbox row; reconcile only queues, never deletes | T-044 |
| Anonymous-user cleanup deleting active users | Several independent conditions: an active device, an open share, being a claimant, a reservation, not anonymous | T-045 |
| Cron or job compromise | Job functions are granted to nobody but pg_cron's role; least-privilege roles for the functions; kill switches | pgTAP grant checks |
| Vault secret exposure | The secret only lets someone trigger a janitor run that obeys its guard rails; it is rotated with two accepted values; it never appears in logs or `cron.job` | A wrong secret → `401` |
| Abuse of the job endpoints | `verify_jwt` off only because of the secret check; constant-time compare; a fixed body enum; exit at once on failure. Per-invocation cost is the residual risk (R3-2). | `401` cases; malformed body `400` |
| Function runtime compromise | The injected default secrets (`SUPABASE_DB_URL`, service role) stay readable by a compromised function (R3-2). Pinned, minimal dependencies; no user input. | Dependency review in P3-00 |

### 17.15 Test plan

Phase 3 test IDs from 09 are reused. New ones are `T3-nn` and will be added to 09 §4 when built.

| Layer | Tests |
|---|---|
| Unit (Vitest, Node) | Grace formula (boundaries: 0 bytes, 1 MiB, the 6-hour cap, the expiry cap). Janitor core with fake storage and database: outcomes, backoff schedule, dry-run, key validation, the time budget, refusing to start without `JANITOR_DATABASE_URL` (C-4). The shared egress merge against today's loader fixtures. Visibility tri-state. The burn service maps outcomes to errors. |
| Component (jsdom) | Composer toggle shown only when entitled; confirmation before claim; Reveal; already-downloaded (both `byYou`); claimant state with downloads left; confirm-received; burn text not in the query cache; no preview |
| Database (pgTAP) | Constraints (claim columns, one claimant kind, grace caps). `claim_burn_share`: claim, retry, `retry_limit`, other claimant, consumed, not claimable, creator never passed. `finalize_claims`. `end_share` margin for `consumed` (and the hold, if D-2). `janitor_claim_deletions` guard rails. `purge_tombstones` cascades and exclusions. `cleanup_anonymous_users` (T-045). `reconcile_storage_usage`. Every new function's grants. Phase 1 and 2 suites unchanged. |
| API integration (real `next start`, RustFS) | T-038, T-039, T-040, T-028; the IDOR matrix with claimant and non-claimant actors on every new route; confirm-received; `/health/cron`; `/me/entitlements`; a creator delete followed by a janitor run (C-1 rewrites) |
| Concurrency | **T-037 SQL:** 50 connections, each opens a transaction and waits on a shared advisory lock held by the test; the test releases it, all 50 call `claim_burn_share` together; exactly 1 `claimed`, 49 `already_downloaded`, 1 `burn_claimed` row. Repeated 20 times. **T-037 API:** 50 devices on one network post download-url at once: 1 × `200`, 49 × `410`. A mixed run: 25 devices and 25 link viewers. A **mutation check** (drop `status = 'active'` from the WHERE clause) must make both fail (as Phase 2's F2-6). T3-01: the claimant's 10 parallel retries give exactly 3 URLs in total. |
| Failure injection | T3-02: a small Node fault proxy in front of RustFS (test support, no package) returns `500` or `503` or drops the connection for N DELETEs: backoff schedule, attempts, then success. T3-03: a tombstone PUT failure leaves the row retried, not completed. T3-04: the janitor killed mid-batch leaves locked rows, and another run takes them after 2 minutes. |
| Storage failures | Janitor stopped: access still denied on every path while the objects still exist (**T3-05**). R2 (RustFS) down: deletions back off, and `/health/cron` reports `janitorFailures` after 5 attempts (**T3-06**). |
| Cron failures | Jobs paused (`cron.alter_job(active := false)` in the test database): access still denied; claimed shares past grace refused at request time; `/health/cron` → `503` once the heartbeat is old (**T3-07**) |
| Reconciliation | T-044 cases; T3-08: missing object marked and logged; T3-09: reconcile cursor resumes across invocations; storage-usage race (§17.6) |
| Active and claimed shares | T-043: an injected outbox row for an active share and for a claimed share is refused. T3-10: a claimed share goes through grace, confirm or finalize, consumed, then deletion after the margin. |
| Expired shares | T3-11: expiry → `end_share` → janitor → object gone; local latency recorded (only an indication for AC-3.2) |
| Unfurler and scanner | E2E (extends Phase 2's): three bot GETs on a burn link → still active, no claim. T3-12: a headless "scanner" runs the share page's script for 60 s without clicking → still active. A POST without `confirm` → `409`, still active. |
| E2E (Playwright, two devices) | Device A posts burn text, B reveals and C sees it vanish; burn files with retries and "I've got it"; link viewer claims; creator downloads without claiming; emulated iPhone and Pixel layouts of the dialogs (layout only, not device evidence) |
| Restore drill | Staging (§17.16 `restore-drill.md`), with the time recorded (AC-3.7) |
| Staging soak | 7 days: daily reconciliation with zero unexplained drift (AC-3.5); p95 from `expires_at` to deletion under 5 minutes and no outbox row older than 1 hour (AC-3.2); dry-run janitor for 24 hours before going live |
| Chaos on staging | Janitor flag off and pg_cron paused: access denied, alerts fire (AC-3.6) |
| Manual, mobile | 09 §8 scenario 8 on a real iPhone and Android phone: claim, failed save and retry, "someone else already downloaded", text Reveal. Written up as `phase-3-manual-verification.md` in P3-13. Not faked. |

### 17.16 Runbooks

| Runbook | Contents (operational steps) |
|---|---|
| `runbooks/janitor.md` | **Signals:** `/health/cron` checks `janitorBacklog` or `janitorFailures`; log events `janitor.delete_failed`, `janitor.guard_refused`, `janitor.failing`. **Queries:** due count and oldest age; attempts by count; the top `last_error` values; rows refused by a guard rail; the last run in `job_heartbeats`; recent `net._http_response` rows for the trigger. **Steps:** 1. Check the function logs in the dashboard. 2. On a `guard_refused` row, **stop** (flag `storage_janitor_enabled` off), investigate the bug and never complete the row by hand. 3. On an R2 outage, leave backoff to work and watch the backlog. 4. On a bad secret or URL, check Vault names and rotate (secret-rotation.md). 5. Run by hand: `curl` with the secret from a trusted machine. 6. Dry-run: set `JANITOR_DRY_RUN` and redeploy. 7. Last resort: delete one key with an S3 client and the janitor token, then call `janitor_finish_deletion` as operator. 8. Remember the lifecycle backstop exists. Includes the legal-hold release, if D-2. |
| `runbooks/cron.md` | **Signals:** `heartbeat` stale (more than 10 minutes). **Queries:** `cron.job` (active flags), `cron.job_run_details` (latest failures and durations), `job_heartbeats`. **Steps:** 1. Check Supabase status. 2. Find the failing job and its error. 3. Re-enable it with `cron.alter_job`, or re-create it from the migration's `cron.schedule` line. 4. Run the job functions by hand in order (`expire_due_shares`, `finalize_claims`, `fail_stale_uploads`, then the rest), recording counts. 5. Confirm access stayed denied (request-time checks), with the T-041 queries. 6. Note how long it was down for the incident record. |
| `runbooks/incident.md` | Severity levels and who is on call (Q-022). **First 15 minutes:** contain with the kill switches (`local_sharing_enabled`, `uploads_enabled`, `anonymous_uploads_enabled`, `remote_links_enabled`, `short_codes_enabled`, `burn_after_download_enabled`, `storage_janitor_enabled`; SQL in kill-switches.md), preserve logs and audit events, open an incident record. **Playbooks:** suspected cross-network exposure; a leaked link secret or pepper; an R2 or Supabase credential leak (revoke the token, rotate); a deletion bug (janitor off, dry-run); an abuse surge; Supabase or R2 outage. Status and user communication; a post-incident review template. |
| `runbooks/secret-rotation.md` | One procedure per secret in 03 §12 plus the Phase 3 ones, each in the order generate, set the new value with the old one still accepted, deploy, verify, remove the old value, record. Covers: `ORIGIN_SHARED_SECRET` (two values, `infra/cloudflare/README.md` §2); `NETWORK_KEY_SECRET` (version and previous, 100-day overlap, `rekey_network_space`); `LINK_PEPPER` and `CODE_PEPPER` (raise `PEPPER_VERSION`, keep `*_PREVIOUS` until the last link made under the old version has expired, at most 7 days and 1 hour); the Turnstile secret (Cloudflare, app env and Supabase Auth captcha); Supabase keys; role passwords (`app_server`, `app_janitor`, `app_egress_loader`); R2 tokens (web and janitor: create, deploy, revoke); `JANITOR_TRIGGER_SECRET` (Vault and function, with `_PREVIOUS`). Target: each under 1 hour (08 §10). |
| `runbooks/restore-drill.md` | Quarterly, staging only. **Steps:** 1. Record the source backup time and the start time. 2. Restore into the staging project, or a scratch project. 3. Turn the janitor off first (flag), so restored outbox rows and reconcile don't act on objects that are now out of step. 4. Re-create the role logins and passwords, and the Vault secrets (Vault values don't move between projects). 5. Check that the cron jobs exist and point to staging. 6. Run pgTAP and the smoke tests; compare row counts. 7. Expect drift: objects deleted after the backup show as missing (reconcile flags them), and objects created after it become orphans that reconcile deletes after 48 hours (R3-6). 8. Turn the janitor back on. 9. Record RTO and RPO against 08 §10 (RTO ≤ 4 h). |

P3-13 also adds `phases/phase-3-manual-verification.md` (the mobile burn flow and staging chaos steps), and links the new runbooks from 08 §11.

### 17.17 Tasks

Test-first, as in Phases 1 and 2: each task starts with failing pgTAP, Vitest or Playwright tests.

| # | Task | Files | Depends on | Tests |
|---|---|---|---|---|
| P3-00 | **Spike, no app code.** Measure Edge Function CPU and wall time for a janitor batch (100 deletes and tombstones) and the egress merge. Confirm `EdgeRuntime.waitUntil`, pg_net → local functions, functions → RustFS, local Vault, DeleteObjects and ListObjectsV2 on RustFS, and deleting during a streaming GET. Review the Deno `npm:` packages. | Spike note in this document | Package approval (D-8) | — |
| P3-01 | Migration: burn schema, `claim_burn_share`, `confirm_burn_received`, `finalize_claims`, the `end_share` margin, `downloads` events | `supabase/migrations/<ts>_phase3_burn.sql`, `supabase/tests/phase3_burn.test.sql` | — | pgTAP; T-037 SQL |
| P3-02 | Migration: `app_janitor`, janitor functions with guard rails and backoff, `job_heartbeats`, `storage_reconcile_runs`, the trigger function (Vault, pg_net), flags, cron schedules, `files.object_missing_at`, the `orphan` reason, `legal_hold` (if D-2) | `<ts>_phase3_janitor_jobs.sql`, `phase3_jobs.test.sql` | P3-00 | pgTAP |
| P3-03 | Migration: `purge_tombstones`, `cleanup_anonymous_users`, `reconcile_storage_usage`, `replace_egress_ranges`, `app_egress_loader`, schedules | `<ts>_phase3_retention.sql`, `phase3_retention.test.sql` | P3-02 | pgTAP; T-045 |
| P3-04 | Janitor core and the shared modules (storage interface, database interface, key check, backoff, egress merge) | `supabase/functions/_shared/{janitor-core.ts, storage.ts, egress-merge.ts}`; `scripts/load-egress-ranges.cjs` switched to the shared merge | P3-00 | Unit |
| P3-05 | `storage-janitor` Edge Function (delete and reconcile), the local stack runs the edge runtime and writes local Vault secrets, `config.toml` `verify_jwt = false` for it, the test harness can run the janitor | `supabase/functions/storage-janitor/{index.ts, deno.json}`, `scripts/local-stack.cjs`, `package.json` (`stack:start`), `supabase/config.toml`, `tests/integration/support/*` | P3-02, P3-04 | T-043, T-044, T3-02 … T3-09 |
| P3-06 | Remove the web-tier executor (C-1): `executePendingDeletions` and `sweepDueDeletions` calls, and `deleteObject` and `putTombstone` from the web tier. Revoke `claim_object_deletions` from `app_server`. Rewrite the Phase 1 deletion tests to run the janitor, keeping every assertion. | `lib/server/shares/{end.ts, complete.ts}`, `lib/server/storage/s3.ts`, `tests/integration/uploads.test.ts` | P3-05, D-1 | Existing Phase 1 tests (rewritten), T3-05 |
| P3-07 | Burn services: `burn.ts` (gate, claim and retry, reveal, confirm); visibility tri-state; feed and My uploads; DTOs; `download.ts`; viewer access and URLs; no previews for burn at completion; text creation flag | `lib/server/shares/{burn.ts, download.ts, read.ts, dto.ts, create.ts, text.ts, complete.ts}`, `lib/server/local/visibility.ts`, `lib/server/links/{grants.ts, viewer.ts}`, `lib/server/{flags.ts, http/errors.ts, ratelimit/limits.ts}`, `lib/shared/{plans.ts, api/schemas.ts}` | P3-01 | Unit; T-038, T-039, T-040, T-028; IDOR |
| P3-08 | Routes: reveal (×2), confirm-received (×2), `health/cron`, `me/entitlements`; download-url bodies; authz matrix entries | `app/api/v1/shares/[shareId]/{reveal, confirm-received}/route.ts`, `app/api/v1/links/[linkId]/{reveal, confirm-received}/route.ts`, `app/api/v1/health/cron/route.ts`, `app/api/v1/me/entitlements/route.ts`, `lib/server/jobs/health.ts` | P3-07, P3-02 | Integration; T3-07 |
| P3-09 | `refresh-egress-ranges` (Edge Function, or the P3-00 fallback) | `supabase/functions/refresh-egress-ranges/*` or a workflow file | P3-03, P3-04, D-4 | Integration |
| P3-10 | Client: schemas and types, entitlements query, the uploader's burn flag, the Realtime mapping for `claimed` and `consumed`, burn UI (§17.9) | `lib/client/{uploader.ts, realtime.ts, queries/*}`, `components/local/{composer.tsx, share-card.tsx, use-share-actions.ts, my-uploads.tsx, copy.ts}`, `components/share/{shared-view.tsx, copy.ts, share-link-dialog.tsx}`, new `components/burn/*` | P3-08 | Component |
| P3-11 | Concurrency and failure-injection suites (the parts not already in earlier tasks); mutation check | `tests/integration/{burn.test.ts, burn-concurrency.test.ts, janitor.test.ts, retention.test.ts, cron-health.test.ts}`, `tests/integration/support/fault-proxy.ts` | P3-05, P3-08 | T-037 API, T3-01 … T3-12 |
| P3-12 | E2E burn flows | `tests/e2e/local-burn.spec.ts` | P3-10 | E2E |
| P3-13 | Runbooks and the manual procedure | `runbooks/{janitor, cron, incident, secret-rotation, restore-drill}.md`, `phases/phase-3-manual-verification.md` | — | Link check |
| P3-14 | Health aggregation and the alert hookup (uptime monitor on `/health/cron`; the alert channel per D-5) | `lib/server/jobs/health.ts`, `infra/` notes | P3-08, D-5 | Integration; staging chaos |
| P3-15 | Docs: ARCHITECTURE.md (new components, roles, trust boundary, deletion ownership, lifecycle; change log), 02, 03 (§5, §9 matrix, §12, §13 inventory), 04, 06, 07, 08, 09, README | `project-docs-workthrough/**` | All | Link check |
| P3-16 | Staging rollout and verification (§17.21) | — | Staging, R2, D-5 | AC evidence |

### 17.18 Acceptance mapping

Nothing here is verified yet.

| AC | Tasks | Automated tests | Staging or manual evidence | Who verifies |
|---|---|---|---|---|
| AC-3.1 | P3-01, P3-07, P3-08 | T-037 (SQL and API, mixed, mutation check), T-038, T-039, T-040, T3-01 | Manual burn flow on two real phones (scenario 8) | CI; tester for the manual part |
| AC-3.2 | P3-02, P3-05, P3-16 | T3-11 (local indication only) | p95 from `expires_at` to deletion under 5 minutes, and no outbox row older than 1 hour, over the soak; query in `janitor.md` | Operator, on staging |
| AC-3.3 | P3-02, P3-04, P3-05 | T-043, T-044 | 24 hours of dry-run logs on staging | CI; operator for the dry run |
| AC-3.4 | P3-03 | T-045, purge pgTAP | — | CI |
| AC-3.5 | P3-03 | Reconciliation pgTAP, race test | 7-day staging soak: daily job logs with zero unexplained drift | Operator |
| AC-3.6 | P3-02, P3-08, P3-14 | T3-05, T3-06, T3-07 | Staging chaos: janitor off and pg_cron paused, access denied, alerts received | Operator and owner (alert channel, D-5) |
| AC-3.7 | P3-13 | Link check | Restore drill notes with the measured RTO | Operator |
| AC-3.8 | P3-10, P3-12 | Unfurler and scanner E2E, T3-12 | Owner copy review (§17.9) | Owner |
| AC-3.9 | P3-13, P3-14, P3-16 | — | Gate items: monitoring and alerts live, kill switches tested in production, incident runbook with a named on-call, backups verified by the drill | Owner and operator (Q-022, D-5) |
| AC-3.10 | P3-15 | Link check | Doc diff | Owner |

### 17.19 Open decisions

**Questions already open:**

| Question | What the plan says | What the code supports today | Decision needed | What depends on it |
|---|---|---|---|---|
| **Q-008** Burn for Free? | Pro-only at paid launch, optionally Free during beta (06); "production default per Q-008" (§2) | Free only, with `burnAfterDownload: false`; no Pro | Pro-only, Free during beta (a flag), or Free permanently (§17.10) | Whether burn is usable in production in Phase 3, the `free_burn_after_download` default, and the composer toggle |
| **Q-013** Cloudflare plan | Free for staging and alpha; evaluate Pro before the public beta | Nothing applied (no zone) | Free or Pro at the public beta | Not Phase 3 code. It decides the WAF and rate-limit rules the gate relies on: the per-IP `/api/` rule that RISK-032 depends on, and the janitor function is outside Cloudflare anyway. |
| **Q-022** Operator and legal | A named operator and external legal review before the public beta | Report intake and SQL takedown; no alerts (owner decision 2026-10-16) | The on-call owner and alert channel (AC-3.6, AC-3.9); the evidence rule for blocked content (D-2) and reported shares (D-3) | AC-3.6, AC-3.9, the `legal_hold` default, the purge exclusion, the incident runbook's roles |

**Decisions this plan raises** (each is the owner's call; the recommendation comes first):

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D-1 | Remove the web-tier executor (C-1)? | (a) Yes, after the janitor runs in that environment (the §2 scope); (b) keep it for the creator's own share | (a). One executor. The only cost is a 1–2 minute delay before bytes are deleted, while access ends at once. |
| D-2 | Blocked shares' objects | (a) Hold them until an operator releases them; (b) delete them promptly like any other end | Decide with Q-022's legal review. The plan builds (a)'s mechanism, because a hold can be undone and a deletion can't; the default is set by the decision. |
| D-3 | Purging shares that have abuse reports | (a) Keep them until Q-022 sets evidence retention; (b) purge after 30 days like any other | (a) until Q-022 answers |
| D-4 | Where the egress refresh runs if it exceeds Edge limits | Edge Function; a GitHub Actions schedule running the existing script; a Cloudflare Worker | Decided by P3-00's measurement (DEC-017 alternatives) |
| D-5 | Alert delivery for the gate | An external uptime monitor on `/health/cron` (nothing to build) with email or chat; or error monitoring (Phase 6 package early) | The uptime monitor first; it meets AC-3.6. Choose the channel and its owner. |
| D-6 | Grace window capped at `expires_at` (C-9) | Cap it; or let grace run past expiry | Cap it: it follows 04 §9.1 |
| D-7 | Creator downloads while their share is claimed | Allowed; or refused | Allowed: they posted it |
| D-8 | Packages for the Edge Functions | `aws4fetch` (MIT, no dependencies) and `postgres` (porsager) as pinned Deno `npm:` imports; or the AWS SDK in Deno (larger bundle and cold start) | `aws4fetch` and `postgres`, pending review in P3-00 |
| D-9 | Suspended anonymous users in cleanup | Delete like others; keep while suspended | Keep while suspended, so the suspension record isn't lost; a short rule |

Copy decisions are in §17.9 (AC-3.8).

### 17.20 Dependencies and risks

**Dependencies:**

| On | What Phase 3 needs | State |
|---|---|---|
| Phase 2 implementation | Link sessions, grants and viewer endpoints (claimant identity), `end_share`'s link revocation, takedown functions | Built and committed (`3e03120`), NEEDS REVIEW |
| Supabase Edge Functions | The janitor (and maybe the egress refresh); limits in §17.5; `EdgeRuntime.waitUntil` | Not measured (P3-00); local runtime excluded today (C-3) |
| pg_cron | 8 new jobs; at most 8 concurrent | Installed |
| pg_net | Trigger posts; asynchronous responses in `net._http_response` | Installed; not used yet |
| Vault | 4 secrets per environment | Available in Supabase; not used yet |
| R2 | Bucket, janitor token, lifecycle rules, SP-02 behaviours | No bucket (Phase 0 owner items) |
| Cloudflare | Zone and rules for the gate; the janitor function isn't behind Cloudflare | Not applied (Q-020, Q-013) |
| Entitlements and Pro | Only the Free gate; Pro is Phase 4 | Free only (§17.10) |
| Monitoring and alerts | An uptime monitor and a channel (D-5) | None |
| Backups | Supabase paid plan with daily backups, for the restore drill | No hosted project (Q-016) |
| Packages | D-8 | Not approved |

**Changes to existing risks:**

| Risk | Change |
|---|---|
| RISK-008 | Mitigated by DEC-015 as planned; residuals in R3-4 and R3-5 |
| RISK-011 | Adds DeleteObjects, ListObjectsV2, `LastModified` and delete-during-GET to SP-02 |
| RISK-012 | Mitigated by daily reconciliation |
| RISK-018 | Mitigated by the SQL guard rails, a least-privilege role, dry-run and volume checks; residual in R3-3 |
| RISK-006 | Reduced by inactive-user cleanup |
| RISK-029 | Reduced: deleting a user deletes their Auth sessions and stored IPs |
| RISK-031 | **Gets worse** with a prompt janitor unless D-2 holds blocked content |

**New risks** (proposed IDs, to be added to 06 when work starts):

| ID | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R3-1 | Edge Function CPU (2 s) and wall-clock limits are too small for the batches or the egress merge | M / M | P3-00 measures; small batches with a saved cursor; DEC-017 fallback (D-4) |
| R3-2 | Supabase injects full-access secrets into every function, so a compromised function or dependency reaches the whole database; each janitor invocation also costs money | L / H | Few pinned dependencies, no user input, the secret check first; the least-privilege role prevents mistakes but not a compromise |
| R3-3 | The janitor's R2 token can read and overwrite every object (no delete-only scope) | L / H | Separate token, 90-day rotation, only in function secrets; confirm token scopes in SP-02 |
| R3-4 | A creator who opens their own burn link in a browser uses it up (the exemption needs the signed-in user) | M / L | Copy in the link dialog (owner review) |
| R3-5 | The claimant loses the content if their device fails, they leave the network, or their link grant expires during grace (inherent, 03 §5.5) | M / L | Grace sized by file size, 3 issuances, "I've got it", copy |
| R3-6 | After a restore, reconcile deletes objects uploaded after the backup point (48 hours later) and flags missing ones | L / M | Restore runbook turns the janitor off first; accepted as part of RPO |
| R3-7 | pg_net is fire-and-forget; a failing trigger shows only in `net._http_response` | M / L | The janitor writes its own heartbeat; `/health/cron` checks it |
| R3-8 | The tombstone purge removes reported shares (abuse reports keep only nulls) | M / M | D-3 |

### 17.21 Rollout and verification sequence

1. **Owner decisions:** Q-008, D-1, D-2/D-3 (through Q-022), D-5, D-8.
2. **Locally, test-first:** P3-00 → P3-01 → P3-02 → P3-03 → P3-04 → P3-05 → P3-06 → P3-07 → P3-08 → P3-10, then P3-09, P3-11 and P3-12 alongside. Full suites green, including every Phase 1 and Phase 2 test, before going further.
3. **CI:** a pull request with a green run of all jobs, including the new pgTAP and concurrency suites.
4. **Staging setup** (needs the Phase 0 owner items):
   - Apply the migrations.
   - Enable logins for `app_janitor` and `app_egress_loader`.
   - Create the Vault secrets and the janitor R2 token.
   - Deploy the functions with `JANITOR_DRY_RUN=true`.
   - Apply the R2 lifecycle rules.
5. **Dry run** for 24 hours: check the would-delete log against the expected outbox; no guard refusals.
6. **Go live on staging:** turn dry-run off; watch the backlog. Then the 7-day soak: AC-3.2 latency, AC-3.5 drift, and the egress refresh daily.
7. **Chaos tests:** janitor off, then pg_cron paused. Access stays denied and alerts arrive (AC-3.6).
8. **Restore drill** (AC-3.7).
9. **Manual burn flow** on real phones (AC-3.1 manual, AC-3.8 copy review).
10. **Public beta gate checklist** items owned by Phase 3 (AC-3.9).
11. **Status:** CODE COMPLETE / NEEDS REVIEW after step 2; VERIFIED only after steps 3–10 have evidence.

### 17.22 Files and modules expected to change

**New:**

- **Migrations and database tests:** `supabase/migrations/<ts>_phase3_burn.sql`, `<ts>_phase3_janitor_jobs.sql`, `<ts>_phase3_retention.sql`; `supabase/tests/phase3_{burn,jobs,retention}.test.sql`.
- **Edge Functions:** `supabase/functions/_shared/{janitor-core.ts, storage.ts, egress-merge.ts}`, `supabase/functions/storage-janitor/{index.ts, deno.json}`, `supabase/functions/refresh-egress-ranges/{index.ts, deno.json}` (or the D-4 fallback).
- **Server:** `lib/server/shares/burn.ts`, `lib/server/jobs/health.ts`.
- **Routes:** `app/api/v1/shares/[shareId]/{reveal,confirm-received}/route.ts`, `app/api/v1/links/[linkId]/{reveal,confirm-received}/route.ts`, `app/api/v1/health/cron/route.ts`, `app/api/v1/me/entitlements/route.ts`.
- **Client:** `lib/client/queries/entitlements.ts`, `components/burn/*`.
- **Tests:**
  - unit: `tests/unit/{burn-grace, janitor-core, egress-merge, visibility-burn}.test.ts`;
  - component: `tests/component/burn-ui.test.tsx`;
  - integration: `tests/integration/{burn, burn-concurrency, janitor, retention, cron-health}.test.ts`, `tests/integration/support/fault-proxy.ts`;
  - E2E: `tests/e2e/local-burn.spec.ts`.
- **Docs:** `project-docs-workthrough/runbooks/{janitor, cron, incident, secret-rotation, restore-drill}.md`, `phases/phase-3-manual-verification.md`.

**Changed:**

- **Share services:** `lib/server/shares/{download, read, dto, create, text, complete, end}.ts`.
- **Visibility and links:** `lib/server/local/visibility.ts`, `lib/server/links/{grants, viewer}.ts`.
- **Shared server code:** `lib/server/{flags, http/errors, ratelimit/limits, storage/s3}.ts`, `lib/server/entitlements/plans.ts`.
- **Shared contracts:** `lib/shared/{plans, api/schemas}.ts`.
- **Client:** `lib/client/{uploader, realtime}.ts`, `lib/client/queries/{keys, shares, links}.ts`; `components/local/{composer, share-card, use-share-actions, my-uploads, copy}.tsx|ts`, `components/share/{shared-view, share-link-dialog, copy}.tsx|ts`.
- **Stack and config:** `scripts/{local-stack, load-egress-ranges}.cjs`, `package.json` (scripts only), `supabase/config.toml`.
- **Test support:** `tests/integration/support/{api, global-setup}.ts`, `tests/integration/{authz-matrix, uploads}.test.ts`.
- **Docs:** ARCHITECTURE.md, 02, 03, 04, 05, 06, 07, 08, 09, README.

**Architecture changes this would make** (each needs an ARCHITECTURE.md change-log entry when built, §19 of that file):

1. The first server code outside Next.js: Supabase Edge Functions in Deno.
2. Object deletion moves from the web tier to the janitor.
3. Two new database roles, and Vault and pg_net use: a new trust boundary between pg_cron and the functions.
4. The share state machine uses `claimed` and `consumed`, and visibility and viewer access gain claimant rules.
5. New endpoints and DTO fields.
6. Jobs that delete rows and users.
7. A job-health surface for monitoring.
8. The local stack runs the edge runtime.

---

## 18. Implementation (2026-10-16)

### 18.1 Owner decisions

The owner answered the open decisions on 2026-10-16 and asked for implementation: *"Apply these decisions to the Phase 3 plan and proceed to implementation."*

| # | Decision |
|---|---|
| Q-008 | Burn after download is a Pro feature at paid launch. During beta and testing, Free burn is controlled by the existing runtime flag `free_burn_after_download`. No payment or Pro infrastructure in Phase 3; the entitlement stays `features.burnAfterDownload`. Production may keep Free burn off until the paid-plan and beta decision. |
| D-1 | (a) One deletion executor, the storage janitor. Request-path deletion and tombstoning are removed once the janitor runs. Access still ends at once through database and request checks; the outbox stays the durable record; active shares are never deleted. |
| D-2 | (a) Hold. Blocked (takedown) objects are put on legal hold, with a reason, a janitor guard, a purge exclusion and an operator release. No admin console. The final legal retention policy stays an operational and legal responsibility. |
| D-3 | (a) Shares with abuse reports are never purged automatically until the evidence-retention policy is decided. |
| D-4 | P3-00 first. Use the Edge Function if the egress refresh fits safely; otherwise a scheduled GitHub Actions job running the existing processing. No Cloudflare Worker unless both are unsuitable. |
| D-5 | External uptime monitor → `GET /api/v1/health/cron` → email. No internal alerting. Alerts are not claimed to work until a monitor is configured. |
| D-6 | (a) Grace is capped at `expires_at`, using the database `now()`. |
| D-7 | Allowed. The verified creator may download their claimed share until it is consumed. A creator using their own link-viewer session is a link viewer and follows the claimant rules. |
| D-8 | `aws4fetch` and `postgres`, pinned Deno `npm:` imports, subject to P3-00. Not the AWS SDK. |
| D-9 | Keep suspended anonymous users: cleanup never deletes them. |

Q-013 and Q-022 stay open.

### 18.2 P3-00: Edge runtime spike

Run on 2026-10-16 on the local stack (Windows 11, Docker Desktop 29.4.2, Supabase CLI 2.117.0) with a throwaway function, deleted afterwards. Hosted Supabase was not measured: there is no hosted project (Phase 0 owner items), so every number below is **local** and must be measured again on staging.

| Question | Result |
|---|---|
| Runtime | `supabase-edge-runtime-1.74.3` (Deno 2.1.4 compatible, V8 11.6). The CLI's main service gives each function worker **256 MB**, a **1 s soft and 2 s hard CPU limit**, and a **400 s wall clock** (`SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC` unset), the same numbers as the hosted limits page. |
| CPU enforcement | Enforced. A 0.5 s busy loop returns 200; 1.5 s returns 503 after the soft limit; 2.5 s and 4 s return `546 WORKER_LIMIT` at the hard limit. Under the `per_worker` policy CPU accumulates per worker: after the 1 s soft limit the worker finishes its current request and is retired ("early termination"), so the next request gets a new worker. |
| CPU per storage call | `process.cpuUsage()` is not implemented in this runtime (it returns 0 and logs a warning), so CPU was bounded from the limit events: six back-to-back runs of 400 tombstone PUTs and 400 DELETEs (800 calls each) all returned 200, and the soft limit was reached about every second run. That is roughly **0.6 ms of CPU per signed S3 call** (aws4fetch, Web Crypto). |
| Wall time | 100 tombstone PUTs 755–810 ms and 100 DELETEs 242–335 ms at concurrency 8; 400 + 400 took 1.25–1.8 s + 0.46–0.59 s |
| Batch sizing | Claim batches of 100, concurrency 8, at most **500 rows per invocation** (about 1,000 calls, about 0.6 s CPU: under the soft limit), and a 100 s time budget. Larger backlogs drain over several invocations, one a minute. |
| `EdgeRuntime.waitUntil` | Works locally: the function answered `202` in 0.17 s and the background task wrote to the database 3 s later |
| Packages (D-8) | `npm:aws4fetch@1.0.20` (MIT, no dependencies, published 2024-08-28) and `npm:postgres@3.4.9` (Unlicense, no dependencies, published 2026-04-05) resolve and work inside the container. The bundle-size limit (20 MB) applies at deploy and was not measured (staging). |
| Database from a function | `postgresql://…@db:5432/postgres` works (the `db` alias on `supabase_network_local-saver`) |
| Storage from a function | RustFS runs outside the Supabase network. `host.docker.internal:9000` works on Docker Desktop, but the CLI sets no `ExtraHosts`, so it would fail on CI's Linux runner. Instead `pnpm stack:start` connects the RustFS container to `supabase_network_local-saver` with the alias `local-saver-s3`, and functions use `http://local-saver-s3:9000` (works). |
| pg_net → function | `net.http_post('http://kong:8000/functions/v1/<name>', …)` from the database reaches the function through Kong (200). Responses appear in `net._http_response`; the request queue empties. |
| Vault | `vault.create_secret` and `vault.decrypted_secrets` work on the local stack |
| Injected secrets (C-4, R3-2) | Every function receives `SUPABASE_URL`, `SUPABASE_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEYS`, `SUPABASE_ANON_KEY`, `SUPABASE_PUBLISHABLE_KEYS` and `SUPABASE_JWKS`. Confirmed: a compromised function could read them. |
| RustFS behaviours | ListObjectsV2, DeleteObjects, ListMultipartUploads, CreateMultipartUpload and AbortMultipartUpload work. Deleting a missing key returns 204. **Deleting during a streaming GET:** a 64 MB download in progress completed in full; HEAD and new GETs then returned 404. R2 is still SP-02. The janitor uses single `DeleteObject` calls only (RISK-011). |
| Egress refresh (D-4) | The existing processing (`scripts/load-egress-ranges.cjs`: ipaddr.js parsing and the BigInt merge) was timed on the real lists downloaded 2026-10-16: Apple 285,091 ranges (12 MB) → 14,068 rows; Tor 1,214 lines → 646 rows. **3.8–4.4 s of CPU per run in Node 22**, with the heap peaking at 230 MB. The same V8 engine runs Edge Functions, so it would hit the enforced 2 s hard limit about twice over, close to the 256 MB memory limit. **It does not fit.** |

**Issues found and how they are resolved:**

1. The egress refresh can't run as an Edge Function. Per D-4 it runs as a **scheduled GitHub Actions workflow** running the existing script unchanged in its parsing and merging (§18.3). No Cloudflare Worker.
2. CPU accumulates per worker. Each invocation is capped at 500 rows, and the janitor does no CPU-heavy work (no XML library, no hashing beyond request signing).
3. `process.cpuUsage()` doesn't work, so the janitor records wall time and counts, not CPU. CPU on staging is read from the platform's function metrics.
4. Storage reachability is solved with the Docker network alias, not `host.docker.internal`.

### 18.3 What was built

**Status: CODE COMPLETE / NEEDS REVIEW.** Everything below is implemented and tested on the local stack only. Staging, real devices and production are pending (§18.10).

| Area | Built | Where |
|---|---|---|
| Storage janitor (D-1) | The one deletion executor. The Edge Function `storage-janitor`:<br>• checks a shared secret in constant time (current and previous), then requires an exact body (`{"mode":"delete"}` or `{"mode":"reconcile"}`);<br>• answers `202` and works in the background (`EdgeRuntime.waitUntil`);<br>• connects as `app_janitor` through `JANITOR_DATABASE_URL` and never reads the injected `SUPABASE_*` secrets (C-4);<br>• signs storage calls with aws4fetch.<br>A runtime-agnostic core shared by Deno and Vitest (C-2) sets the pace: batches of 100, 8 in flight, at most 500 rows per invocation (P3-00), a 100 s budget. It also does the dry run, a third key check, backoff and logs. | `supabase/functions/storage-janitor/`, `supabase/functions/_shared/{janitor-core,s3-fetch}.ts` |
| Guard rails | In SQL, at claim time: the generated key format, no open share using the key, not on legal hold. Refused rows are parked for a day with `guard:<reason>`, returned without their key, and logged at error level. | `app.janitor_claim_deletions` |
| Trigger and Vault | `trigger-storage-janitor` runs every minute. It posts through pg_net only when rows are due and the switch is on, reading the URL and secret from Vault by name. A missing secret is recorded as a failed heartbeat. | `app.trigger_storage_janitor`, `supabase/seed.sql` (local values) |
| Request-path deletion removed (D-1) | Removed:<br>• `executePendingDeletions` and `sweepDueDeletions`;<br>• the web tier's `deleteObject` and `putTombstone`;<br>• `app_server`'s grant on `claim_object_deletions`.<br>Access still ends at once. | `lib/server/shares/{end,complete}.ts`, `lib/server/storage/s3.ts` |
| Legal hold (D-2) | `end_share('blocked')` and `admin_block_share` hold every open outbox row of the share, also when it had already ended. The janitor never deletes held rows. It copies each held object to `hold/<key>`, which no R2 lifecycle rule covers (§18.13). `admin_release_hold` (operators only, audited) releases them, and the janitor then deletes the original and the copy. | Janitor migration, [takedown runbook](../runbooks/takedown.md) |
| Retention (D-3) | `purge-tombstones` deletes:<br>• ended shares after `metadata_purge_after`, with cascades;<br>• downloads and audit events on their own dates;<br>• completed outbox rows after 30 days.<br>It never deletes:<br>• shares with an open or held outbox row;<br>• shares reported directly or through a link, their downloads, and audit events about them;<br>• `admin.*` and `report.*` events. | `app.purge_tombstones` |
| Anonymous-user cleanup (D-9) | Deletes a user only if they are anonymous, 30 days old and 30 days inactive (sign-in, session refresh, device), have nothing open (shares, claims, reservations, stored bytes), and are **not suspended**. The deletion cascades to devices, presence, flags, keys and Auth sessions, and removes their empty ledger row. | `app.cleanup_anonymous_users` |
| Storage reconciliation | **Daily ledger recount:** lock the row, then recount in new statements, which is race-free. Drift above max(1 MiB, 0.1 %) is audited and reported.<br>**Weekly bucket reconciliation** (janitor reconcile mode):<br>• a saved cursor;<br>• orphans older than 48 hours are queued, never deleted directly;<br>• unknown keys are only counted;<br>• missing objects are marked;<br>• multipart uploads are reported and stale ones aborted (C-5). | `app.reconcile_storage_usage`, `app.janitor_reconcile_*` |
| Burn after download | Claim columns and checks. `claim_burn_share`:<br>• one conditional UPDATE, with READ COMMITTED enforced;<br>• at most 3 issuances per file or text;<br>• grace `least(15 min + 1 s/MiB, 6 h)`, capped at `expires_at` (D-6).<br>Also:<br>• confirm-received and the finalize job;<br>• a 5-minute deletion margin for consumed shares;<br>• no previews, text only through Reveal, and a claim needs `confirm: true`;<br>• claimants are a device (user and device) or a link session; the creator never claims and may download until consumed (D-7). | Burn migration, `lib/server/shares/{burn,download,read,dto}.ts`, `lib/server/links/{grants,viewer,unlock}.ts`, `lib/server/local/visibility.ts` |
| Burn gate (Q-008) | Allowed by `features.burnAfterDownload`, or on the Free plan while `free_burn_after_download` is on (default off). Kill switch: `burn_after_download_enabled`. Checked at creation only, and the share's snapshot records the grant. | `lib/server/shares/burn.ts` |
| Egress refresh (D-4) | P3-00 found the merge too heavy for an Edge Function. A daily GitHub Actions workflow runs the existing script instead, with parsing and merging unchanged. It connects as the least-privilege `app_egress_loader` and writes through `app.replace_egress_ranges`. Off until an environment exists. | `.github/workflows/refresh-egress-ranges.yml`, `scripts/load-egress-ranges.cjs` |
| Job health (D-5) | Every Phase 3 job runs through `app.run_job`, which records a heartbeat on success and on failure. `GET /api/v1/health/cron` returns `app.cron_health` for an external uptime monitor: state words only, 503 when degraded. No internal alerting. | `app.cron_health`, `lib/server/jobs/health.ts` |
| UI | **Composer:** the toggle, shown only when `/me/entitlements` allows.<br>**Share card and share page:** badge, confirmation, Reveal, the claimant's state, "I've got it", "already downloaded".<br>**Share-link dialog:** a warning for burn shares.<br>Revealed text is kept in component state only. | `components/burn/*`, `components/local/{composer,share-card,use-share-actions}.tsx`, `components/share/{shared-view,share-link-dialog,copy}.tsx` |
| Local stack | `pnpm stack:start` runs the edge runtime, writes `supabase/functions/.env` (git-ignored, local-only values), and attaches RustFS to the Supabase Docker network. `seed.sql` sets the role logins and the Vault secrets. | `scripts/local-stack.cjs`, `package.json`, `supabase/config.toml` |
| Runbooks | **New:** `janitor`, `cron`, `incident`, `secret-rotation`, `restore-drill`, `monitoring` (D-5).<br>**Updated:** `takedown`, `kill-switches`, `egress-lists`.<br>Plus the [manual procedure](phase-3-manual-verification.md). | `project-docs-workthrough/runbooks/` |

### 18.4 Database changes

Three migrations: `20261016120000_phase3_janitor.sql`, `20261016120100_phase3_burn.sql` and `20261016120200_phase3_retention.sql`. The types in `lib/server/db/types.gen.ts` are regenerated.

| Kind | Change |
|---|---|
| Columns | **`shares`:** `claimed_at`, `claimed_by_user_id`, `claimed_device_id`, `claimed_link_session_hash` (32 bytes), `claimed_link_id`, `claim_grace_until`.<br>**`object_deletions`:** `last_attempt_at`, `legal_hold`, `hold_reason`, `hold_copy` (§18.13).<br>**`files`:** `object_missing_at`. |
| Checks | **New:**<br>• `shares_claim_columns`: no claim on unclaimed open shares;<br>• `shares_claim_complete`: exactly one claimant kind;<br>• `shares_claim_grace`: grace ≤ 6 h and ≤ `expires_at`;<br>• `shares_consumed_requires_burn`;<br>• `object_deletions_hold`.<br>**Widened:**<br>• `downloads.event` gains `burn_claimed`, `burn_retry` and `text_revealed`;<br>• `object_deletions.reason` gains `orphan`. |
| Indexes | `shares_claim_grace_idx`, `object_deletions_completed_idx`, `object_deletions_open_file_idx`, `files_object_missing_idx`, and a unique index allowing one running reconcile run at a time |
| Tables | `app.job_heartbeats` (app_server: SELECT only) and `app.storage_reconcile_runs` (no app access). RLS on both. |
| Roles | `app_janitor` and `app_egress_loader`: NOLOGIN in migrations, no table privileges. Logins are set per environment (`seed.sql` locally). |
| Functions for app_server | `claim_burn_share`, `confirm_burn_received`, `burn_grace`, `cron_health`. Revoked: `claim_object_deletions`. |
| Functions for app_janitor (definer) | `janitor_begin_run`, `janitor_claim_deletions`, `janitor_finish_deletion`, `janitor_claim_hold_copies`, `janitor_finish_hold_copy` (§18.13), `janitor_record_run`, `janitor_reconcile_claim`, `janitor_reconcile_page`, `janitor_reconcile_note`, `janitor_reconcile_release` |
| Function for app_egress_loader (definer) | `replace_egress_ranges` |
| Jobs and operators (granted to nobody) | `run_job`, `record_job_run`, `job_started`, `finalize_claims`, `purge_tombstones`, `cleanup_anonymous_users`, `reconcile_storage_usage`, `trigger_storage_janitor`, `start_storage_reconcile`, `hold_share_objects`, `admin_release_hold` |
| Changed | **`end_share`:** a 5-minute margin for `consumed`; a hold for `blocked`.<br>**`admin_block_share`:** holds open rows and reports `legalHold` and `holdCopy`. |
| Cron | • `trigger-storage-janitor` and `finalize-burn-claims`: every minute<br>• `cron-heartbeat`: `2-59/5`<br>• `purge-tombstones`: 03:03<br>• `cleanup-anonymous-users`: 03:33<br>• `reconcile-storage-usage`: 04:04<br>• `reconcile-r2-orphans`: Sunday 05:06 |
| Flags | `storage_janitor_enabled`, `burn_after_download_enabled` (on), `free_burn_after_download` (**off**), `janitor_daily_volume_alert` (10,000), `cron_heartbeat` |

### 18.5 API changes

| Endpoint | Change |
|---|---|
| `POST /api/v1/shares`, `POST /api/v1/texts` | Accept `burnAfterDownload?: boolean`. New errors: `403 FEATURE_NOT_IN_PLAN` (`details: { feature, requiredPlan: "pro" }`) and `503 BURN_AFTER_DOWNLOAD_DISABLED`. |
| `POST /api/v1/files/{id}/download-url`, `POST /api/v1/links/{id}/files/{id}/download-url` | Body `{ confirm?: true }`. For a burn share and anyone but the creator:<br>• without confirm: `409 CONFIRMATION_REQUIRED`;<br>• the first call claims the share;<br>• the claimant gets 3 URLs per file (`burn: { availableUntil, left }`), then `409 BURN_RETRY_LIMIT`;<br>• everyone else gets `410 ALREADY_DOWNLOADED` (`details.byYou`). |
| Preview URLs | `422 PREVIEW_UNAVAILABLE` for burn shares, the creator included |
| `POST /api/v1/shares/{id}/reveal`, `POST /api/v1/links/{id}/reveal` **(new)** | `{ confirm: true }` returns `{ text: { content }, burn: { availableUntil, left } }`. The creator reads without claiming. Without confirm: `409`. |
| `POST /api/v1/shares/{id}/confirm-received`, `POST /api/v1/links/{id}/confirm-received` **(new)** | The claimant consumes the share: `204`, also when repeated. Anyone else: `404`. |
| `GET /api/v1/me/entitlements` **(new)** | `{ plan: "free", features: { burnAfterDownload } }`. Limited to 60 a minute per device. |
| `GET /api/v1/health/cron` **(new)** | `{ status, checks }`, 200 or 503, `no-store`, no caller identity needed |
| Share DTOs and viewer content | Status `claimed` is new. `burn: { claimed, byYou, availableUntil, textHidden, revealsLeft }` and `files[].downloadsLeft` appear **only on burn shares**: every other share keeps the Phase 1–2 shape. |
| Feeds | **Local feed:** also lists shares this device claimed, during grace.<br>**My uploads:** also lists claimed shares, during grace. |
| Detail, unlock, viewer content | A burn share claimed by someone else, or consumed, answers `410 ALREADY_DOWNLOADED` to callers who could have seen it. Everyone else still gets `404`. |
| Link creation | `410 ALREADY_DOWNLOADED` on a claimed share |
| Reports | Allowed on a claimed share by those who still see it (the claimant and the creator) |
| Text edit | `404` for burn texts |

### 18.6 UI changes

All burn copy is in `components/burn/copy.ts`.

**Defined in the docs, used as written** (marked DEFINED):
- *"This will be deleted after you open it."*
- **Reveal**
- *"The first person on this network to open it gets it"*

**Provisional, for owner review** (marked OWNER REVIEW):
- the toggle label and the Link-only line;
- the badge;
- the confirmation title and buttons, and the grace-loss warning;
- the claimant's lines: "Yours until …", downloads left, views left, "I've got it";
- the creator's "Opened…" line;
- both "already downloaded" texts (card and share page) and the retry-limit text;
- the link-dialog warning;
- the burn errors at posting.

AC-3.8 needs the owner's review of every provisional string.

### 18.7 Deviations from the plan

| # | Plan | As built | Why |
|---|---|---|---|
| DV3-1 | Egress refresh as an Edge Function or the P3-00 fallback, with a shared `egress-merge.ts` | GitHub Actions runs the script unchanged. There is no `egress-merge.ts` and no pg_cron job for it. | P3-00 measured about 4 s of CPU against a 2 s limit (D-4). The fallback keeps the existing processing exactly. |
| DV3-2 | `claimed_link_id` references `share_links` ON DELETE SET NULL | A plain checked text column | Links cascade from shares, so a SET NULL on the row being deleted would be a cyclic cascade |
| DV3-3 | Claim columns only on `claimed` or `consumed` shares | Allowed on any ended share | A claimed share that is deleted or blocked keeps its claim for audit. Found by the pgTAP suite. |
| DV3-4 | — | **A cancelled upload's URL can still store bytes until the janitor's next run**, about a minute. Those bytes are never reachable, because the file is rejected. The janitor then tombstones the key until the URL expires. | A consequence of D-1: Phase 1 tombstoned the key during the request. Tested. Recorded as the new risk RISK-034. |
| DV3-5 | Reveal without confirm: not specified | `409 CONFIRMATION_REQUIRED`, like download-url | Consistency |
| DV3-6 | 03 §4: after the secret, a consumed share's link answers `410 LINK_EXPIRED` | `410 ALREADY_DOWNLOADED` with `byYou` | As planned in §17.8.4. 03 is updated. |
| DV3-7 | — | The creator can't edit a burn text (`404`) or make new links once it's claimed (`410`) | Someone may already be reading it, and a claimed share is already gone for everyone else |
| DV3-8 | D-3: keep reported shares | Also keeps their download records, the audit events about them, and every `admin.*` and `report.*` event | D-3 says "Do not delete evidence merely because the normal retention period has passed" |
| DV3-9 | Phase 1–2 tests unchanged | Some Phase 1–2 tests changed. None lost an assertion (details below the table). | D-1, and the least-privilege job tables |
| DV3-10 | Health checks: heartbeat … egressLists | Two more: `jobs` (a job whose last run failed) and `database` (unreachable) | A failing job must alert (D-5) |
| DV3-11 | Daily ledger reconciliation over every subject | At most 1,000 subjects per run, in one transaction, with a rotating cursor | Keeps locking bounded, and is enough at beta scale. Revisit if there are more than about 1,000 subjects. |
| DV3-12 | A failing job raises an error | `app.run_job` records the failure in its heartbeat and raises a warning, so `cron.job_run_details` shows success | Otherwise the heartbeat write would be rolled back along with the job |
| DV3-13 | T3-12: a scanner runs the page for 60 s | 5 s in E2E, plus the API-level check | Keeps the suite fast. The page polls every 30 s and never claims on its own. |
| DV3-14 | The local stack reaches RustFS at `host.docker.internal` | RustFS joins the Supabase Docker network as `local-saver-s3` | P3-00: Linux CI has no host alias |
| DV3-15 | D-2: held objects stay put until an operator releases them | The janitor copies each held object to `hold/<key>`, deletes neither while held, and deletes both after the release. Copies are made in dry runs too. | The security review (§18.13) found that R2's lifecycle rules would delete held objects at their class period + 1 day after upload. The copy uses the janitor's existing token and invents no retention period. |

**DV3-9 in detail:**

- **Phase 1 pgTAP:**
  - "app_server has DML on every app table" now excludes the two job tables. The Phase 3 suite pins their exact privileges instead.
  - "app_server can claim storage deletions" is inverted (D-1).
  - The tombstone-rule checks run as the owner, with every assertion kept.
- **Phase 1 integration:** the deletion and tombstone tests run the janitor before checking storage, with every assertion kept, plus one new race test.
- **Phase 2 authorization matrix:** six new routes. The health row may accept 200 or 503, and every caller must get the same answer.

### 18.8 Tests

Run on 2026-10-16 on the local stack: Windows 11, Docker Desktop, Supabase CLI 2.117.0, edge runtime 1.74.3, RustFS 1.0.1.

| Suite | Count (Phase 2 → now) | New in Phase 3 |
|---|---|---|
| Unit and component (Vitest) | 307 → 376 | • janitor core: 28<br>• S3 fetch adapter: 10<br>• burn visibility: 10<br>• burn UI: 15<br>• injected-secret scan: 5<br>• lifecycle config: 1 (§18.13) |
| Database (pgTAP) | 189 → 421 | • `phase3_burn`: 74<br>• `phase3_janitor`: 89<br>• `phase3_retention`: 69 |
| API integration (real `next start`, the real Edge Function, RustFS) | 140 → 195 | • `burn-concurrency`: 7<br>• `burn`: 17<br>• `janitor`: 14<br>• `retention`: 5<br>• `cron-health`: 4<br>• the egress loader under its role: 1<br>• the uploads race test: 1<br>• six matrix rows |
| E2E (Playwright) | 39 → 45 | • `local-burn`: 4<br>• the phone layout of the burn confirmation (WebKit and Chromium): 2 |

**Mandatory concurrency (T-037, AC-3.1):**

| Check | Result |
|---|---|
| SQL level: 50 `app_server` connections released together by an advisory-lock barrier, 20 rounds | Every round: exactly 1 `claimed`, 49 `already_downloaded`, 1 `burn_claimed` row |
| API level: 50 devices on one network | 1 × 200 and 49 × `410 ALREADY_DOWNLOADED` |
| API level, mixed: 25 devices and 25 link viewers | Exactly one winner |
| The claimant's own 10 parallel retries (T3-01) | Exactly 3 URLs |
| Mutation check: `status = 'active'` removed from the claim | More than one winner, at both levels. The restored function gives one winner again. |
| Isolation | REPEATABLE READ and SERIALIZABLE are refused (`25001`) |

**Other mutation checks:**
- Removing the open-share guard fails the janitor suite.
- Removing the suspended-user rule fails the cleanup suite (D-9).
- From the security review (§18.13):
  - a lifecycle rule on `hold/` fails the lifecycle-config test;
  - reading `SUPABASE_DB_URL` fails the static scan;
  - connecting with it fails the blocked-`app_janitor` test.

**Required behaviours and their tests:**

| Behaviour | Tests |
|---|---|
| Janitor stopped | `janitor` T3-05 |
| R2 failure, retry and backoff | `janitor` T3-02 and T3-06 (fault proxy: 503 and a dropped connection), pgTAP backoff |
| Tombstones | `uploads` (rewritten), `janitor` T3-03, pgTAP |
| Active-share and claimed-share protection | `janitor` T-043, pgTAP `share_open` (both active and claimed) |
| Orphan reconciliation | `janitor` T-044, T3-08, T3-09 (cursor across invocations), pgTAP |
| Retention | `retention`, pgTAP purge |
| Suspended-user cleanup | `retention`, pgTAP (D-9) |
| Abuse-report retention | `retention`, pgTAP (D-3) |
| Legal hold | `janitor`, pgTAP (D-2). The copy out of the lifecycle rules' reach: `janitor` (the real function; the original deleted as R2 would), pgTAP, unit, the lifecycle-config test (§18.13) |
| Egress refresh | `egress-loader` under `app_egress_loader`, pgTAP `replace_egress_ranges` |
| Cron health | `cron-health` (T3-07), pgTAP `cron_health` |
| Burn expiry | `burn`: grace capped at expiry, nothing served after it |
| Creator exemption | `burn` T-039, pgTAP, E2E |
| Link-viewer claimant | `burn`, `burn-concurrency` (mixed), E2E |
| Unfurlers and scanners | `burn`, E2E |
| Duplicate confirmation | `burn` (device and viewer: `204` twice), pgTAP |
| Download URL limits | `burn` (3 per file, the retry limit), `burn-concurrency` T3-01 |

### 18.9 Acceptance criteria status

The levels used below:
- **Implemented:** built, in the code.
- **Locally tested:** automated and green on the local stack.
- **Staging pending:** needs staging, R2 and real operations.
- **Real-device pending:** needs the manual run on real phones.
- **Production pending:** can be checked only in production.

| AC | Implemented | Locally tested | Pending |
|---|---|---|---|
| AC-3.1: 50 claims, retries, creator, text | Yes | Yes: T-037 at SQL and API level, mixed claimants, the mutation check; T-038, T-039, T-040, T3-01 | Real-device: manual §3 |
| AC-3.2: deletion within 5 min at p95 | Yes | A local indication only: end to end, a due row was deleted 4 s after it was queued | Staging: the 7-day soak |
| AC-3.3: guard rails, orphans | Yes | Yes (T-043, T-044) | Staging: the 24-hour dry run |
| AC-3.4: user cleanup, purge | Yes | Yes: T-045, the purge pgTAP and integration tests | — |
| AC-3.5: daily reconciliation with zero drift | Yes | Yes: pgTAP and the race test | Staging: the 7-day soak |
| AC-3.6: access stays denied with the janitor or cron stopped; alerts fire | Yes (the health endpoint) | Yes (T3-05, T3-06, T3-07) | Staging: the chaos tests, which need **a configured monitor and a recipient (neither exists yet)** |
| AC-3.7: runbooks, restore drill | Runbooks written | Link check | Staging: the drill, with a measured RTO |
| AC-3.8: copy reviewed; unfurlers never claim | Yes | Yes (API and E2E) | Owner: the copy review (§18.6) |
| AC-3.9: beta-gate items | Partly: kill switches, health, runbooks | — | Monitor and alerts, kill switches tested in production, a named on-call (Q-022), backups verified |
| AC-3.10: docs | Yes (§18.12) | Link check | Owner review |

**Not claimed:**
- **Alerts are not operational:** no monitor is configured and no recipient is named (D-5).
- **Nothing is VERIFIED:** Phase 2 is still NEEDS REVIEW and there is no staging.

### 18.10 Remaining requirements and risks

**Remaining before VERIFIED:**

| Kind | Items |
|---|---|
| Staging and infrastructure | • Hosted Supabase staging with backups<br>• An R2 bucket, its lifecycle rules and a janitor token<br>• The janitor deployment and its secrets ([janitor](../runbooks/janitor.md) §2)<br>• The egress workflow's environments<br>• An uptime monitor |
| Real devices | [Manual procedure](phase-3-manual-verification.md) §3 |
| Owner decisions | • The copy review (AC-3.8)<br>• The alert recipient and on-call (Q-022, DEC-029)<br>• Evidence retention, and the legal procedure for held objects (Q-022)<br>• The Cloudflare plan (Q-013)<br>• The beta and paid-plan decision that turns Free burn on or off |
| Production | Kill switches tested, backups verified, monitoring live |

**Risks** (the changes are in [06](../06-decisions-and-risks.md)):
- **RISK-031 (takedown evidence)** is reduced by the hold and, since the security review (§18.13), by the copy of each held object to `hold/`, which no lifecycle rule covers. Still open: proving it on real R2, the window before the copy is made, and the legal procedure (Q-022).
- **RISK-034 (new)** is the cancel window (DV3-4).
- **RISK-035 … RISK-041** are the plan's R3-1 … R3-8. R3-1 is now measured locally, and R3-8 is mitigated by D-3.

### 18.11 Final verification

The final run, after the security review's changes (§18.13), on 2026-10-16. The database was reset first, so every migration applied from scratch, and the edge runtime was restarted to load the new function code.

| Check | Result |
|---|---|
| `pnpm typecheck` | Passed |
| `pnpm lint` | Passed, 0 warnings |
| `pnpm test` (unit and component) | 376 passed (45 files) |
| `supabase test db` (pgTAP) | 421 passed |
| Generated database types | Regenerated for `object_deletions.hold_copy` |
| `pnpm build` | Passed |
| `pnpm test:integration` | 195 passed (16 files) |
| `pnpm test:e2e` | 45 passed, twice in a row, with 6 parallel workers, after the test-race fix below. Before the fix: 44 passed, 1 failed. |
| `pnpm audit --audit-level high` | Passed: no new findings. One high advisory was already marked as ignored before Phase 3, and Phase 3 adds no npm dependencies. |
| Docs link check | Passed: 0 broken links |

**The E2E test race, now fixed (test-only).**
- **Cause:**
  - `local-burn.spec.ts` turned the global `free_burn_after_download` flag on in `beforeAll` and off in `afterAll`.
  - The phone-layout burn test in `local-mobile.spec.ts`, which runs in both the WebKit and Chromium projects, turned it on and off around itself.
  - Playwright runs files and projects in parallel (`fullyParallel: true`). One run's cleanup switched the flag off while another was posting, so the post was refused with "Burn after download isn't available right now." (`403`).
  - The two files run in parallel failed 2 out of 2 times. Alone, or on one worker, the test passed.
- **Fix:**
  - `tests/e2e/support/global-setup.ts`, registered as `globalSetup` in `playwright.config.ts`, turns the flag on once before any test. The teardown it returns turns the flag back off, the shipped default.
  - The two specs no longer write the flag. They only check that it is on (`expectFreeBurnOn` in `tests/e2e/support/remote.ts`).
  - Parallelism, assertions, timeouts and production code are unchanged, with no retries or sleeps added.
- **After the fix**, with 6 workers:
  - the two files: 10/10 twice, and 30/30 with `--repeat-each=3`;
  - the full suite: 45/45 twice;
  - the flag is off again after each run.

### 18.12 Documentation changed

ARCHITECTURE.md, 02, 03, 04, 06, 07, 08, 09, the docs README, the runbooks above, and this document. The security review (§18.13) also updated ARCHITECTURE.md, 03, 04, 06, 08, the janitor, takedown, incident, secret-rotation, kill-switch and monitoring runbooks, and the manual procedure.

### 18.13 Security review (2026-10-16)

A targeted review of three risks after the implementation, done before any commit. The evidence levels below:
- **Locally verified:** seen by hand on the local stack.
- **Automated-test verified:** a test in the suites, run in §18.11.
- **Staging pending**, **real-R2 pending**, **production pending:** needs that environment. No real R2 bucket exists, so nothing here is verified on R2.

#### 1. R2 lifecycle rules against legal holds (RISK-031): a real problem, fixed

The path a held object took before the fix:

| Step | What happens |
|---|---|
| Upload | The object is created at `d7/…` (every Free share: expiries up to 7 days), `d30/…` or `d90/…` |
| Takedown | `admin_block_share` → `end_share('blocked')` → an outbox row → `hold_share_objects` sets `legal_hold` |
| Janitor | Never claims a held row for deletion, and can't finish one |
| R2 | `infra/r2/lifecycle.json` expires `d7/` at 8 days, `d30/` at 31 and `d90/` at 91, counted from the object's creation. R2 removes expired objects "typically within 24 hours". **It deletes the held object whatever the database says.** A `d7/` object taken down on day 7 had about a day left. |

- **Cause.** The hold exists only in the database. R2 applies its rules by key prefix and age, and nothing in the bucket marks an object as held.
- **What R2 offers** (Cloudflare docs, 2026-10-16):
  - lifecycle rules filter by prefix only;
  - object tagging isn't implemented, and neither is S3 Object Lock (`PutObjectLockConfiguration`);
  - bucket locks take precedence over lifecycle rules, but they are prefix rules (at most 1,000) set with a token that can edit bucket configuration.
- **Options:**
  - Bucket locks: rejected. The janitor would need an admin token (finding 2), or each takedown would need a manual step.
  - Longer lifecycle periods: rejected. Still a deadline, a weaker backstop, and an invented retention period.
  - **Copy each held object to a prefix that no rule covers: chosen.** It uses the janitor's existing token (CopyObject is part of Object Read & Write) and needs no new infrastructure.
- **The fix:**
  - `object_deletions.hold_copy`: null while the copy is still to be made; `copied`; or `unavailable` when nothing was left to copy. A tombstoned row is `unavailable` as soon as it is held.
  - Each janitor run first claims held rows with `app.janitor_claim_hold_copies`, then copies each object to `hold/<key>` on the server, keeping its stored headers.
    - Guard rail: the generated key format.
    - A row waits while an upload URL may still write to its key.
    - A failure backs off as a deletion does.
    - An error inside a 200 response counts as a failure.
    - A missing source is `unavailable` (`hold:source_missing`, logged at error level), unless an earlier attempt already made the copy.
  - `hold/` keys:
    - have no lifecycle rule (a unit test checks `infra/r2/lifecycle.json`);
    - are never a file's key;
    - are counted by reconciliation (`holdCopies`) and never queued as orphans.
  - Copies are made in dry runs too: a copy deletes nothing.
  - The cron trigger and `/health/cron` treat a held row as work until it is copied (`janitorBacklog`). Repeated copy failures show as `janitorFailures: failing`.
  - `admin_release_hold` resets the row's attempts. The deletion claim then returns `hold_copy_key`, and the janitor deletes the original and the copy.
  - Rows that were never held behave exactly as before: expiry, deletion, tombstones, burn and reconciliation.
- **Result.** A held object's copy now stays until an operator releases the hold. No retention period was added (Q-022).
- **What it doesn't cover:**
  - The window between the hold and the copy: a minute normally, but nothing is copied while `storage_janitor_enabled` is off or the janitor is down. The lifecycle margin is at least a day for a takedown before the share expires, and `janitorBacklog` alerts after an hour.
  - Objects already gone before the takedown, recorded as `unavailable`.
  - The janitor's token can delete copies (finding 2).

| Level | Evidence |
|---|---|
| Automated-test verified | **pgTAP:** 19 new assertions in `phase3_janitor` and 1 in `phase3_retention`.<br>**Unit:** the janitor core, the S3 adapter, the lifecycle config.<br>**Integration**, through the real Edge Function and RustFS:<br>• a held object is copied to `hold/` with identical bytes;<br>• the original is deleted as R2's rule would;<br>• the copy survives further janitor runs;<br>• after the release, both are deleted;<br>• a source already gone is recorded as `unavailable`.<br>All these tests failed before the fix. |
| Locally verified | RustFS CopyObject keeps the content type and cache headers, and a missing source answers `404 NoSuchKey` |
| Real-R2 pending | • R2's rules delete a `d7/` object and leave its `hold/` copy (use a short test rule on the staging bucket);<br>• CopyObject on R2. |
| Staging pending | A takedown on staging: the copy within a minute; the release deletes both ([manual procedure](phase-3-manual-verification.md) S-6) |

#### 2. The janitor's R2 token (RISK-037): an R2 limitation, documented

| Question | Finding |
|---|---|
| Which credentials | `JANITOR_S3_ACCESS_KEY_ID` and `JANITOR_S3_SECRET_ACCESS_KEY`, separate from the web tier's `R2_*`. **Locally both are the RustFS root credentials**, so the local tests say nothing about token scope. |
| Read | Every object in the bucket: Object Read & Write includes reading. The janitor itself never reads content. It calls DeleteObject, PutObject (tombstones), CopyObject, HeadObject, ListObjectsV2, ListMultipartUploads and AbortMultipartUpload. |
| Write | Any key in the bucket |
| Delete | Any object, hold copies included |
| Bucket | Only the one bucket, when the token is created with "Apply to specific buckets only" (janitor runbook §2) |
| Other buckets | None with that scope. Admin tokens are account-wide and must not be used. Staging pending: a 403 on a second bucket. |
| Narrower options | R2 has four levels: Admin Read & Write, Admin Read only, Object Read & Write and Object Read only. None is delete-only or write-only. Object Read & Write on one bucket is the narrowest that can delete.<br>**Temporary credentials** can be scoped to prefixes or objects, but something must mint them from a parent token with at least the same rights. That is new infrastructure, and every user object sits under the same few prefixes anyway.<br>**Client IP filtering** isn't practical, because Supabase Edge Functions have no static egress IPs.<br>**An expiry date on the token** enforces the 90-day rotation. |

**Least privilege is not claimed.** The token can read, overwrite and delete everything in the bucket; that is an R2 limitation. No code or configuration changed. The scope checks are staging pending ([manual procedure](phase-3-manual-verification.md) S-7).

#### 3. Supabase's injected service keys (RISK-036): a platform limitation, documented

| Question | Finding |
|---|---|
| What a worker sees | **Locally verified** (edge runtime 1.74.3, names only):<br>• `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`;<br>• `SUPABASE_SECRET_KEYS` (one `default` key) and `SUPABASE_PUBLISHABLE_KEYS`;<br>• `SUPABASE_JWKS`, `SUPABASE_FUNCTION_SLUG`, `SB_EXECUTION_ID`;<br>• `SUPABASE_DB_URL`, as user **`postgres`**;<br>• the `JANITOR_*` secrets.<br>Supabase documents the same defaults for hosted projects. Secret names can't start with `SUPABASE_`, so they can't be overridden. |
| Can the function remove them? | **No** (locally verified):<br>• `Deno.env.delete` returns without error, but the value stays;<br>• `Deno.env.set` throws `NotSupported`.<br>The runtime does block subprocesses and reading `/proc/self/environ`. |
| What the code reads | Only `JANITOR_*` names, through `readJanitorConfig` (existing test). A new static test checks that nothing else in `supabase/functions` touches the environment or names a `SUPABASE_*` or `SB_*` variable. |
| Logging | One structured logger; the configuration is never logged; errors are logged as status, code or name only. A new test checks that configuration errors name settings, never values. |
| Is the restricted role used? | Yes, automated-test verified. A new integration test blocks `app_janitor` (`connection limit 0`): the real function then processes nothing; restored, it processes the row.<br>**Mutation check:** a function switched to the injected `SUPABASE_DB_URL` deleted the object while `app_janitor` was blocked. So the test catches that change, and it shows that **a compromised function can bypass the role** with the injected credentials.<br>Locally, the injected URL's host didn't resolve from inside the worker (`ENOTFOUND`) until the mutation rewrote it. That is not a protection, and hosted wasn't measured. |
| `refresh-egress-ranges` | **Not an Edge Function** (P3-00, DV3-1). It is a GitHub Actions job with `contents: read` and one secret, `EGRESS_LOADER_DATABASE_URL` (`app_egress_loader`). No Supabase keys are injected there. The script falls back to `DATABASE_URL` when `LOADER_DATABASE_URL` is unset. That fallback predates Phase 3 and was left unchanged, since the workflow always sets `LOADER_DATABASE_URL`. |

**A platform trust boundary.** A compromised janitor (its code or a dependency) holds `postgres` database access and the service-role key. The restricted role prevents mistakes, not a compromise. The mitigations are the existing ones plus the tests above: two pinned dependencies with none of their own, the secret checked first, and no user input.

Staging pending: repeat the environment probe on the hosted function, names only ([manual procedure](phase-3-manual-verification.md) S-8).

#### Changes and checks

- **Code:**
  - `supabase/migrations/20261016120000_phase3_janitor.sql` and `…120200_phase3_retention.sql`, edited in place: they are uncommitted and have never been applied outside the local stack;
  - `supabase/functions/_shared/{janitor-core,s3-fetch}.ts`;
  - `lib/server/db/types.gen.ts`, regenerated.
- **Tests:**
  - `tests/unit/{janitor-core,s3-fetch,r2-config,functions-env}.test.ts`;
  - `supabase/tests/phase3_{janitor,retention}.test.sql`;
  - `tests/integration/janitor.test.ts` and its support module.
- **Test changes, nothing weakened:**
  - Three existing exact-equality expectations gained the new fields: the janitor run summary, the reconcile page results, and the list of janitor functions.
  - The `cron_health` fixture "held rows are not a backlog" now marks its row `copied`. A new assertion checks that an uncopied held row **is** a backlog.
- **Mutation checks** (each restored afterwards, with the files checked by hash):
  - an extra lifecycle rule on `hold/` fails the lifecycle-config tests;
  - reading `SUPABASE_DB_URL` fails the static tests;
  - connecting with it fails the role test.
- The full suite after these changes is in §18.11.
