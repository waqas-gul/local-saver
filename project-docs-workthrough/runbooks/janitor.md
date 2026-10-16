# Runbook — Storage janitor

| Field | Value |
|---|---|
| Applies from | Phase 3 (2026-10-16). The only deletion executor (owner decision D-1). |
| What | The `storage-janitor` Supabase Edge Function. pg_cron's `trigger-storage-janitor` job posts to it every minute when outbox rows are due. It deletes or tombstones R2 objects listed in `app.object_deletions` and runs the weekly reconciliation. |
| Why it matters | Access to ended shares stops at once through request-time checks, without the janitor. The janitor reclaims storage (target: p95 under 5 minutes from `expires_at` to deletion, AC-3.2) and keeps the R2 bill and data minimization in line. |
| Owner | Operator on call: **[OWNER: name and email, Q-022]** |
| Staging status | **Not set up.** No staging project exists (Phase 0 owner items). Every step below that names staging or production is written but not yet run. |

## 1. How it works

```text
share ends (end_share)  →  app.object_deletions row (same transaction)
pg_cron, every minute   →  app.trigger_storage_janitor('delete'): posts only if rows are due and the switch is on
storage-janitor         →  app.janitor_claim_hold_copies: copy each held object to hold/<key> (RISK-031)
                        →  app.janitor_claim_deletions(≤ 100): guard rails, 2-minute lock (SKIP LOCKED)
                        →  R2: tombstone (an upload URL may be live) or DeleteObject
                        →  app.janitor_finish_deletion: deleted / tombstoned / failed (backoff) / dry_run
```

- **Guard rails** (in SQL, so every janitor obeys them):
  - the key must have the generated format;
  - no file of an open share (`pending_upload`, `active`, `claimed`) may use it;
  - the row must not be on legal hold.
- **Refused rows:**
  - are parked for a day with `last_error = 'guard:<reason>'`;
  - are logged as `janitor.guard_refused` at error level;
  - set `/health/cron` to `janitorFailures: guard_refused`.
- **Backoff** after the 1st … 5th failure: 1 min, 5 min, 30 min, 2 h, then every 12 h. Rows never give up. From the 5th failure: `janitor.failing` (error) and `janitorFailures: failing`.
- **Per invocation:** at most 500 rows (P3-00: about 0.6 ms CPU per S3 call, so about 0.6 s, under the 1 s soft limit), 100 per batch, 8 in flight, 100 s time budget. Bigger backlogs drain one invocation per minute.
- **Kill switch** `storage_janitor_enabled`: off means nothing is claimed and nothing is posted.
- **Dry run:** the function secret `JANITOR_DRY_RUN=true` claims rows, logs `janitor.would_delete` or `janitor.would_tombstone`, and releases them. Legal-hold copies are still made (§6): a copy deletes nothing.
- **Consumed burn shares:** deletion waits 5 minutes after the share is consumed.
- **Takedowns:** objects are held, not deleted, and copied to `hold/<key>` first (§6).

## 2. Setting it up in an environment

Run once per environment (staging first), from the MFA-protected Supabase dashboard and a trusted machine with the Supabase CLI.

1. **Database role.** In the SQL editor:

   ```sql
   alter role app_janitor with login password '<generate 32+ random characters>';
   ```

   Its URL is the Supavisor **transaction-mode** URL (port 6543) with that user and password.

2. **R2 token.** In Cloudflare, create an R2 API token:
   - permission **Object Read & Write**, never an Admin level;
   - "Apply to specific buckets only": this bucket;
   - an expiry date matching the 90-day rotation;
   - name it `local-saver-<env>-janitor`.

   R2 has no delete-only or write-only level, so the token can read, overwrite and delete everything in the bucket, hold copies included (RISK-037). IP filtering isn't practical: Edge Functions have no static egress IPs. Check that the token gets a 403 on another bucket.

3. **Function secrets.** Every name starts `JANITOR_`. The function never reads the injected `SUPABASE_*` secrets (C-4, tested). Supabase injects them anyway, `SUPABASE_DB_URL` (user `postgres`) and the service-role key included, and they can't be removed (RISK-036). Treat the function's code and dependencies as able to reach the whole database.

   ```bash
   supabase secrets set --project-ref <ref> \
     JANITOR_DATABASE_URL='postgresql://app_janitor.<ref>:<password>@<pooler-host>:6543/postgres' \
     JANITOR_TRIGGER_SECRET='<generate 48+ random characters>' \
     JANITOR_S3_ENDPOINT='https://<account-id>.r2.cloudflarestorage.com' \
     JANITOR_S3_BUCKET='<bucket>' \
     JANITOR_S3_ACCESS_KEY_ID='<token id>' \
     JANITOR_S3_SECRET_ACCESS_KEY='<token secret>' \
     JANITOR_DRY_RUN='true'
   ```

