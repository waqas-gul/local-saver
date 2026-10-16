# Runbook — Scheduled jobs (pg_cron)

| Field | Value |
|---|---|
| Applies from | Phase 1 jobs, plus the Phase 3 jobs (2026-10-16) |
| Signal | `/api/v1/health/cron` answers 503 with `heartbeat: stale` (no `cron-heartbeat` for over 10 minutes) or `jobs: failing` ([monitoring](monitoring.md)) |
| Owner | Operator on call: **[OWNER: name and email, Q-022]** |
| Key fact | Jobs only reclaim storage and tidy up. **Access never depends on them**: every request checks expiry, grace and status itself (T-041, T3-07). |

## 1. The jobs

| Job | Schedule (UTC) | Command | What it does |
|---|---|---|---|
| `expire-shares` | every minute | `select app.expire_due_shares(500)` | Ends expired shares (Phase 1) |
| `fail-stale-uploads` | `*/5` | `select app.fail_stale_uploads(500)` | Fails uploads past their deadline |
| `refresh-network-status` | `*/5` | `select app.refresh_network_status(1000)` | Device counts, large-network cap |
| `purge-ephemeral` | `*/10` | `select app.purge_ephemeral()` | Presence, counters, idempotency keys, grants, sessions, codes |
| `release-stale-reservations` | `*/10` | `select app.release_stale_reservations(500)` | Quota reservations past their TTL |
| `purge-idle-spaces` | `17 3 * * *` | `select app.purge_idle_spaces(1000)` | Networks idle for 30 days |
| `trigger-storage-janitor` | every minute | `select app.run_job('trigger-storage-janitor')` | Posts to the janitor when rows are due ([janitor](janitor.md)) |
| `finalize-burn-claims` | every minute | `select app.run_job('finalize-burn-claims')` | Consumes claimed burn shares past grace |
| `cron-heartbeat` | `2-59/5` | `select app.run_job('cron-heartbeat')` | Proves pg_cron runs |
| `purge-tombstones` | `3 3 * * *` | `select app.run_job('purge-tombstones')` | Ended shares after 30 days; records after their own dates; never reported or held shares (D-3) |
| `cleanup-anonymous-users` | `33 3 * * *` | `select app.run_job('cleanup-anonymous-users')` | Inactive anonymous users with nothing open; never suspended users (D-9) |
| `reconcile-storage-usage` | `4 4 * * *` | `select app.run_job('reconcile-storage-usage')` | Recounts the quota ledger (DEC-019) |
| `reconcile-r2-orphans` | `6 5 * * 0` | `select app.run_job('reconcile-r2-orphans')` | Opens the weekly storage reconciliation |

- **Heartbeats.** Phase 3 jobs run through `app.run_job`, which writes a heartbeat (`app.job_heartbeats`) on success and on failure. A failing job is caught, recorded and raised again as a warning. So `cron.job_run_details` shows it as succeeded: use the heartbeat instead.
- **Concurrency.** The minutes are offset so at most 8 jobs start together (04 §9.1).
- **Egress lists.** `refresh-egress-ranges` is not a pg_cron job: it is a GitHub Actions schedule ([egress lists](egress-lists.md)).

## 2. Queries

```sql
select jobname, schedule, active from cron.job order by jobname;

-- Recent runs and failures (Phase 1 jobs report errors here).
select j.jobname, d.status, d.start_time, d.end_time - d.start_time as took, left(d.return_message, 200) as message
  from cron.job_run_details d join cron.job j on j.jobid = d.jobid
 order by d.start_time desc limit 30;

-- Phase 3 jobs: the heartbeat is the truth.
select job, last_started_at, last_succeeded_at, last_failed_at, last_error, last_result from app.job_heartbeats order by job;

-- What /health/cron reports, without HTTP.
select app.cron_health(true);
```

## 3. pg_cron stopped or a job failing

1. **Check Supabase status.** pg_cron stops with the database and comes back with it.
2. **Find the failing job and its error** with the queries above: `last_error` for Phase 3 jobs, `return_message` for the others.
3. **Re-enable a paused job:** `select cron.alter_job(jobid, active := true) from cron.job where jobname = '<name>';`
4. **Re-create a missing job** from the table in §1:

   ```sql
   select cron.schedule('<name>', '<schedule>', $$<command>$$);
   ```

5. **Catch up by hand**, in this order, recording the counts:

   ```sql
   select app.expire_due_shares(500);
   select app.run_job('finalize-burn-claims');
   select app.fail_stale_uploads(500);
   select app.release_stale_reservations(500);
   select app.run_job('trigger-storage-janitor');
   select app.purge_ephemeral();
   select app.run_job('cron-heartbeat');
   ```

   Daily jobs can wait for their next run.
6. **Confirm access stayed denied** while jobs were down. These rows are "open" in the database, but every request refuses them:

   ```sql
   -- expired but not yet ended
   select count(*) from app.shares where status in ('pending_upload', 'active') and expires_at <= now();
   -- past grace, not yet finalized
   select count(*) from app.shares where status = 'claimed' and claim_grace_until <= now();
   ```

7. **Record** how long jobs were down, for the incident record ([incident](incident.md)).
