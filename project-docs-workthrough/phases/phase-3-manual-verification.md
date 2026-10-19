# Phase 3 — Manual and staging verification procedure

| Field | Value |
|---|---|
| Purpose | Close the Phase 3 acceptance criteria that need real devices, staging or the owner ([phase 3 §13](phase-3-expiry-one-time-download.md#13-acceptance-criteria)): **AC-3.1** manual part (burn flow on real phones), **AC-3.2** (deletion latency on staging), **AC-3.3** dry-run part, **AC-3.5** (7-day soak), **AC-3.6** (chaos tests with alerts), **AC-3.7** (restore drill), **AC-3.8** (copy review), **AC-3.9** (beta-gate items) |
| Status | **BLOCKED.** Nothing here has been run. The prerequisites (§1) don't exist yet. |
| Written | 2026-10-16 |
| Who runs it | The owner, or a tester and an operator the owner names (Q-022), with a laptop, an iPhone and an Android phone |
| Rule | Record what actually happened, including failures. Emulated phones and local runs are **not** evidence for these steps. |

The automated checks that already cover parts of these criteria are listed in [phase 3 §18](phase-3-expiry-one-time-download.md#18-implementation-2026-10-16). They don't replace any step below.

---

## 1. Prerequisites

Everything in [Phase 2's prerequisites](phase-2-manual-verification.md#1-prerequisites), plus:

| # | Prerequisite | Where it's specified |
|---|---|---|
| P3-1 | A hosted Supabase **staging** project on a plan with daily backups (Q-016), with Phase 3's migrations applied | [janitor runbook](../runbooks/janitor.md) §2 |
| P3-2 | The `storage-janitor` function deployed with its secrets (`JANITOR_DRY_RUN=true` at first), the Vault secrets, `app_janitor` login, and a janitor R2 token | [janitor runbook](../runbooks/janitor.md) §2 |
| P3-3 | The R2 lifecycle rules applied to the staging bucket (`infra/r2/lifecycle.json`) | SP-02 |
| P3-4 | An external uptime monitor on `/api/v1/health/cron` emailing **[OWNER: alert email]** | [monitoring runbook](../runbooks/monitoring.md) §2 |
| P3-5 | The egress refresh workflow enabled for staging (`EGRESS_REFRESH_ENABLED`, `EGRESS_LOADER_DATABASE_URL`) | [egress lists runbook](../runbooks/egress-lists.md) |
| P3-6 | `free_burn_after_download` on in staging only, for the burn steps (Q-008: Free burn is a beta and testing flag) | [kill switches](../runbooks/kill-switches.md) |
| P3-7 | A named operator for the chaos and restore steps | Q-022 |

## 2. Recording sheet

- Copy into `evidence/phase-3/manual-matrix.md`, one row per step and device. Screenshots go under `evidence/phase-3/manual/`.
- Never record IP addresses, link secrets, share codes or object keys in the evidence.

| Date | Step | Device / OS / browser (version) | Network type | Expected | Observed | Pass? | Notes |
|---|---|---|---|---|---|---|---|

## 3. Burn after download on real phones (AC-3.1 manual, 09 §8 scenario 8)

**A** = laptop on Wi-Fi 1, posting. **B** = iPhone and **C** = Android phone, both on Wi-Fi 1. **D** = either phone on mobile data, for the link steps.

| Step | Action | Expected |
|---|---|---|
| B-1 | On A, choose Files, tick the burn toggle, pick a PDF, share to this network | The line *"The first person on this network to open it gets it"* shows before posting. B and C both see the card with the burn badge and no preview. |
| B-2 | On B, tap Download | A confirmation: *"This will be deleted after you open it."* and the grace warning. Nothing downloads yet. |
| B-3 | On B, confirm | The file downloads (iOS may open it in a viewer; note what happens). B's card shows "2 downloads left" and the "I've got it" button. |
| B-4 | On C | The card disappears within seconds. If C reopens an old tab, it says someone else already downloaded it. |
| B-5 | On B, simulate a failed save (cancel the save sheet), tap Download again | No second confirmation; it downloads; "1 download left". |
| B-6 | On B, tap "I've got it" | The card goes. A's My uploads no longer lists it. |
| B-7 | On A, post burn text. On C, tap Reveal, confirm | The text shows on C only. Closing and reopening the app on C does **not** show it again without another Reveal (3 at most). |
| B-8 | On A, post a burn file as Link only, create a link, send it to D | D opens it on mobile data, downloads after confirming. A second phone opening the same link sees the "already downloaded" state. |
| B-9 | On A, open the link from B-8 in a browser on A itself (the creator) | Note: the creator's browser is a link viewer and would claim it (R3-4). Check the share-link dialog warned about this. |
| B-10 | Paste a burn link into Slack, WhatsApp and iMessage, and let them unfurl | The share stays unclaimed (check the share's status with the operator query in [janitor](../runbooks/janitor.md) §3, or that a later viewer can still download). |

## 4. Staging: janitor go-live and soak

| Step | Action | Expected / record |
|---|---|---|
| S-1 | With `JANITOR_DRY_RUN=true`, run normal traffic for 24 hours (AC-3.3) | `janitor.would_delete` lines match due outbox rows; **no** `janitor.guard_refused` |
| S-2 | Set `JANITOR_DRY_RUN=false`, redeploy | Due rows complete within minutes |
| S-3 | Soak for 7 days with daily traffic (AC-3.2, AC-3.5) | Daily: the p95 query in [janitor](../runbooks/janitor.md) §3 is under 300 s; no open row older than 1 hour; `reconcile-storage-usage` shows `drift: 0`; the weekly reconcile finishes; egress lists refresh daily |
| S-4 | Measure CPU and wall time of janitor invocations in the Supabase function metrics | Record them in phase 3 §18.2. Compare with the local P3-00 numbers; adjust batch sizes if needed. |
| S-5 | On R2, delete an object while its 64 MB download is streaming | Record whether the download completes (SP-02; it did on RustFS) |
| S-6 | **Legal-hold copies on real R2** (RISK-031). Add a temporary rule expiring `d7/` objects after 1 day. Upload a file and block its share; after a minute, check `hold/<key>` exists with the same size. Wait 2 days, then release the hold and remove the temporary rule. | The original is gone and the `hold/` copy is still there after 2 days. After the release, the janitor deletes the copy. Record the dates. |
| S-7 | **Janitor token scope** (RISK-037): with the janitor's token, list another bucket in the account, and try an admin call (list buckets) | Both answer 403. Then confirm DeleteObject, PutObject, CopyObject, HeadObject and ListObjectsV2 work in its own bucket. |
| S-8 | **Injected variables on the hosted function** (RISK-036): deploy a throwaway function that returns only the names in `Deno.env.toObject()`; try `Deno.env.delete`. Delete the function afterwards. | Record the names (never values). Expected: the `SUPABASE_*` defaults are present and can't be removed. |

## 5. Staging: chaos (AC-3.6)

| Step | Action | Expected |
|---|---|---|
| C-1 | `storage_janitor_enabled` off; delete a share; wait 10 minutes | The share's content is inaccessible at once; its object stays in R2. Once rows have been due over an hour, `/health/cron` reports `janitorBacklog` and the monitor emails. Switch on: the object goes within minutes. |
| C-2 | Pause pg_cron's `cron-heartbeat` and `expire-shares` (`cron.alter_job(…, active := false)`); let a share expire | The expired share is refused at once (404). After about 10 minutes `/health/cron` answers 503 with `heartbeat: stale` and **the alert email arrives**. Re-enable both and catch up ([cron](../runbooks/cron.md) §3). |
| C-3 | Make the janitor's R2 token invalid (revoke it) for 30 minutes | Rows back off (1 min, 5 min, 30 min…); `janitorFailures` shows after 5 failures; restore the token ([secret rotation](../runbooks/secret-rotation.md#r2-tokens)) and watch them complete |
| C-4 | Test each kill switch in production once before the public beta (AC-3.9) | Each behaves as [kill switches](../runbooks/kill-switches.md) says |

## 6. Restore drill (AC-3.7)

Follow the [restore drill runbook](../runbooks/restore-drill.md) on staging, and record the measured RTO and RPO.

## 7. Copy review (AC-3.8)

The owner reviews every string marked **OWNER REVIEW** in `components/burn/copy.ts`, and the burn states in `components/share/copy.ts`, `components/local/composer.tsx` and `lib/client/uploader.ts`. Approved changes are made in code. Only the three **DEFINED** strings come from the docs.