4. **Deploy.** JWT verification is off for this function only (`supabase/config.toml`). It checks its own secret.

   ```bash
   supabase functions deploy storage-janitor --project-ref <ref> --no-verify-jwt
   ```

5. **Vault.** The trigger reads these two by name. Use the same secret as step 3.

   ```sql
   select vault.create_secret('https://<ref>.supabase.co/functions/v1/storage-janitor', 'storage_janitor_url', 'storage janitor endpoint');
   select vault.create_secret('<the JANITOR_TRIGGER_SECRET value>', 'storage_janitor_secret', 'storage janitor bearer secret');
   ```

6. **Check.** Run `select app.run_job('trigger-storage-janitor');`, then the queries in §3. Expect:
   - a `storage-janitor` heartbeat a few seconds later;
   - `net._http_response` with `status_code = 202`.

7. **Dry run for 24 hours** (§17.21 step 5). Compare the `janitor.would_delete` lines with the due rows, and expect no `guard_refused`.

8. **Go live:**

   ```bash
   supabase secrets set --project-ref <ref> JANITOR_DRY_RUN='false'
   ```

   Then repeat the deploy in step 4.

9. Put `/api/v1/health/cron` on the uptime monitor ([monitoring](monitoring.md)).

Locally, `pnpm stack:start` does all of this with local-only values: `supabase/seed.sql` and `supabase/functions/.env`. After editing function code, restart the edge runtime (`docker restart supabase_edge_runtime_local-saver`), because the local runtime caches modules.

## 3. Queries

```sql
-- Backlog: due now, and how long the oldest has waited (alert: > 1,000 rows or > 1 hour).
select count(*) as due, now() - min(not_before) as oldest_wait
  from app.object_deletions where completed_at is null and not legal_hold and not_before <= now();

-- Failing rows and their last errors (status and S3 code only, never keys or secrets).
select id, reason, attempts, last_error, not_before, last_attempt_at
  from app.object_deletions where completed_at is null and attempts > 0 order by attempts desc, id limit 50;
select last_error, count(*) from app.object_deletions where completed_at is null and attempts > 0 group by 1 order by 2 desc;

-- Rows a guard rail refused (each one is a bug to investigate; §4 step 2).
select id, reason, source_file_id, last_error, requested_at from app.object_deletions
 where completed_at is null and last_error like 'guard:%';

-- Held (takedown) rows and their copies (hold_copy: null = not copied yet, copied, unavailable).
select od.id, f.share_id, od.hold_reason, coalesce(od.hold_copy, 'pending') as hold_copy, od.attempts, od.last_error, od.requested_at
  from app.object_deletions od
  left join app.files f on f.id = od.source_file_id where od.completed_at is null and od.legal_hold;

-- The janitor's own heartbeats and the trigger's.
select job, last_started_at, last_succeeded_at, last_failed_at, last_error, last_result
  from app.job_heartbeats where job in ('storage-janitor', 'trigger-storage-janitor', 'storage-reconcile');

-- What pg_net got back from the function (202 expected; 401 means a secret mismatch).
select id, status_code, timed_out, error_msg, created from net._http_response order by created desc limit 20;

-- AC-3.2: seconds from expiry to deletion, p95 over the last day (tombstoned objects excluded:
-- they wait for their upload URL by design).
select percentile_cont(0.95) within group (order by extract(epoch from od.completed_at - s.expires_at)) as p95_seconds
  from app.object_deletions od
  join app.files f on f.id = od.source_file_id
  join app.shares s on s.id = f.share_id
 where s.end_reason = 'expired' and od.tombstoned_at is null and od.completed_at > now() - interval '1 day';
-- AC-3.2: no open row older than an hour under normal operation.
select count(*) from app.object_deletions where completed_at is null and not legal_hold and requested_at < now() - interval '1 hour' and attempts = 0;
```

## 4. When it alerts

1. **Read the function's logs.** Supabase dashboard → Edge Functions → storage-janitor → Logs. Events: `janitor.run`, `janitor.delete_failed`, `janitor.failing`, `janitor.guard_refused`, `janitor.run_failed`, `janitor.disabled`, `janitor.hold_copied`, `janitor.hold_copy_failed`, `janitor.hold_source_missing` (§6).
2. **`guard_refused`: stop.**
   - Switch the janitor off: `update app.runtime_flags set enabled = false, updated_by = '<you>', note = '<why>' where key = 'storage_janitor_enabled';`
   - Find how a row for an open share's object got into the outbox. Every legitimate row comes from `end_share`, an upload rejection, `fail_stale_uploads` or reconciliation.
   - **Never complete a refused row by hand.** Delete it only once the cause is understood and fixed. Then switch the janitor back on.
