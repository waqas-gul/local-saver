# Runbook — Abuse reports and takedown

| Field | Value |
|---|---|
| Applies from | Phase 2 (2026-10-15). A web admin console waits for operator accounts with MFA (Phase 4). |
| Why | Remote links turn the product into a file host that anyone can send links to ([05 §2.1](../05-implementation-roadmap.md#21-changes-from-the-owners-proposed-phasing), RISK-004, RISK-005). |
| Tools | The MFA-protected Supabase dashboard (SQL editor, as the project's database owner). The functions below **cannot** be called by the app's role (`app_server`). |
| Owner | The named operator for abuse reports. **Not named yet (Q-022).** |
| Rehearsed | **No.** The rehearsal on staging (AC-2.8) waits for a staging environment. |

## 1. How reports arrive

- Anyone who can see a share can report it: a device on its network or its creator (the Report button on a post), or a link viewer (the Report button on the share page, or the link pasted on `/report`). The server checks that the reporter can see what they report.
- Each report is stored in `app.abuse_reports`, audited (`report.created`) and logged at warn level as **`abuse.report_received`** with the report ID and category only.
- **Nobody is notified.** Phase 2 has no email, chat, SMS or pager alert (owner decision, 2026-10-16). Until the alert "every new report" ([08 §8](../08-deployment-and-operations.md#8-observability-and-alerting)) is built on that log event, with a channel and a named operator (Q-022 and error monitoring, DEC-029), reports are found only by running the triage query in §2.
- `urgent: true` in the log line means the category is `child_safety`.

## 2. Triage

```sql
-- Open reports, oldest first, with what they point at.
select r.id, r.created_at, r.category, r.details, r.reporter_kind, r.reporter_email,
       r.share_id, r.link_id, s.status as share_status, s.scope, s.kind, s.expires_at
  from app.abuse_reports r
  left join app.shares s on s.id = r.share_id
 where r.status = 'open'
 order by (r.category = 'child_safety') desc, r.created_at;

-- What a share holds (names only; never download content unless the law and the policy allow it).
select f.id, f.original_name, f.size_bytes, f.risk_flags, f.upload_status
  from app.files f where f.share_id = '<share id>' order by f.position;

-- Its links.
select id, created_at, expires_at, revoked_at, revoke_reason, unlock_count
  from app.share_links where share_id = '<share id>' order by created_at;
```

Decide one of:

- **Block the whole share:** everyone loses it (the network, the creator, every link viewer).
- **Block one link:** that link stops; the share and its other links stay.
- **Dismiss:** nothing to act on.

## 3. Act

Write your own name and a short reason; both go into the audit trail.

```sql
-- Block a share: ends it as 'blocked', revokes every link and short code, erases text,
-- puts its files on legal hold (Phase 3, D-2), resolves its open reports, writes admin.block.
select app.admin_block_share('<share id>', '<reason>', '<your name>', '<report id or null>');

-- Block one link: revokes it and its short code, resolves its open reports, writes admin.block.
select app.admin_block_link('<link id>', '<reason>', '<your name>', '<report id or null>');

-- Dismiss a report.
update app.abuse_reports
   set status = 'dismissed', resolved_at = now(), resolved_by = '<your name>', action_taken = '<why>'
 where id = '<report id>' and status = 'open';
```

Access ends **on the next request** (request-time checks). Download URLs already handed out stay valid for at most 60 seconds (300 for image previews), RISK-009.

## 4. Storage: the objects are held (Phase 3, D-2)

`admin_block_share` returns `objects`: each object key with `legalHold: true`, `holdCopy` (`pending` until the janitor copies it), and `holdUntil` when an upload URL for it may still be live.

- **Since Phase 3 a takedown holds the objects instead of deleting them** (owner decision D-2, evidence preservation).
  - The share's outbox rows get `legal_hold = true`, `hold_reason = 'takedown'`.
  - The storage janitor never deletes held rows. The tombstone purge never removes the share, or any share with a report (D-3).
  - Within a minute the janitor copies each held object to `hold/<key>`, a prefix no R2 lifecycle rule covers ([janitor](janitor.md) §6). **Check it:** the held-rows query in [janitor](janitor.md) §3 should show `copied`. `pending` after a few minutes means the janitor isn't running. `unavailable` means the object was already gone: note it in the case.
  - This also applies to a share that had already ended before the takedown: its open rows are held too.
- Access ends at once whatever happens to the bytes (§3).
- **Release the hold** only once legal review allows deletion. The janitor then deletes the objects and their copies on its next run:

  ```sql
  select app.admin_release_hold('<share id>', '<why: ticket, legal ok>', '<your name>');
  ```

- **R2's lifecycle rules ignore holds.** Once applied, they delete the original at its class period + 1 day (8 days for `d7/`). The `hold/` copy is what survives, until the release. This is not yet confirmed on real R2 ([manual procedure](../phases/phase-3-manual-verification.md) S-6): until it is, also note each object key and its lifecycle date in the case.
- Final legal retention is an operational and legal responsibility (Q-022): the code holds, it doesn't decide how long.
- Before Phase 3 (Phase 2 as built), the bytes stayed until a request-path sweep, and this step deleted them by hand. Don't do that any more: release the hold instead.

## 5. Child sexual abuse material

- Act at once: block the share (step 3).
- **Evidence is held, not destroyed** (Phase 3, D-2): blocking puts the files on legal hold (§4), and the share and its reports are kept (D-3).
- Legal duties may require preserving evidence and reporting to the authorities (for example NCMEC in the US). That procedure needs legal advice (Q-022). Until it exists:
  - don't release the hold;
  - check that every held object is `copied` (§4); note the object keys, and the lifecycle date of any that aren't;
  - escalate to the owner.

  Tracked as RISK-031.

## 6. Repeat abuse

```sql
-- Block a network (local sharing off there for everyone; audited as network.status_changed).
select app.set_space_status('<network space id>', 'blocked', 'abuse: <reason>');

-- Stop a user from posting and from creating links (their anonymous user ID is shares.created_by_user_id).
insert into app.user_flags (user_id, upload_restricted, reason) values ('<user id>', true, '<reason>')
on conflict (user_id) do update set upload_restricted = true, reason = excluded.reason, updated_at = now();
```

## 7. Afterwards

- Check: `select action, metadata from app.audit_events where action = 'admin.block' order by id desc limit 5;`
- Reply to the reporter if they left an email and the policy says to (Q-022).
- If many reports arrive at once, consider the kill switches ([runbook](kill-switches.md)).
