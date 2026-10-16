# Runbook — Job health monitoring and alerts

| Field | Value |
|---|---|
| Applies from | Phase 3 (2026-10-16), owner decision D-5 |
| Design | An external uptime monitor polls `GET /api/v1/health/cron` and emails when it answers anything but 200. The app builds no email, Slack or pager integration. |
| Alert recipient | **[OWNER: alert email address and the person who answers it, Q-022 / DEC-029]** |
| Status | **Not operational.** No monitor is configured and no recipient is named. Until both exist, **nothing alerts**: failures show only on the health endpoint and in logs. |

## 1. The endpoint

- `GET https://<app origin>/api/v1/health/cron`. No authentication, `Cache-Control: no-store`, behind Cloudflare like the rest of the app.
- It answers **200** with `{"status":"ok","checks":{…}}` when every check is fine, and **503** with `"status":"degraded"` when any check is not.
- The body has state words only: no counts, keys or IDs.
- It reads one SQL function, `app.cron_health`, which the app role may call.
- If the database can't be reached, it answers 503 with `checks: { database: "error" }`.

| Check | Fails as | Means | First step |
|---|---|---|---|
| `heartbeat` | `stale` (no `cron-heartbeat` for 10 min), `missing` | pg_cron isn't running jobs | [cron](cron.md) §3 |
| `janitorBacklog` | `backlog` (> 1,000 due or one due > 1 h), `stalled` (rows due, no janitor run for 5 min). Held rows count until their legal-hold copy is made. | Storage isn't being reclaimed, or a takedown's objects aren't copied out of the lifecycle rules' reach | [janitor](janitor.md) §4 and §6 |
| `janitorFailures` | `guard_refused`, `failing` (a row failed 5 times) | A guard rail stopped a deletion (a bug), or R2 keeps failing | [janitor](janitor.md) §4 steps 2–3 |
| `janitorVolume` | `unusual` | More deletions in 24 h than `janitor_daily_volume_alert` (10,000 by default) | Check for a deletion bug or abuse; consider the janitor switch |
| `burnFinalize` | `late` | A claimed share is 10+ min past its grace window (access already ended) | `finalize-burn-claims` heartbeat; [cron](cron.md) |
| `reconcile` | `stale` (no finished run for 8 days, or a run open 24 h) | Weekly storage reconciliation isn't completing | [janitor](janitor.md) §5 |
| `storageDrift` | `drift`, `stale` | The last ledger reconciliation found unexplained drift (AC-3.5), or it hasn't run for 2 days | `select * from app.audit_events where action = 'storage.drift_corrected' order by id desc;` |
| `egressLists` | `missing`, `stale` (older than 3 days) | The egress refresh isn't running. At 14 days local sharing turns off everywhere. | [egress lists](egress-lists.md) |
| `jobs` | `failing` | A job's last run failed | `select job, last_failed_at, last_error from app.job_heartbeats where last_failed_at > coalesce(last_succeeded_at, '-infinity');` |

`pending` (a job that hasn't run yet in a new environment) and `not_required` (egress lists outside staging and production) count as ok.

## 2. Setting up the monitor

Any HTTP uptime service with email alerts works: for example Better Stack, UptimeRobot or Cloudflare health checks.

1. Monitor `GET https://<app origin>/api/v1/health/cron` every 1–5 minutes. Alert when the status isn't 200 for 2 consecutive checks.
2. Optionally require the body to contain `"status":"ok"`.
3. Send alerts to **[OWNER: alert email]**. Also alert on recovery.
4. Add the same monitor for `GET /api/v1/health?ready=1` (app and database up).
5. Test it on staging:
   - pause the heartbeat: `select cron.alter_job(jobid, active := false) from cron.job where jobname = 'cron-heartbeat';`
   - wait about 10 minutes and confirm the email arrives;
   - re-enable the job.

   This is the AC-3.6 chaos step. Record it in the verification record.
6. Then, and only then, record "alerts operational" in [phase 3 §18](../phases/phase-3-expiry-one-time-download.md#18-implementation-2026-10-16) and in the public beta gate checklist.

## 3. When an alert arrives

1. Open the endpoint and read which check failed.
2. Follow that check's first step in the table above.
3. If users could be affected (anything other than reclaiming storage late), open an incident ([incident](incident.md)).
4. Close the alert once the endpoint answers 200 again, and note the cause.
