# Runbook — Account deletion

| Field | Value |
|---|---|
| Applies from | Phase 4, P4-22 (2026-10-18); P4-25 (2026-10-18) added how long kept records last (§2), browsers without an account (§8) and the billing runbook. Built and tested locally only. |
| What | How accounts are deleted: the request, the 7-day grace, the hourly job, and what an operator does around them ([phase 4 §29](../phases/phase-4-pro-accounts.md#29-phase-4d-ninth-task-p4-22-the-account-deletion-flow-2026-10-18)). |
| Tools | The MFA-protected Supabase dashboard (SQL editor, as the project's database owner). The app's role (`app_server`) can request and cancel a deletion but **cannot run the job**. |
| Owner | Operator on call: **[OWNER: name and email, Q-022]** |
| Rehearsed | **No.** The rehearsal on staging (AC-4.7: the janitor deleting objects on R2, billing records kept) waits for staging. |
| Open decisions | D4-6 (grace length, what "read-only" covers, suspended accounts) and D4-30 (re-authentication) are built as recommended and wait for the owner. |

## 1. The user's flow

1. **Request.** In account settings → **Delete account**: the person reads what happens, types `DELETE` and confirms.
   - The server (`DELETE /api/v1/me`) needs a sign-in from the last 10 minutes. If it is older, the app emails a 6-digit code to the account's address; entering it signs the browser in again.
   - An account with an authenticator (TOTP) must also be at `aal2`.
   - Anonymous browsers and suspended accounts can't ask.
2. **Grace: 7 days.**
   - The account is **read-only**: no new shares, texts, links, rooms, invites, room links or checkout (`403 ACCOUNT_DELETION_PENDING`). Text edits, new codes on existing links, extending a share and finishing an upload begun earlier still work (DV4-26; extending: phase 4 §22.3).
   - Everything already shared keeps working for everyone.
   - Every page shows a banner with the date and **Cancel deletion**.
   - A Pro subscription is cancelled at the end of its period at the provider at once. If the provider fails, the daily billing reconciliation retries for every account in its grace.
3. **Cancel.** Until the date, the account cancels from the banner (`POST /api/v1/me/deletion/cancel`). After the date, cancelling is refused (`409 DELETION_DUE`), by the app and by the database function.
4. **Deletion.** The first hourly run after the date deletes the account (§2). Its browsers are signed out: their next start, or their next request, finds the session gone and starts again without an account.

Audit events: `account.deletion_requested` and `account.deletion_cancelled` (the user), `account.deleted` (system, counts only), plus one `share.ended` per share and `room.deleted` per room.

## 2. The job

| Job | Schedule (UTC) | Command |
|---|---|---|
| `delete-due-accounts` | `23 * * * *` (hourly) | `select app.run_job('delete-due-accounts')` → `app.delete_due_accounts(100)` |

For each account past its date, oldest first, except suspended ones, the job:
- deletes the account's open rooms: their shares end, links and invites are revoked, members removed;
- ends its open shares: files are queued for the storage janitor, links revoked;
- finishes the burn claims it holds on other people's shares;
- removes its identity from other people's records (download log, claims, room removals, text edits); the records stay, saying what happened, not who;
- deletes its reservations, merge intents, devices, quota row and profile;
- deletes the Auth user: sessions, identities, flags and memberships in other rooms go with it.

**Kept:** audit events, billing records (subscriptions, customers, checkouts, events, disputes), operator overrides, abuse reports, and the payer on ended shares until those are purged on their own dates. Reported and held shares keep their evidence rules (D-2, D-3).

How long what is kept lasts, as built (no job exists where it says so):

| Record | Kept for |
|---|---|
| Ended shares (records, downloads, links, grants; the files and text go when the share ends) | The share's snapshot after it ends: 30 days on Free, 365 days on Pro (`purge-tombstones`); never while reported or held (D-3) |
| Audit events | 90 days; `admin.*` and `report.*` events, and events about reported or held shares, are never purged (D-3) |
| Billing webhook events | 400 days |
| Billing checkouts | 30 days |
| Subscriptions, billing customers, lost disputes | **No deletion job.** The accounting period is an owner and legal decision (**[OWNER]**, Q-022). |
| Operator overrides | **No deletion job** |
| Abuse reports | **No deletion job** (legal advice, Q-022) |
| Merge intents | 30 days after they end |

The run records a heartbeat. `/api/v1/health/cron` answers 503 with `jobs: failing` when its last run failed ([monitoring](monitoring.md)).

## 3. Queries

```sql
-- Scheduled deletions, soonest first; due = the date has passed.
select p.user_id, u.email, p.deletion_requested_at, p.deletion_scheduled_for, p.deletion_scheduled_for <= now() as due,
       f.suspended_at is not null as suspended
  from app.profiles p join auth.users u on u.id = p.user_id
  left join app.user_flags f on f.user_id = p.user_id
 where p.deletion_scheduled_for is not null
 order by p.deletion_scheduled_for;

-- Overdue: due for more than two hours and still here (a failing job, or a suspended account waiting for an operator).
select p.user_id, p.deletion_scheduled_for, f.suspended_at
  from app.profiles p left join app.user_flags f on f.user_id = p.user_id
 where p.deletion_scheduled_for < now() - interval '2 hours';

-- The job's last runs.
select last_started_at, last_succeeded_at, last_failed_at, last_error, last_result
  from app.job_heartbeats where job = 'delete-due-accounts';

-- One account's trail.
select occurred_at, action, actor_kind, metadata from app.audit_events
 where target_id = '<user id>' and action like 'account.%' order by occurred_at;
```

## 4. Running the job by hand

```sql
select app.run_job('delete-due-accounts');
select last_succeeded_at, last_failed_at, last_error, last_result from app.job_heartbeats where job = 'delete-due-accounts';
```

- It deletes only accounts whose date has passed, at most 100 per run. Run it again for more.
- **Never** delete an account another way: not `delete from auth.users`, not the Supabase dashboard's "Delete user". Those skip the rooms, shares, claims and records above. An open room even makes the direct delete fail (`rooms_owner_while_open`).
- The job only reclaims and tidies. The storage janitor deletes the files afterwards ([janitor](janitor.md)).

## 5. A failing run

One account that fails rolls back the **whole run**: no due account is deleted until it is fixed. `last_error` says what failed, but not which account.

1. Find the account. This tries each due account on its own and commits nothing:

   ```sql
   begin;
   do $$
   declare r record;
   begin
     for r in select p.user_id from app.profiles p
               where p.deletion_scheduled_for <= now()
                 and not exists (select 1 from app.user_flags f where f.user_id = p.user_id and f.suspended_at is not null)
               order by p.deletion_scheduled_for loop
       begin
         -- Inside this block only this account is due; the exception undoes everything.
         update app.profiles set deletion_scheduled_for = now() + interval '100 years'
          where deletion_scheduled_for <= now() and user_id <> r.user_id;
         perform app.delete_due_accounts(1);
         raise exception 'ok';
       exception when others then
         raise notice '% → %', r.user_id, case when sqlerrm = 'ok' then 'ok' else sqlstate || ' ' || sqlerrm end;
       end;
     end loop;
   end $$;
   rollback;
   ```

2. Fix the cause (it is a bug: open an incident, [incident](incident.md)).
3. Only if the others can't wait: postpone the failing account by a day, write down why in the incident, run the job (§4), and bring the date back once fixed:

   ```sql
   update app.profiles set deletion_scheduled_for = now() + interval '1 day' where user_id = '<user id>';
   ```

## 6. Suspended accounts

**D4-6 is not decided yet** (DV4-13):
- a suspended account can't request or cancel (`403 USER_SUSPENDED`);
- a deletion scheduled before the suspension waits: the job skips the account.

Deleting the Auth user also deletes its suspension record (`app.user_flags`), which may be evidence (D-3, D-9). Until the owner decides:
- keep it;
- if legal review allows the deletion: copy the suspension record (`select * from app.user_flags where user_id = '<id>'`) into the incident notes, lift the suspension (`update app.user_flags set suspended_at = null where user_id = '<id>'`), and let the next run delete the account.

## 7. Evidence and billing

- **Reported shares** (D-3) and **held objects** (D-2) keep their rules when their creator is deleted:
  - the share ends, but the tombstone purge skips shares with reports;
  - the janitor never deletes an object on legal hold.
- **Billing records** keep the user's UUID with no foreign key (accounting law). The provider keeps invoices.
- **A subscription still renewing for a deleted account** should not exist: the request cancels it, and reconciliation retries daily. Check:

  ```sql
  select s.provider, s.provider_subscription_id, s.status, s.current_period_end
    from app.subscriptions s
   where s.subject_type = 'user' and s.status in ('trialing', 'active', 'past_due') and not s.cancel_at_period_end
     and not exists (select 1 from auth.users u where u.id = s.subject_id);
  ```

  Cancel any it finds in the provider's dashboard, then let the next reconciliation sync it ([billing](billing.md) §5).

## 8. Requests from people

- **"Delete my account" by email**, when the person can't sign in:
  1. Verify that the request comes from the account's address: reply to it and ask for confirmation, or have them sign in once.
  2. Record the request in the support log.
  3. Schedule it with the same grace. Both functions audit as the user:

     ```sql
     select app.ensure_profile('<user id>');
     select app.request_account_deletion('<user id>', interval '7 days');
     ```

  4. Tell the person the date, and that signing in shows a banner where they can cancel.
- **Cancel on their behalf**, during the grace: `select app.cancel_account_deletion('<user id>');` (returns false after the date).
- **Find the account by email:** `select id from auth.users where email = '<address>';`
- **Data export** (a copy of their data) is not built. Answer it by hand from the queries above and the person's shares, until a later phase builds it.
- **Someone without an account** (an anonymous browser) can't be verified: nothing links a person to an anonymous user except that browser. Tell them:
  - delete their shares from My uploads in that browser, which ends them for everyone;
  - everything else expires on schedule;
  - an anonymous user with nothing open is deleted after 30 days without a visit (`cleanup-anonymous-users`);
  - clearing the browser's data drops the identity at once, but not the posts.

  An operator who can tie a share to the request (a link the person sends) can end it with `admin_block_share`, then release its hold with `admin_release_hold`, so the janitor deletes the files ([takedown](takedown.md) §3, §4). Both functions audit as the operator. There is no operator function that ends a share without the hold.
- **Legal requests** (rights under data-protection law, authorities): the contact and the procedure are **[OWNER, Q-022]**.

## 9. Not verified yet

- **Hosted Supabase:** that the migration role may delete from `auth.users` (S4-2).
- **R2:** the janitor deleting the objects (AC-4.7).
- **Real email and Google:** a Google-only account confirms with an email code too; not tried with real Google.
- **Staging rehearsal:** request, cancel, deletion, billing records kept (AC-4.7).
