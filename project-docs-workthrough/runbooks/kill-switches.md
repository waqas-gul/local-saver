# Runbook — Kill switches

| Field | Value |
|---|---|
| Applies from | Phase 1 (local sharing, uploads), Phase 2 (remote links, short codes), Phase 3 (burn after download, the storage janitor) |
| Where | `app.runtime_flags`, changed with SQL from the MFA-protected Supabase dashboard |
| Takes effect | Within `RUNTIME_FLAGS_CACHE_SECONDS` (30 s by default) on every server instance. The `net:` Realtime topics read `local_sharing_enabled` directly. |
| Owner | Operator on call |

## Switches

| Key | Off means |
|---|---|
| `local_sharing_enabled` | Every network reports `unavailable` (`disabled`): no local feed, no local posting, `net:` topics denied. Link-only posting and links keep working. |
| `uploads_enabled` | No new file shares (text still works). |
| `anonymous_uploads_enabled` | No posts by anonymous users (everyone, until accounts exist). |
| `remote_links_enabled` | No link creation and no link-only posting; unlocking, viewing, downloading through links and resolving codes answer `503 REMOTE_LINKS_DISABLED`. Creators can still list and revoke links. |
| `short_codes_enabled` | No new short codes; resolving codes answers `503 SHORT_CODES_DISABLED`. Links work. |
| `burn_after_download_enabled` | No new burn-after-download shares (`503 BURN_AFTER_DOWNLOAD_DISABLED`). Existing ones keep working: claims, retries, Reveal, "I've got it". |
| `storage_janitor_enabled` | The storage janitor claims nothing and pg_cron posts nothing ([janitor](janitor.md)). Access is unaffected; objects wait in storage. **Legal-hold copies stop too**: a takedown while it is off leaves its objects exposed to the R2 lifecycle rules ([janitor](janitor.md) §6). |

A missing row counts as on. One flag is the other way round: `free_burn_after_download` (Q-008) lets the Free plan create burn shares only while it is **on**, and a missing row counts as **off**. It ships off; turn it on for beta or testing only on the owner's decision. The storage janitor reads its switch in the database at once (no cache).

## Use

```sql
update app.runtime_flags set enabled = false, updated_at = now(), updated_by = '<your name>', note = '<why>'
 where key = '<key>';
-- and back:
update app.runtime_flags set enabled = true, updated_at = now(), updated_by = '<your name>' where key = '<key>';
```

Check: `select key, enabled, updated_at, updated_by, note from app.runtime_flags order by key;`

## When

- A wave of abuse through links: `remote_links_enabled` off, then block the shares ([takedown runbook](takedown.md)).
- Code guessing (alert `code.resolve_failure_spike`): `short_codes_enabled` off.
- A storage or cost incident: `uploads_enabled` off.
- A network classification fault (wrong networks merged): `local_sharing_enabled` off.
- A burn-claim bug: `burn_after_download_enabled` off.
- A deletion bug, or an investigation that needs the objects: `storage_janitor_enabled` off ([incident](incident.md)).
