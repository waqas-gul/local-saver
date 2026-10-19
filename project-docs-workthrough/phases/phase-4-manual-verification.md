# Phase 4 — Manual, staging and production verification procedure

| Field | Value |
|---|---|
| Purpose | Close what the Phase 4 acceptance criteria ([phase 4 §13](phase-4-pro-accounts.md#13-acceptance-criteria-outline-refined-before-start), gates in [§17.20](phase-4-pro-accounts.md#1720-acceptance-gates)) need beyond the local automated suites: **AC-4.1** on hosted Supabase, real email, Google and real phones; **AC-4.2** spot checks on staging; **AC-4.3** the provider's sandbox (T4-B6) and one real transaction (T4-B7); **AC-4.4** a downgrade through a real cancellation; **AC-4.5** a 5 GiB upload to R2 in four desktop browsers; **AC-4.6** on staging and real phones; **AC-4.7** the deletion rehearsal; **AC-4.8** the paid launch gate |
| Status | **BLOCKED.** Nothing here has been run. The prerequisites (§1) don't exist yet: no staging project, no SMTP provider or domain, no Google OAuth client, no billing provider (Q-005, so no P4-13 adapter), no real-device session. |
| Written | 2026-10-18 (P4-26, [phase 4 §33](phase-4-pro-accounts.md#33-phase-4-final-task-p4-26-final-verification-2026-10-18)) |
| Who runs it | The owner, or a tester and an operator the owner names (Q-022), with a laptop (Chrome, Edge, Firefox; a Mac for Safari), an iPhone and an Android phone |
| Rule | Record what actually happened, including failures. Local runs, emulated phones and the fake billing provider are **not** evidence for these steps. |

The automated checks that already cover parts of these criteria are in phase 4 §18 … §33; the final local run is [§33.5](phase-4-pro-accounts.md#335-the-final-run). They don't replace any step below.

---

## 1. Prerequisites

Everything in [Phase 3's prerequisites](phase-3-manual-verification.md#1-prerequisites), plus:

| # | Prerequisite | Where it's specified |
|---|---|---|
| PR4-1 | The hosted Supabase **staging** project with all Phase 4 migrations applied (19 at the end of Phase 4, `20261018200000_phase4_device_routes.sql` last) and the Auth settings of 08 §5, Phase 4A list included | [08 §5](../08-deployment-and-operations.md#5-supabase-configuration-checklist) |
| PR4-2 | **Email:** an SMTP provider (D4-8), a sending domain (Q-020) with SPF, DKIM and DMARC, configured in Auth with the five templates | [`infra/email/README.md`](../../infra/email/README.md) §4, §5 |
| PR4-3 | A **Google OAuth client** for staging, with Supabase's callback as its authorised redirect; the Google provider on in Auth | 08 §5; [secret rotation](../runbooks/secret-rotation.md) |
| PR4-4 | **Billing:** the provider chosen (Q-005), **P4-13's adapter built**, a sandbox account with the product and prices (Q-006), the webhook endpoint registered, the `BILLING_*` secrets, the Vault secrets and the `billing_reconcile` flag on | [billing runbook](../runbooks/billing.md) §8 |
| PR4-5 | **Cloudflare** in front of staging: Access with a bypass for `/api/v1/billing/webhook`; no caching of `/api/*`, `/auth/*`, `/s/*`, `/j/*`, `/c*`, `/rooms/*`, `/history` or HTML; the rate-limit rule covering `/links/*/password`; Turnstile widgets for staging | [08 §4](../08-deployment-and-operations.md#4-cloudflare-configuration-checklist) |
| PR4-6 | The staging R2 bucket with Phase 4's lifecycle rules (`d30/` 31 days, `d90/` 91 days, incomplete multipart uploads aborted after 1 day) and CORS (`ETag` exposed); the janitor deployed with its own R2 token | [08 §6](../08-deployment-and-operations.md#6-r2-configuration-checklist); [janitor](../runbooks/janitor.md) §2 |
| PR4-7 | **Devices:** an iPhone and an Android phone (current OS versions), each able to switch between Wi-Fi and mobile data; a laptop with Chrome, Edge and Firefox, and a Mac with Safari | §17.24 |
| PR4-8 | A named operator, the support address and the alert recipient (Q-022, D-5); every member of the Supabase organisation using dashboard MFA | [accounts runbook](../runbooks/accounts.md) §4 |
| PR4-9 | The legal drafts reviewed and their `[OWNER]` items filled (price, provider, refund policy, retention, contacts) | `app/(legal)/*`; phase 4 §32.2 |

## 2. Recording sheet

- Copy into `evidence/phase-4/manual-matrix.md`, one row per step and device. Screenshots go under `evidence/phase-4/manual/`.
- Billing evidence goes in `evidence/phase-4/billing-sandbox.md` (T4-B6) and `evidence/phase-4/billing-production.md` (T4-B7): event IDs and subscription IDs only.
- Email evidence: `evidence/phase-4/email-delivery.md` (E-1 … E-9). The deletion rehearsal: `evidence/phase-4/deletion-rehearsal.md`.
- **Never record** IP addresses, email addresses (write "account A", "account B"), sign-in codes, authenticator keys or codes, access tokens, link secrets, share codes, invite or room-link URLs, object keys, or payment details.

| Date | Step | Device / OS / browser (version) | Network type | Expected | Observed | Pass? | Evidence file | Notes |
|---|---|---|---|---|---|---|---|---|

---

## 3. Staging: hosted Supabase, sign-in, merge and devices (AC-4.1)

**A** = the laptop (Chrome). **B** = the iPhone. **C** = the Android phone. Accounts are made with addresses the tester controls.

| Step | Action | Expected | Evidence |
|---|---|---|---|
| HS-1 | **S4-2.** As the migration role (`postgres`) in the SQL editor: `begin; update auth.users set updated_at = updated_at where id = '<staging test user id>'; delete from auth.sessions where user_id = '<staging test user id>'; delete from auth.users where id = '<staging test user id>'; rollback;` | All three statements succeed (no permission error). The merge, revocation, the password clean-up and the deletion job depend on it. | matrix |
| HS-2 | On A, post a text anonymously, then **Sign in** with a new address by emailed code | The code arrives (§4); the account is created; My uploads still shows the text (same user ID); `GET /me` shows the email | matrix |
| HS-3 | On A, sign out; post anonymously again; sign in to the **existing** account from HS-2 | The merge offer; after the code, the anonymous text is in the account's My uploads; the audit event `account.merged` ([accounts runbook](../runbooks/accounts.md) §8 query) | matrix |
| HS-4 | **S4-10, T4-A1d:** on a fresh browser, upgrade by **Google**; on another, sign in with Google to an account made by email code | The upgrade keeps the user ID (manual linking on); the second sign-in reaches the same account | matrix |
| HS-5 | **S4-10:** with Auth's captcha on, request a sign-in code | The request carries a Turnstile token and succeeds; without one (devtools, blocked widget) Auth refuses it | matrix |
| HS-6 | **F4-2 on hosted:** with the Auth API (not the app), sign an unused address up **with a password**; then the address's owner signs in by code in the app; then try the password session against `GET /api/v1/me` | The app answers `401`; the account's next registration removes the password (`account.password_removed` audit event). Record whether D4-31's Auth hook is in place. | matrix |
| HS-7 | Sign in to one account on A, B and C. On A, Settings → Devices: revoke B | At its next request (any action or a reload), B is signed out and starts again as a new anonymous user; B's old refresh token no longer works | matrix |
| HS-8 | **P4-26 fix on staging:** before HS-7, copy B's access token from its browser storage. After the revocation, call `GET /api/v1/me/devices` and `DELETE /api/v1/me/devices/<A's device id>` with it (through Access with the CI service token) | Both `401 DEVICE_REVOKED`; A is still signed in. Then sign C out and repeat with C's old token: `401 UNAUTHENTICATED` | matrix |
| HS-9 | Sign one account in on 10 browsers or profiles, then an 11th | The 11th gets the device-limit screen, lists the 10 and can revoke one, then continues | matrix |
| HS-10 | Change the account's email in Settings → Account | A code to each address; the change completes only after both (secure email change) | matrix |
| HS-11 | **Realtime on hosted:** two devices of one account on different networks; a room with two members | `net:` shows only the network you're on (T4-A10); a room post appears on the other member's screen within seconds; a removed member's screen drops the room | matrix |

## 4. Staging: email (P4-23, RISK-019)

Run [`infra/email/README.md`](../../infra/email/README.md) §7, **E-1 … E-9**, after its §4 configuration. Record each in `evidence/phase-4/email-delivery.md`.

## 5. Staging: MFA (P4-24, RISK-045)

| Step | Action | Expected | Evidence |
|---|---|---|---|
| MF-1 | Settings → Account → turn on the authenticator with a real authenticator app (scan the QR code) | It turns on with the first code; the account's other browsers are signed out (Auth ends their sessions there too) | matrix |
| MF-2 | Sign in by code on a new browser | The authenticator step shows before the app; a wrong code is refused; the right one opens the app | matrix |
| MF-3 | Enter wrong codes repeatedly | Record when hosted Auth starts refusing (the local stack has no meaningful limit) | matrix |
| MF-4 | Rehearse a lost-authenticator request with the operator ([accounts runbook](../runbooks/accounts.md) §4, §5) through the admin API | The factor is removed only after the identity checks; the audit trail as the runbook says | matrix |
| MF-5 | Remove the authenticator in Settings with a fresh code | Removed; a code from the old entry no longer works | matrix |
| MF-6 | Record the JWT expiry chosen (08 §5) | The window in which an ended session's token still verifies is that expiry | matrix |

## 6. Staging: entitlements and downgrade (AC-4.2, AC-4.4)

| Step | Action | Expected | Evidence |
|---|---|---|---|
| EN-1 | With a Free account: post a file over Free's size, choose 30 days' expiry, make a room, set a link password, open `/history` | Each refused with the upgrade hint; nothing created | matrix |
| EN-2 | Grant the same account Pro by override ([billing runbook](../runbooks/billing.md) §7); repeat EN-1 | Each allowed from the next request; `GET /me/entitlements` shows Pro | matrix |
| EN-3 | Revoke the override with a room, an invite link, a password link and a 90-day share in place | As [07 §5](../07-plans-and-entitlements.md#5-upgrades-downgrades-and-over-quota-behaviour) "Pro → Free" as built: the share keeps its expiry; the password stays enforced (changing it refused, removing it allowed); the room stays usable by its members, the existing invite link works until it expires; a new room, a rename, a new invite link or room link, extend and `/history` are refused | matrix |
| EN-4 | Downgrade through a **sandbox cancellation** (after §7's BS-6) | The same result as EN-3 at the period's end | billing-sandbox |

## 7. Billing: sandbox (T4-B6) and one real transaction (T4-B7) (AC-4.3)

Only after Q-005 and P4-13. Follow the [billing runbook](../runbooks/billing.md) §8; record event and subscription IDs.

| Step | Action | Expected | Evidence |
|---|---|---|---|
| BS-1 | Checkout in the sandbox from `/pricing` → Upgrade | The provider's hosted page; after paying, Pro arrives **by the webhook**, not by the return URL | billing-sandbox |
| BS-2 | Open the success URL with forged parameters, and with none, on a Free account | Nothing changes (T4-B5) | billing-sandbox |
| BS-3 | Let a renewal happen (the sandbox's clock or test card) | Still Pro; `current_period_end` moves | billing-sandbox |
| BS-4 | A failed renewal payment | `past_due`, Pro kept during the 7-day grace; the billing page says so | billing-sandbox |
| BS-5 | Recover the payment; then let another one fail past the grace | Recovered → Pro; past the grace → Free | billing-sandbox |
| BS-6 | Cancel at period end in the portal (*Manage billing*); then resume; then cancel again | Pro until the period ends, then Free (EN-4) | billing-sandbox |
| BS-7 | A full refund; a lost dispute; a second lost dispute | The full refund ends Pro at once; a lost dispute ends Pro; the second restricts uploads (D4-21) | billing-sandbox |
| BS-8 | Disable the webhook endpoint at the provider, make a change, re-enable; run `select app.run_job('trigger-billing-reconcile');` | Reconciliation repairs the missed change; `/api/v1/health/cron` reports `billingReconcile: ok` | billing-sandbox |
| BS-9 | A webhook with a bad signature (from the provider's tooling or by hand) | `400`, nothing stored; the log line `billing.webhook_rejected` ([billing runbook](../runbooks/billing.md) §1, §4) | billing-sandbox |
| BP-1 | **Production:** one real purchase with a real card by the owner | Pro by the webhook | billing-production |
| BP-2 | Cancel it, then refund it in the provider's dashboard | Free after the refund; the records kept ([billing runbook](../runbooks/billing.md) §1) | billing-production |

## 8. Staging: large uploads and extend on R2 (AC-4.5)

| Step | Action | Expected | Evidence |
|---|---|---|---|
| MP-1 | On a Pro account, upload a **5 GiB** file in Chrome; turn the network off mid-way; reload; pick the file again | The upload resumes from the parts already stored and completes; the file downloads with the right size. Record the time. | matrix |
| MP-2 | Repeat MP-1 in Edge, Firefox and Safari | As MP-1 in each (only Chromium ran locally) | matrix |
| MP-3 | **SP-02 on R2:** start an upload and cancel it; start another and abandon it past its deadline | The janitor aborts both with its R2 token; no incomplete upload remains (R2's 1-day rule as backstop) | matrix |
| MP-4 | Extend a 7-day share to 90 days (needs a copy to `d90/`) with a 5 GiB file | The extension completes; record the copy's time against the Edge Function's wall clock; the old key is deleted afterwards | matrix |
| MP-5 | Download a file while its share is being extended by copy | The download completes | matrix |

## 9. Real devices: Pro features (AC-4.1, AC-4.6)

| Step | Action | Expected | Evidence |
|---|---|---|---|
| RD-1 | On B and on C: post anonymously, then upgrade by emailed code; then merge another anonymous phone browser into the account | As HS-2 and HS-3, on each phone | matrix |
| RD-2 | A Pro owner on A makes a room; invites B by invite link (sent by message); B joins on mobile data; C joins on Wi-Fi | Both see the room's posts from either network; posts appear live | matrix |
| RD-3 | **T4-R15, manual half:** on A, *Show QR code*; scan it with B's camera, then with C's; also from a second phone's screen; Wi-Fi and mobile data; normal brightness | The join page opens; nothing joins before **Join**; the code works once (a second phone is refused after the first joins); closing the dialog turns an unused code off | matrix |
| RD-4 | The owner makes a **room link**; open it on B on mobile data | B sees the room's current and new posts, never its name, members or settings; no short code exists for it | matrix |
| RD-5 | Make a **password link**; on C, enter a wrong password 10 times | `LINK_LOCKED` for 15 minutes, then Turnstile is required (real Turnstile); the right password works after it | matrix |
| RD-6 | On B, open `/history` and the account settings at 320 px width | Readable, no horizontal scroll | matrix |
| RD-7 | Account deletion request and cancel on B | The banner and **Cancel deletion** on every page; cancel restores posting | matrix |

## 10. Account deletion rehearsal (AC-4.7)

Follow the [account-deletion runbook](../runbooks/account-deletion.md) on staging, then once in production before the paid launch.

| Step | Action | Expected | Evidence |
|---|---|---|---|
| AD-1 | An account with shares (files on R2), links, a room it owns, a membership in another room, a Pro subscription (sandbox) and downloads by others | — | deletion-rehearsal |
| AD-2 | Request deletion (recent sign-in; `aal2` with an authenticator) | `202` with the date 7 days ahead; read-only; the subscription stops renewing | deletion-rehearsal |
| AD-3 | Wait for the date (7 days; the runbook has no shortcut); the hourly `delete-due-accounts` job runs | Shares ended and their objects deleted by the janitor on R2; owned rooms deleted, memberships gone; devices, profile and Auth user deleted; billing records kept; held or reported evidence kept; the browsers start again without the account | deletion-rehearsal |
| AD-4 | The runbook's checks afterwards (queries in its §5 … §7) | What the runbook says remains, and nothing else | deletion-rehearsal |

## 11. Operations before the paid launch (AC-4.8)

| Step | Action | Expected | Evidence |
|---|---|---|---|
| OP-1 | `/api/v1/health/cron` on staging and production, watched by the external monitor | `ok`, with `billingWebhooks`, `billingReconcile`, `extensions` reported ([monitoring](../runbooks/monitoring.md)); a stopped job emails the alert recipient | matrix |
| OP-2 | Backups: daily on the Pro plan; point-in-time recovery evaluated; a restore drill on staging with Phase 4's tables | Measured RTO and RPO recorded ([restore drill](../runbooks/restore-drill.md)) | matrix |
| OP-3 | Each Phase 4 secret generated per environment and in the inventory ([08 §9.2](../08-deployment-and-operations.md#92-server-only)); a rotation of `BILLING_WEBHOOK_SECRET` rehearsed on staging ([secret rotation](../runbooks/secret-rotation.md)) | Webhooks keep verifying across the rotation | matrix |
| OP-4 | Hosted logging settings (08 §5 "Query logging") checked with Phase 4's routes in use | No secret, password, code or authenticator value in any log | matrix |
| OP-5 | CI runs every Phase 4 suite on a pull request | Green (09 §7: CI has not run Phase 4 yet) | matrix |

## 12. Owner reviews

- **Copy:** every string marked **OWNER REVIEW** in `components/account/copy.ts`, `components/billing/copy.ts`, `components/room/copy.ts`, `components/history/copy.ts`, `components/share/copy.ts`, `components/local/copy.ts` and the components they name. Approved changes are made in code.
- **Legal:** Terms, Privacy, Acceptable use and Report abuse ([phase 4 §32.2](phase-4-pro-accounts.md#322-what-was-done)), the refund policy and the subprocessor list; legal review before the paid launch.
- **Decisions** still open for Phase 4 are listed in [phase 4 §33.8](phase-4-pro-accounts.md#338-remaining-work-owner-decisions-and-risks).

## 13. Closing Phase 4

Phase 4 becomes **VERIFIED** when every row above has a passing record, the paid launch gate ([05 §4](../05-implementation-roadmap.md#4-release-gates)) is complete, and the owner signs the verification record in [phase 4 §16](phase-4-pro-accounts.md#16-implementation-status).
