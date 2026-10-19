# Runbook — Database restore drill

| Field | Value |
|---|---|
| Applies from | Phase 3 (2026-10-16). Quarterly, on **staging only**. |
| Targets | RTO ≤ 4 hours, RPO ≤ 24 hours (daily backups, 08 §10) |
| Needs | A hosted Supabase project on a paid plan with daily backups (Q-016). **None exists yet: this drill has never been run.** |
| Owner | Operator: **[OWNER, Q-022]** |

## Steps

1. **Record** the backup you'll restore (its time) and the start time. Announce the drill in **[OWNER: channel]**.
2. **Stop the janitor first.**

   ```sql
   update app.runtime_flags set enabled = false, updated_by = '<you>', note = 'restore drill' where key = 'storage_janitor_enabled';
   ```

   A restored database is out of step with R2. Restored outbox rows and reconciliation must not act on objects until you have checked (R3-6).
3. **Restore** the backup into the staging project, or into a scratch project (Supabase dashboard → Database → Backups).
4. **Re-create what doesn't move with a backup:**
   - Role logins and passwords: `app_server`, `app_janitor`, `app_egress_loader` ([secret rotation](secret-rotation.md)).
   - The Vault secrets: `storage_janitor_url` and `storage_janitor_secret` ([janitor](janitor.md) §2 step 5). Vault values don't carry over between projects.
   - The function secrets, if this is a new project.
5. **Check the jobs exist and point here:** `select jobname, schedule, active from cron.job order by jobname;` ([cron](cron.md) §1).
6. **Verify the data:**
   - run the pgTAP suites (`supabase test db` against the project, or the smoke tests);
   - compare row counts with the source: shares, files, link counts, `storage_usage`;
   - `select app.cron_health(true);`.
7. **Expect drift, and look at it** before switching the janitor back on:
   - Objects deleted **after** the backup point show as missing at the next reconciliation (`files.object_missing_at`).
   - Objects uploaded **after** it have no rows: reconciliation queues them as orphans after 48 hours and the janitor deletes them. Accepted as part of the RPO (R3-6).
   - Restored open outbox rows for objects already deleted are harmless: deleting a missing key succeeds.
8. **Turn the janitor back on**, then start a reconciliation: `select app.start_storage_reconcile();`.
9. **Record** RTO (start to working app) and RPO (backup time to the last lost write) in the verification record, against the targets above. This is AC-3.7.
