# Runbook — Shared-egress lists (iCloud Private Relay, Tor)

| Field | Value |
|---|---|
| Applies from | Phase 1 (manual). Phase 3 schedules it (`refresh-egress-ranges`, [04 §9.2](../04-database-and-storage-design.md#92-job-catalogue)). |
| Why | Addresses on these lists are shared by many unrelated people. A network seen from one of them is `shared_egress`, and local sharing is off there ([03 §3.5](../03-security-and-network-design.md#35-eligibility-classification-and-fail-closed-guards-dec-032)). |
| Fail-closed rule | In staging and production, local sharing is **off everywhere** while the lists were never loaded or are older than 14 days (`lib/server/network/egress.ts`). The status copy says checks are being updated. |
| Owner | Operator on call |

## When

- Once when an environment is created, **before** opening it to users.
- At least weekly (Apple updates its list often), and always within 14 days of the last load.
- After an alert `network.egress_list_stale` in the app logs.

## Steps

1. Use a database URL with write access to `app.network_egress_ranges` and `app.runtime_flags` (the migration role, or `app_server`). Keep it out of shell history.
2. Run from a checkout of the deployed commit:

   ```bash
   LOADER_DATABASE_URL='postgresql://…' pnpm egress:load
   ```

   It downloads `https://mask-api.icloud.com/egress-ip-ranges.csv` and `https://check.torproject.org/torbulkexitlist`, merges adjacent and overlapping ranges (same addresses, far fewer rows), replaces both sources in one transaction, and records `{loadedAt, rows}` in `app.runtime_flags('egress_ranges')`.
3. Check the output, for example `private_relay: 285091 ranges listed, 14068 rows after merging, 0 lines skipped` and `tor: 1210 ranges listed, 642 rows after merging` (2026-10-15). A large drop in ranges listed means a format change: investigate before relying on it.
4. Offline or from saved files: `pnpm egress:load --apple apple.csv --tor tor.txt`.

## Safety

- The loader refuses to replace a list with nothing usable, so a failed download can't empty it.
- Existing `shared_egress` spaces stay off until their 7-day sticky period ends and an observe re-checks them against the current list.
- Other sources (`vpn`, `hosting`) are never touched by the loader.
