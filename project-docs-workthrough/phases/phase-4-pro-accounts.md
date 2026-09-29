# Phase 4 — Accounts, Entitlements, Pro and Billing

| Field | Value |
|---|---|
| **Status** | **PLANNED** (outline). Not started. |
| Plan depth | Outline. Scope is refined into a detailed plan after Phase 3 is VERIFIED and the pricing and billing questions are answered. |
| Depends on | Phase 3 VERIFIED. Q-005, Q-006, Q-007, Q-009, Q-014, Q-015, Q-026 answered. |
| Unblocks | Phase 5, and the **paid launch gate** |
| Last updated | 2026-09-23 |

---

## 1. Goal

Launch a **paid Pro plan** whose every limit is enforced server-side:

- permanent accounts, with a safe upgrade path from anonymous devices,
- a complete entitlements engine,
- merchant-of-record billing,
- the Pro feature set (5 GB files, 30/90-day expiry, passwords, private rooms, room links, history, device management).

**Rooms start here.** Free local mode has no rooms (CR-001). Pro private rooms are membership-based, joined by invite or QR pairing, reachable from any network, and never visible on a network. They are a separate feature from local mode, not an approval step for it.

## 2. Scope (by milestone)

| Milestone | Contents |
|---|---|
| **4A — Accounts** | Sign-in methods per Q-014 (proposed: email magic link + Google). Anonymous → permanent upgrade keeping the user ID (`linkIdentity`/`updateUser`). **Merge flow** when signing into an existing account from an anonymous device (proof via the still-valid anonymous token; transactional move of shares, storage usage, devices and any private-room memberships; anonymous user deleted). A signed-in user's "My uploads" covers shares from all their devices. `profiles`. Device list and revoke (10-device cap). Account deletion (grace, then cascade and end of content). Custom SMTP (SPF/DKIM/DMARC). Optional TOTP MFA (required for operators). |
| **4B — Entitlements** | `plans.ts`, `resolve.ts`, overrides, snapshots, the error contract ([07 §4](../07-plans-and-entitlements.md#4-server-side-error-contract-for-plan-limits)). **Retrofit enforcement into every existing write path.** `GET /me/entitlements`. UI gating and upgrade prompts. Pricing page. |
| **4C — Billing** | Provider integration (Q-005): checkout, customer portal, signed webhooks, idempotent `billing_events`, order-safe `subscriptions`, grace handling, daily reconciliation. Downgrade behaviour ([07 §5](../07-plans-and-entitlements.md#5-upgrades-downgrades-and-over-quota-behaviour)). Sandbox in staging. |
| **4D — Pro features** | Multipart uploads up to 5 GB with resume (IndexedDB state, part presign batches, `ListParts` verification). Expiry options 30/90 days and **extend** (copy between retention prefixes). **Link passwords** (Argon2id, versioned grants, lockouts). **Private rooms**: the `rooms`, `room_members` and `room_invites` tables, the `room:` realtime topic, QR pairing invites (single use, 10 min) and **multi-use invite links** (≤ 7 days). Never visible on any network. **Custom room names**. **Read-only room links** (private rooms only; never a network feed). **Transfer history** UI (shares and download events, ≤ plan retention). Burn after download enabled for Pro. Optional web admin for operators (MFA required). |

### Out of scope

Workspaces and seat billing (Phase 5). Malware scanning (Phase 6). Custom domains.

## 3. Existing system state (expected at start)

Phases 1–3: anonymous devices, automatic local visibility with network spaces and guards, links, codes, link-only shares, burn, janitor, retention. No rooms yet. Entitlements resolve to Free only.

## 4. What will be changed

Auth pages and callbacks. Settings (account, devices, billing), history and pricing pages. Entitlement checks in all services. Multipart uploader. Link password flows. Room-link and private-room support. Billing routes and webhook processing.

## 5. What will NOT be changed

- The local visibility model (DEC-031, DEC-032), link format and burn semantics (no change record expected). Pro adds private rooms beside local mode; it does not add an approval step to local mode.
- **Existing shares and links keep their snapshot behaviour.** No retroactive changes when plans change.

## 6. Architecture decisions involved

DEC-005 (upgrade and merge), DEC-018, DEC-019, DEC-021, DEC-023, DEC-026 (multipart), DEC-010 (extend by copy).

## 7. Files / modules involved

See [05 §6 — Phase 4](../05-implementation-roadmap.md#phase-4). Key modules:

- `lib/server/entitlements/*`, `lib/server/billing/*`, `lib/server/accounts/{merge.ts, delete.ts}`
- `lib/server/links/password.ts`, `lib/server/storage/multipart.ts`, `lib/client/uploader-multipart.ts`
- `app/(auth)/**`, `app/(app)/settings/**`, `app/(app)/history/page.tsx`, `app/(marketing)/pricing/page.tsx`

## 8. Database changes

- New tables: `rooms`, `room_members`, `room_invites`, `profiles`, `subscriptions`, `billing_customers`, `billing_events`, `entitlement_overrides`.
- New columns: `shares.room_id` and scope `room`, multipart columns on `files`, password columns on `share_links` (if not already present), room-link support (`target_type = 'room'`).
- The `room` branch of `app_realtime.can_access_topic`.
- Merge and account-deletion functions.

## 9. API changes

Phase 4 rows in [02 §6.2](../02-system-architecture.md#62-endpoint-catalogue-by-phase): private rooms (CRUD, members, invites and accept, room shares), `me`, `merge-anonymous`, history, billing (checkout, portal, webhook), link PATCH (password, expiry), room links, multipart (init, parts, complete, abort), extend, optional admin.

## 10. Security considerations

- Entitlements are **only** derived from webhook-updated subscriptions, never from client redirects.
- Webhooks: signature on the raw body, idempotency, ordering, 5xx on failure for retries.
- The merge flow cannot take over another user's anonymous data (proof required) (RISK-024).
- Passwords: Argon2id, attempt limits, lockouts, no logging.
- Multipart: server-controlled part count and size, verification before completion.
- Account deletion honours legal retention (billing records) and ends content.
- Operator web tools require MFA and an allow-list, and every action is audited.

## 11. Dependencies

- **Phase:** Phase 3 VERIFIED.
- **Business:** registered entity, payment provider account, tax setup (Q-005), final prices (Q-006).
- **Packages (to be approved):** `@node-rs/argon2`, the billing provider SDK, `idb-keyval`, an email template library (optional).

## 12. Testing requirements

- T-050 … T-053, T-034 (private-room invites).
- IDOR matrix extended with private-room actors (member, owner, removed member, non-member).
- Multipart: extra or undersized parts rejected, resume after reload, abort cleanup.
- Password lockouts.
- Room-link isolation (viewers see the room's shares but not members or requests).
- Billing lifecycle in sandbox: new subscription, renewal, failed payment → grace → downgrade, cancel at period end, refund, duplicate and out-of-order webhooks.

## 13. Acceptance criteria (outline, refined before start)

| ID | Criterion |
|---|---|
| AC-4.1 | Anonymous → account upgrade keeps all shares and private-room memberships. The merge into an existing account is proof-based and transactional (T-053). |
| AC-4.2 | Every row of [07 §3](../07-plans-and-entitlements.md#3-enforcement-points) has passing negative tests (T-050) |
| AC-4.3 | Billing lifecycle verified in sandbox and with one real production transaction. Redirects never grant Pro (T-052). |
| AC-4.4 | Downgrade behaviour matches [07 §5](../07-plans-and-entitlements.md#5-upgrades-downgrades-and-over-quota-behaviour) (T-051) |
| AC-4.5 | A 5 GB upload succeeds with resume on desktop. Lying-client multipart attempts are rejected. |
| AC-4.6 | Password links, private rooms, invite links, room links, custom names and history work, and are denied for Free |
| AC-4.7 | Account deletion and data-deletion runbook verified |
| AC-4.8 | Paid launch gate ([05 §4](../05-implementation-roadmap.md#4-release-gates)) complete |

## 14. Known risks

RISK-015 (pricing), RISK-019 (email), RISK-024 (merge), RISK-020 (scope: this is the largest phase, so milestones 4A–4D can be verified separately if the owner prefers).

## 15. Open questions

Q-005, Q-006, Q-007, Q-009, Q-014, Q-015, Q-026.

## 16. Implementation status

| Date | Status | Note |
|---|---|---|
| 2026-09-17 | PLANNED | Outline drafted |
| 2026-09-23 | PLANNED | CR-001: rooms, members, invites and QR pairing now start here with private rooms |

### Verification record

*Empty until verified.*
