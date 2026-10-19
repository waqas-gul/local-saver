# Runbook — Incident response

| Field | Value |
|---|---|
| Applies from | Phase 3 (2026-10-16); needed before the public beta (05 §4.1) |
| Incident lead | **[OWNER: named operator and backup, Q-022]** |
| Where to talk | **[OWNER: incident channel]** |
| Tools | The MFA-protected Supabase dashboard (SQL editor, logs), the Cloudflare dashboard, the host's dashboard, this repository's runbooks |

## 1. Severity

| Level | Examples | Response |
|---|---|---|
| **SEV-1** | Content visible to the wrong people (another network, a revoked link). A leaked secret that grants access. Deleting content that should exist (a janitor bug). CSAM on the service. | Now, any hour. Contain first. |
| **SEV-2** | Uploads or sharing down for everyone. The storage janitor stopped for hours. An abuse wave. | Within 1 hour |
| **SEV-3** | One feature degraded, a backlog, a single failing job, a monitoring alert with no user impact | Next working day |

## 2. The first 15 minutes

1. **Open an incident record:** time, who, what was seen, severity. Keep a timeline as you go.
2. **Contain** with the kill switches ([kill switches](kill-switches.md)), as narrowly as possible:

   | Switch (`app.runtime_flags`) | Use when |
   |---|---|
   | `local_sharing_enabled` | Cross-network exposure, network classification faults |
   | `remote_links_enabled` | Link abuse, a leaked link pepper |
   | `short_codes_enabled` | Code guessing, a leaked code pepper |
   | `uploads_enabled`, `anonymous_uploads_enabled` | Storage, cost or abuse incidents |
   | `burn_after_download_enabled` | A burn-claim bug (existing burn shares keep working) |
   | `storage_janitor_enabled` | A deletion bug, a legal hold beyond the takedown flow, an investigation needing the objects |

3. **Preserve evidence:**
   - Don't delete logs, audit events (`app.audit_events`) or reports.
   - For a deletion bug, switch the janitor off **before** anything else.
   - For abuse, follow the [takedown runbook](takedown.md): blocked objects are held, not deleted.
4. **Tell the owner** for SEV-1 and SEV-2.

## 3. Playbooks

| Incident | Steps |
|---|---|
| **Cross-network exposure** | `local_sharing_enabled` off. Find the affected spaces (`app.audit_events` `network.status_changed`, the network spaces involved). Check `lib/server/local/visibility.ts` and the feed query for a regression. Fix, test (T-001, the IDOR matrix), deploy, switch back on. |
| **Leaked link secret** | Revoke the link (`app.admin_block_link`, [takedown](takedown.md)). The share and its other links keep working. |
| **Leaked `LINK_PEPPER` or `CODE_PEPPER`** | Rotate with an overlap ([secret rotation](secret-rotation.md)). Leaked peppers let someone check guesses offline against stored HMACs; codes are short, so clear live codes if needed: `update app.share_links set short_code_hmac = null, short_code_pepper_version = null, short_code_expires_at = null where short_code_hmac is not null;` |
| **Leaked R2 token (web or janitor)** | Revoke it in Cloudflare at once. Create a new one, set it, redeploy ([secret rotation](secret-rotation.md#r2-tokens)). The janitor token can read, overwrite and delete any object in the bucket, legal-hold copies included (RISK-037). Review R2 access logs if available, and check the held rows ([janitor](janitor.md) §3). |
| **Leaked database password** (`app_server`, `app_janitor`, `app_egress_loader`) | `alter role <role> with password '<new>';`, update the host or function secret, redeploy. Review recent activity. |
| **Leaked Supabase keys** | Rotate in the dashboard (API keys). The janitor doesn't use them (C-4). But Supabase injects them, and `SUPABASE_DB_URL` (the `postgres` password), into every Edge Function. If the function or one of its dependencies may be compromised, treat them as leaked: rotate the keys and the database password, and redeploy (RISK-036). |
| **Leaked `JANITOR_TRIGGER_SECRET`** | Low impact: it only starts a janitor run that obeys its guard rails. Rotate ([secret rotation](secret-rotation.md)). |
| **A deletion bug** | `storage_janitor_enabled` off. Set `JANITOR_DRY_RUN='true'` and redeploy. Find the rows involved: refused rows have `last_error like 'guard:%'`. Whatever was already deleted is gone unless R2 still has it (no versioning); restore metadata from backup only with care ([restore drill](restore-drill.md)). |
| **Abuse surge** | Block shares and links ([takedown](takedown.md)). Consider `remote_links_enabled` or `anonymous_uploads_enabled` off. Block repeat networks. |
| **Supabase or R2 outage** | Nothing to switch: the app fails closed (uploads and downloads error, access checks deny). The janitor backs off and catches up. Post a status note. |
| **pg_cron stopped** | Access stays denied by request-time checks. Follow [cron](cron.md). |

## 4. Communication

- **Status:** a short note where users see it, **[OWNER: status page or banner]**. Say what's affected and what users should do. Never include internal detail.
- **Personal data:** if personal data was exposed, the owner decides on regulator and user notification within the legal deadlines (for example 72 hours under the GDPR). Legal review is pending: Q-022.

## 5. After the incident

Write a short post-incident review within a week:

- **Summary:** what happened, impact (who, how long), severity.
- **Timeline:** detection, containment, fix, recovery.
- **Root cause and contributing factors.**
- **What worked, and what didn't.**
- **Actions,** each with an owner and a date. Tests that would have caught it first.
- **Follow-ups:** link the record from [06](../06-decisions-and-risks.md) if a risk changes.