3. **R2 errors (`s3:5xx`, network errors):**
   - Leave backoff to work and watch the backlog.
   - Check the Cloudflare status page.
   - Access is unaffected: the objects are unreachable either way.
4. **`401` in `net._http_response`:** the Vault secret and `JANITOR_TRIGGER_SECRET` differ. Fix it with [secret rotation](secret-rotation.md).
5. **No `storage-janitor` heartbeat while rows are due (`janitorBacklog: stalled`):**
   - Check the function is deployed, its secrets are set (a missing one makes it fail to boot: logs say which), and `storage_janitor_enabled` is on.
   - Check the `trigger-storage-janitor` heartbeat. A `missing_secret` error means Vault (§2 step 5).
   - If the trigger itself isn't running, see the [cron runbook](cron.md).
6. **Run it by hand** from a trusted machine:

   ```bash
   curl -X POST https://<ref>.supabase.co/functions/v1/storage-janitor \
     -H "Authorization: Bearer $JANITOR_TRIGGER_SECRET" -d '{"mode":"delete"}'
   ```

7. **Dry run while investigating:** set `JANITOR_DRY_RUN='true'` and redeploy (§2 step 8).
8. **Last resort for one stuck object:**
   - Delete the key with an S3 client using the janitor token, after any `holdUntil`. Deleting earlier frees the key while an upload URL may still write to it.
   - Then mark the row: `select app.janitor_finish_deletion(<id>, 'deleted');`. As the dashboard owner: it is not granted to anyone else.
9. **The R2 lifecycle rules** (`infra/r2/lifecycle.json`, once applied) remove every `d7/`, `d30/` and `d90/` object at its class period + 1 day, whatever the janitor does. Held originals included; their `hold/` copies have no rule (§6).

## 5. Reconciliation (weekly)

- **Schedule:** `reconcile-r2-orphans` runs Sunday 05:06 UTC and opens a run in `app.storage_reconcile_runs`. While the run is open, the minute trigger keeps posting `{"mode":"reconcile"}`. Each invocation lists up to 20 pages of 1,000 keys and saves its cursor.
- **Orphans** are queued as outbox rows with reason `orphan`, then deleted through §1 with every guard rail. An orphan is a well-formed key, no pending or verified file, last modified more than 48 hours ago, and no open row.
- **Unknown keys** are only counted (`reconcile.unknown_key`), never queued.
- **Hold copies** (`hold/<key>`) are only counted (`holdCopies`), never queued.
- **Missing objects:** a verified file of an open share with no object gets `files.object_missing_at`, logged as `reconcile.missing_object` at error level. Investigate each one: it means lost data, a restore, or a manual deletion.
- **Multipart uploads** shouldn't exist before Phase 4. They are reported, and ones older than 24 hours are aborted.
- **Start a run by hand:** `select app.start_storage_reconcile();`
- **Status:** `select id, started_at, finished_at, status, last_key, counts from app.storage_reconcile_runs order by id desc limit 5;`

## 6. Legal hold (takedowns, D-2)

- `admin_block_share` (and `end_share('blocked')`) put the share's open outbox rows on hold (`legal_hold`, `hold_reason = 'takedown'`). The janitor never deletes them, and the purge never removes the share. See the [takedown runbook](takedown.md).
- **Copies.** R2's lifecycle rules ignore holds: they would delete a held `d7/` object 8 days after its upload. So the janitor's next run (within a minute) copies each held object to `hold/<key>`, a prefix no rule covers, and records `hold_copy = 'copied'`. The copy keeps the object's stored headers. It is made in dry runs too, and nothing that users can reach points at it.
  - A row waits while an upload URL may still write to its key.
  - Copy failures back off like deletions. `/health/cron` shows `janitorBacklog` while a held row is uncopied, and `janitorFailures: failing` after 5 failures.
  - **`unavailable`** (`last_error = 'hold:source_missing'`, logged `janitor.hold_source_missing` at error level) means nothing was left to copy: the object was already deleted, or overwritten by a tombstone. Record it in the incident; that evidence is gone.
  - **The janitor switched off stops copies too.** If it must stay off during an investigation, watch the held rows (§3) and copy anything uncopied by hand with an S3 client before its lifecycle date.
- **Release** only once legal review says the objects may be deleted. Final retention is an operational and legal decision (Q-022), not something the code decides.

  ```sql
  select app.admin_release_hold('<share id>', '<why, e.g. ticket and legal ok>', '<your name>');
  ```

  This writes `admin.release_hold` to the audit log. The janitor deletes the objects and their `hold/` copies on its next run.
- **Real R2 is not yet tested.** That the lifecycle rules spare `hold/` is tested against the rule file and RustFS only. Confirm it on staging ([manual procedure](../phases/phase-3-manual-verification.md) S-6) before relying on it for real evidence. Exporting evidence out of R2 is still a matter for the legal procedure (Q-022).
