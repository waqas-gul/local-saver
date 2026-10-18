# Runbook — Accounts: authenticator apps, merges, devices

| Field | Value |
|---|---|
| Applies from | Phase 4: §1–§7 with P4-24 (2026-10-18); §8 and §9 with P4-25 (2026-10-18); §9's revoked-token rule with P4-26 (2026-10-18). Built and tested locally only. |
| What | §1–§7: the optional authenticator app (TOTP) on accounts, and the procedure when someone loses theirs (RISK-045; [phase 4 §31](../phases/phase-4-pro-accounts.md#31-phase-4d-eleventh-task-p4-24-mfa-2026-10-18)). §8: merges of a browser's anonymous data into an account (RISK-043; [phase 4 §18](../phases/phase-4-pro-accounts.md#18-phase-4a-implementation-2026-10-16)). §9: devices and sign-in. Billing support: [billing](billing.md). Deletion: [account deletion](account-deletion.md). |
| Tools | The MFA-protected Supabase dashboard (SQL editor, as the project's database owner), or the Auth admin API with the project's secret key from a trusted machine. The app has no operator console (D4-23). |
| Owner | Operator on call: **[OWNER: name and email, Q-022]**. Support address people write to: **[OWNER, Q-022]**. |
| Rehearsed | **No.** Rehearse on staging before launch. |
| Open decisions | RISK-045 (recovery without recovery codes) and the waiting period in §4 wait for the owner. |

## 1. How it works

- **Optional, per account**, in account settings. It uses Supabase Auth's TOTP factor; the key never reaches the app's server.
- **Once it is on, the account uses the app only at `aal2`** (sign-in code and authenticator code):
  - the API answers `403 MFA_REQUIRED` to an `aal1` session on every route;
  - Realtime refuses its topics;
  - the app shows the authenticator step before it loads.
- **Turning it on ends the account's other sessions.** Supabase Auth does this when the first code is confirmed. Those browsers are signed out and sign in again with both codes.
- **Removing it needs `aal2` and a fresh code** in the app. Supabase Auth refuses removal below `aal2`.
- **No recovery codes:** Supabase TOTP has none. Someone who loses the phone needs §4.
- **Auth's own behaviour, worth knowing** ([phase 4 §31.6](../phases/phase-4-pro-accounts.md#316-findings-while-building-and-how-they-were-handled)):
  - a code is accepted again within its 30-second window;
  - the local stack doesn't rate-limit wrong codes; the hosted limit is to be checked (§7).

## 2. Queries

```sql
-- Does an account have an authenticator? (status 'verified' counts; 'unverified' is an abandoned setup)
select f.id, f.factor_type, f.status, f.friendly_name, f.created_at, f.updated_at
  from auth.mfa_factors f join auth.users u on u.id = f.user_id
 where u.email = '<address>';

-- The account's authenticator history in Auth's audit log (set-up started, codes tried, removed).
select created_at, payload ->> 'action' as action, ip_address
  from auth.audit_log_entries
 where payload ->> 'actor_id' = '<user id>'
   and payload ->> 'action' in ('factor_in_progress', 'verification_attempted', 'factor_unenrolled')
 order by created_at desc limit 50;

-- The account's sessions and their assurance level.
select id, aal, created_at, updated_at from auth.sessions where user_id = '<user id>' order by created_at desc;
```

## 3. Before anything: who is asking

**The address is the only proof.** An authenticator protects against someone who has the email code but not the phone, so removing it on request must not be easier than having both.
- Only act on a request **from the account's own address** (§2's query finds the account by email).
- **Reply to that address** asking for confirmation. Don't act on the first message alone.
- **Never** act on a request from another address, a phone call or a chat, whatever it says.

## 4. Lost authenticator (RISK-045)

1. **Verify** (§3). Ask the person to sign in once by email code in a browser at an agreed time. It stops at the authenticator step, which is expected. A new session in §2's query at that time shows they have the mailbox.
2. **Notify and wait (recommended; owner decision).**
   - Reply to the address: "Someone asked to remove the authenticator app from this account. If it wasn't you, reply now."
   - Wait 24 hours. Someone who briefly got into the mailbox then has to keep it a day.
3. **Remove the factor**, whichever way is available:
   - **Auth admin API** (secret key, trusted machine). Deleting a verified factor also signs the user out everywhere:

     ```js
     const { createClient } = require("@supabase/supabase-js");
     const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
     const { data, error } = await admin.auth.admin.mfa.listFactors({ userId: "<user id>" });
     if (error) throw error;
     for (const factor of data.factors) await admin.auth.admin.mfa.deleteFactor({ userId: "<user id>", id: factor.id });
     ```

   - **SQL** (as the database owner), if the API isn't at hand:

     ```sql
     delete from auth.mfa_factors where user_id = '<user id>';   -- its challenges go with it
     delete from auth.sessions where user_id = '<user id>';      -- sign out everywhere, as the API does
     ```

4. **Tell the person** they can sign in with the email code, and should set up a new authenticator in account settings.
5. **Record it** in the support log: who asked, from which address, when it was verified, who removed it. Auth's audit log shows `factor_unenrolled` only when the user removes a factor themselves.

## 5. Someone else's authenticator on the account, or a takeover

When the owner can't sign in because an authenticator they didn't add asks for a code, or someone else used the account:
1. Verify the owner (§3, §4.1).
2. Remove every factor (§4.3).
3. Sign out every browser of the account, so no device survives:

   ```sql
   select app.revoke_device(d.user_id, d.id, 'operator', null)
     from app.devices d where d.user_id = '<user id>' and d.revoked_at is null;
   ```

   `revoke_device` deletes each device's Auth session and audits `device.revoked` (operator).
4. Open an incident ([incident](incident.md)) if anything was shared from the account in the meantime: its shares and links are in the account's history.

## 6. Operators' own MFA

| Where | Requirement | State |
|---|---|---|
| Supabase organisation | MFA required for every dashboard member (organisation setting) | **Owner item**, not configured (no hosted project) |
| Billing provider dashboard | MFA (B15) | Owner item, with the provider (Q-005) |
| Cloudflare account | MFA for every member | Owner item |
| The app's own operator console | `aal2` on every request plus an allow-list (§17.8.9) | **Not built**: D4-23 recommends Phase 6; the SQL runbooks are the console |

## 7. Not verified yet

- **Hosted Supabase:**
  - TOTP enrolment and verification on (Authentication → Multi-Factor);
  - its rate limit on wrong codes;
  - that confirming the first factor ends the account's other sessions there too;
  - the admin API calls in §4.
- **Staging rehearsal:** a lost-authenticator request end to end.
- **Merges and devices** (§8, §9): tested locally only (T-053.*, T4-A7 … A9); real phones and real email not tried (AC-4.1).

## 8. Merges: a browser's anonymous data into an existing account

**How it works** ([ARCHITECTURE §5.3](../ARCHITECTURE.md#53-authentication-and-sessions)):
- Someone with anonymous posts in a browser signs in, in that browser, to an email that already has an account. The browser's anonymous data moves into the account: shares, links, room memberships, the storage ledger, today's upload volume and the device itself. It happens in one transaction: any failure moves nothing.
- **The proof is the browser's.** Before signing in, the anonymous session makes a **merge intent**: one per anonymous user, bound to that browser's device, valid 24 hours. Its secret is kept only in that browser (`local-saver.merge-intent`), stored as an HMAC under `LINK_PEPPER`.
- After signing in, the browser redeems it, and **retries at every start for 24 hours**: offline, a server error, the device cap, or the authenticator step on an account with MFA.
- **Refused for good:** expired, already used for another account, or either side suspended (`USER_SUSPENDED`, D4-4). Nothing moves, and the anonymous data stays where it was.
- **The anonymous user is deleted by the merge.** Its audit events keep its ID.
- While an intent is open, `cleanup-anonymous-users` never deletes its anonymous user (RISK-043). Open intents become `expired` after 24 hours, and ended intents are deleted 30 days later.

**Queries:**

```sql
-- Merges into an account: when, from which anonymous user, what moved.
select occurred_at, metadata ->> 'anonUserId' as anon_user_id, metadata
  from app.audit_events where action = 'account.merged' and target_id = '<account user id>' order by occurred_at desc;

-- An anonymous user's intents (open, completed, revoked, expired).
select id, status, anon_device_id, target_user_id, created_at, expires_at, completed_at, result
  from app.merge_intents where anon_user_id = '<anonymous user id>' order by created_at desc;

-- Intents still open, and when they lapse.
select id, anon_user_id, created_at, expires_at from app.merge_intents where status = 'open' order by expires_at;
```

**"My posts from before I signed in are missing."**
1. Find the account (`select id from auth.users where email = '<address>';`) and its merges (above).
2. **A merge is there:** its `shares` count says what moved. The posts are in My uploads on every browser of the account.
3. **No merge:**
   - within 24 hours of the sign-in, ask them to open the app again **in the same browser**: it retries;
   - the account at its device cap (10): they revoke a browser in `/settings/devices`, then reopen the app;
   - an account with an authenticator: they complete the authenticator step first;
   - after 24 hours, or if they cleared the browser's data, it can't be merged. The posts still work by their links and codes, and expire on schedule. They can post again from the account.
4. **There is no operator merge, by design** (RISK-024): the proof is the browser's secret. **Never move rows between users by hand.** The merge covers every table that holds a user ID (checked by a coverage test). A hand-made move would miss some and break quota and ownership.

## 9. Devices and sign-in

- **An account has up to 10 browsers** (D4-5); anonymous browsers have no cap. The account lists and revokes them in `/settings/devices`. Revoking deletes the browser's Auth session. Its access token stays valid until it expires (at most an hour) but is refused everywhere: on every route, the device list and revocation included since P4-26, and on Realtime. Signing out in the app revokes the browser's device first, so it is refused the same way. Always end a browser with `revoke_device` (below, §5), never with Auth's own sign-out alone: a session Auth ends by itself leaves its device active, and its token works on the routes that need a device until it expires ([ARCHITECTURE §17.3](../ARCHITECTURE.md#173-known-gaps-and-accepted-risks-in-the-current-code)).
- **Revoke one browser for someone** (verified as in §3; to sign out every browser, §5 step 3):

  ```sql
  select id, label, platform, created_at, last_seen_at, revoked_at, revoked_reason
    from app.devices where user_id = '<user id>' order by last_seen_at desc nulls last;
  select app.revoke_device('<user id>', '<device id>', 'operator', null);
  ```

- **Sign-in** is by email code: 6 digits, valid an hour, one email per address every 60 seconds; a newer code replaces the older one. Google sign-in works once its OAuth client exists. The app offers no passwords, and refuses password sessions (D4-2). Codes that don't arrive: [`infra/email/README.md`](../../infra/email/README.md) §8.
- **Changing the address** is done in account settings through Supabase Auth. Both addresses confirm (secure email change, 08 §5).
