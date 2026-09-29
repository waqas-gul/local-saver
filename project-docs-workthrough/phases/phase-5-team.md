# Phase 5 — Team Workspaces

| Field | Value |
|---|---|
| **Status** | **PLANNED** (outline). Not started. |
| Plan depth | Outline. Refined after Phase 4 is VERIFIED. |
| Depends on | Phase 4 VERIFIED. Q-006 (Team pricing), Q-007 (pooled quota), Q-015, Q-017, Q-018 answered. |
| Unblocks | **Team launch gate** |
| Last updated | 2026-09-23 |

---

## 1. Goal

A paid Team plan: a **shared workspace** with members, roles, admin controls, a **pooled storage quota**, **retention policies** (long or no-expiry storage *within* quota), a workspace audit log and transfer history, and **branded share pages**.

## 2. Scope

| Area | Contents |
|---|---|
| Workspaces | Create, rename, slug, delete (30-day grace → content ended with notices). Status `active` / `read_only` / `suspended`. |
| Members and invitations | Email invitations (7-day, secret link), roles `owner` / `admin` / `member`, remove and suspend members, ownership transfer, **seat limit enforced transactionally** |
| Workspace rooms | `kind = 'workspace'`. Membership through workspace membership plus a per-room access list. Never visible on a network: members reach them from anywhere. Team members can still use local mode like anyone else. |
| Quota and billing | Pooled `storage_usage` per workspace. Seat-based subscription (`subject_type = 'workspace'`). Storage add-ons. Read-only grace when the subscription lapses ([07 §5](../07-plans-and-entitlements.md#5-upgrades-downgrades-and-over-quota-behaviour)). |
| Policies | `retention_policy` (default and maximum days, allow no expiry), `security_policy` (require link passwords, allow room links, maximum link days) enforced in services |
| Admin controls | Revoke any link, block or delete any share, remove members, view usage, export the audit log (CSV) |
| Audit and history | Workspace-scoped `audit_events` and download history, retention per policy (Q-015) |
| Branding | Display name, logo (verified PNG/JPEG, **no SVG**), accent colour on share pages of workspace links. Custom domains out of scope (Q-018). |
| Realtime | `workspace:{id}` topic for admin and member events |
| Legal | DPA template, subprocessor list |

### Out of scope

Custom domains, SSO/SAML (possible later Enterprise tier), fine-grained per-file permissions.

## 3. Existing system state (expected at start)

Accounts, entitlements, billing and Pro features (Phase 4). Local mode (network spaces) plus personal `private` rooms.

## 4. What will be changed

New workspace modules, routes and pages. Policy checks added to share, link and room services. Entitlement resolution for workspace rooms. Share page branding. The realtime helper gains the workspace topic.

## 5. What will NOT be changed

Personal rooms and Pro behaviour. The link and burn security model. Snapshots on existing shares.

## 6. Architecture decisions involved

DEC-018 (workspace subject), DEC-019 (pooled ledger), DEC-010 (`ws/` prefix, application-managed retention), DEC-011 (workspace topic), DEC-024 (no third-party scripts on branded pages).

## 7. Files / modules involved

See [05 §6 — Phase 5](../05-implementation-roadmap.md#phase-5): `app/(team)/w/[slug]/**`, `app/api/v1/workspaces/**`, `lib/server/workspaces/*`, plus changes to policy, entitlements, quota and the share page.

## 8. Database changes

- New tables: `workspaces`, `workspace_members`, `workspace_invitations`.
- New columns: `workspace_id` on rooms and shares (introduced earlier as nullable).
- Workspace audit indexes. Realtime helper updated.

## 9. API changes

`/api/v1/workspaces/*`: CRUD, members, invitations, policies, branding, audit (list and export), usage.

## 10. Security considerations

- **Cross-workspace isolation**: every query is scoped by workspace membership. The IDOR matrix gains other-workspace actors.
- Admin endpoints return 404 to non-admins.
- Seat checks run in a transaction with a workspace row lock (no race past the limit).
- Branding assets are validated by magic bytes. No SVG. Served like other files.
- Policy changes are audited. Retroactive application is explicit.
- No silent deletion of paid content (notices at 30/7/1 days).

## 11. Dependencies

- **Phase:** Phase 4 VERIFIED.
- **Business:** Team pricing and seat model (Q-006), DPA template (legal).

## 12. Testing requirements

T-054, workspace IDOR fixtures, seat-limit concurrency, retention-policy enforcement (including no-expiry within quota), lapsed-subscription read-only behaviour, branding asset validation.

## 13. Acceptance criteria (outline)

| ID | Criterion |
|---|---|
| AC-5.1 | Workspace isolation proven by the IDOR matrix (T-054) |
| AC-5.2 | Seat limits hold under concurrent invitation acceptance |
| AC-5.3 | Pooled quota and retention policies enforced. No-expiry content counts against quota. |
| AC-5.4 | Admin controls work and are audited. Members cannot use them. |
| AC-5.5 | Branded share pages render workspace branding without third-party requests |
| AC-5.6 | Lapse → read-only → notices → suspension flow verified in sandbox |
| AC-5.7 | Team launch gate complete |

## 14. Known risks

RISK-005 (DPA, retention obligations), RISK-012 (pooled quota), RISK-018 (long-retention content deletion safety), RISK-020.

## 15. Open questions

Q-006, Q-007, Q-015, Q-017, Q-018.

## 16. Implementation status

| Date | Status | Note |
|---|---|---|
| 2026-09-17 | PLANNED | Outline drafted |
| 2026-09-23 | PLANNED | CR-001: workspace rooms are never network-visible; "allow nearby discovery" policy removed |

### Verification record

*Empty until verified.*
