# Runbook — Shared-egress lists (iCloud Private Relay, Tor)

| Field | Value |
|---|---|
| Applies from | Phase 1 (manual). Phase 3: a daily GitHub Actions schedule, `.github/workflows/refresh-egress-ranges.yml` (D-4: the merge needs about 4 s of CPU, twice the Edge Function limit, P3-00). |
| Why | Addresses on these lists are shared by many unrelated people. A network seen from one of them is `shared_egress`, and local sharing is off there ([03 §3.5](../03-security-and-network-design.md#35-eligibility-classification-and-fail-closed-guards-dec-032)). |
| Fail-closed rule | In staging and production, local sharing is **off everywhere** while the lists were never loaded or are older than 14 days (`lib/server/network/egress.ts`). The status copy says checks are being updated. |
| Owner | Operator on call |

## Scheduled refresh (Phase 3)

- **Setup:**
  - In GitHub, create the environments `staging` and `production`.
  - Give each the secret `EGRESS_LOADER_DATABASE_URL`: the Supavisor URL for `app_egress_loader`, after `alter role app_egress_loader with login password '<generated>';`.
  - Set the repository variable `EGRESS_REFRESH_ENABLED=true`.
- **Runs** daily at 02:20 UTC, and by hand from the Actions tab ("Refresh egress ranges" → Run workflow).
- **Role:** `app_egress_loader` may only call `app.replace_egress_ranges`. It has no table privileges.
- **Failures:** GitHub emails a failed scheduled run to the workflow's owner, and `/api/v1/health/cron` reports `egressLists: stale` after 3 days ([monitoring](monitoring.md)), well before the 14-day cut-off.
- **Status: not set up.** No staging environment exists yet.

## When to run it by hand

- Once when an environment is created, **before** opening it to users.
- When the scheduled run has failed, and always within 14 days of the last load.
- After an alert `network.egress_list_stale` in the app logs, or `egressLists: stale` on `/api/v1/health/cron`.

## Steps

1. Use the `app_egress_loader` URL (Phase 3), or the migration role. Keep it out of shell history.
2. Run from a checkout of the deployed commit:

   ```bash
   LOADER_DATABASE_URL='postgresql://…' pnpm egress:load
   ```

   It downloads `https://mask-api.icloud.com/egress-ip-ranges.csv` and `https://check.torproject.org/torbulkexitlist` and merges adjacent and overlapping ranges (same addresses, far fewer rows). It then replaces both sources in one transaction through `app.replace_egress_ranges`, which records `{loadedAt, rows}` in `app.runtime_flags('egress_ranges')`.
3. Check the output, for example `private_relay: 285091 ranges listed, 14068 rows after merging, 0 lines skipped` and `tor: 1210 ranges listed, 642 rows after merging` (2026-10-15). A large drop in ranges listed means a format change: investigate before relying on it.
4. Offline or from saved files: `pnpm egress:load --apple apple.csv --tor tor.txt`.

## Safety

- The loader refuses to replace a list with nothing usable, so a failed download can't empty it.
- Existing `shared_egress` spaces stay off until their 7-day sticky period ends and an observe re-checks them against the current list.
- Other sources (`vpn`, `hosting`) are never touched by the loader.
