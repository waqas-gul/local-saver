import "server-only";
import { sql } from "kysely";
import type { Caller } from "../auth/device";
import { assertAccount, mfaEnrolled, mfaRequired, type Principal } from "../auth/session";
import { billingProvider } from "../billing/provider";
import { fetchAndSync } from "../billing/sync";
import { getDb } from "../db/client";
import type { Env } from "../env";
import { ApiError, notFound } from "../http/errors";
import { log } from "../log";
import { enforceRateLimit } from "../ratelimit/limits";

/**
 * Account deletion (phase 4 §17.5.7, P4-22; D4-6 and D4-30 as recommended, pending the owner):
 *   DELETE /me                  an account with a recent sign-in (and aal2 when it has an authenticator) schedules its
 *                               deletion GRACE_DAYS ahead (app.request_account_deletion) and stops its subscription
 *                               renewing at the provider;
 *   POST /me/deletion/cancel    until that date, the account cancels it (app.cancel_account_deletion).
 * During the grace the account is read-only (E30, lib/server/entitlements/enforce.ts). After the date, the hourly
 * delete-due-accounts job (app.delete_due_accounts, P4-21) deletes it; nothing here deletes anything, and the client
 * chooses neither the grace nor the date. The account is always the token's: no request names a user.
 * Suspended accounts get 403 USER_SUSPENDED from requireCaller and wait for an operator (DV4-13).
 */

/** D4-6 (recommended): seven days of read-only grace. */
export const GRACE_DAYS = 7;

/** D4-30 (recommended): a sign-in method used within the last 10 minutes. */
export const REAUTH_WINDOW_SECONDS = 600;

/**
 * Whether this token proves a sign-in within the window: an `amr` entry (when Supabase Auth last verified that method
 * for this session) at most REAUTH_WINDOW_SECONDS old. The token is verified, so its entries are Auth's own. An
 * anonymous sign-in proves nothing about an account; a timestamp ahead of the clock counts only within a minute.
 */
export function signedInRecently(principal: Pick<Principal, "amr">, nowSeconds = Date.now() / 1000): boolean {
  return principal.amr.some(
    (entry) =>
      entry.method !== "anonymous" &&
      entry.timestamp > 0 &&
      entry.timestamp <= nowSeconds + 60 &&
      nowSeconds - entry.timestamp <= REAUTH_WINDOW_SECONDS,
  );
}

/** The account no longer exists (deleted while the request ran): the answer its next request gets, as in withApi. */
function callerGone(): ApiError {
  return new ApiError(401, "DEVICE_UNKNOWN", "Unknown device");
}

function deletionPending(scheduledFor: Date): ApiError {
  return new ApiError(409, "DELETION_PENDING", "This account is already being deleted", { scheduledFor: scheduledFor.toISOString() });
}

/** D4-30: an authenticator, when the account has one (requireCaller already refuses aal1 since P4-24), then a recent sign-in. */
async function assertReauthenticated(principal: Principal): Promise<void> {
  if (principal.aal !== "aal2" && (await mfaEnrolled(principal.userId))) throw mfaRequired();
  if (!signedInRecently(principal)) {
    throw new ApiError(403, "REAUTH_REQUIRED", "Sign in again to confirm it's you", { withinSeconds: REAUTH_WINDOW_SECONDS });
  }
}

/**
 * §17.7.6: the account's subscriptions stop renewing (cancelled at period end; Pro lasts until then). Best effort, after
 * the request is stored: a failure is logged, and the daily billing reconciliation cancels what is still renewing for
 * every account in its grace (lib/server/billing/reconcile.ts, step 3).
 */
async function stopRenewals(userId: string, env: Env): Promise<void> {
  if (!env.billing) return;
  const provider = billingProvider(env);
  const { rows } = await sql<{ provider_subscription_id: string }>`
    select s.provider_subscription_id from app.subscriptions s
     where s.provider = ${provider.id} and s.subject_type = 'user' and s.subject_id = ${userId}::uuid
       and s.status in ('trialing', 'active', 'past_due') and not s.cancel_at_period_end
  `.execute(getDb());
  for (const row of rows) {
    try {
      await provider.cancelSubscription(row.provider_subscription_id, { atPeriodEnd: true });
      await fetchAndSync(provider, row.provider_subscription_id);
    } catch (error) {
      log.warn("account.deletion_renewal_not_stopped", { provider: provider.id, err: error });
    }
  }
}

/** DELETE /api/v1/me: 202 { scheduledFor }. */
export async function requestAccountDeletion(caller: Caller, env: Env): Promise<{ scheduledFor: string }> {
  const { principal } = caller;
  assertAccount(principal);
  await assertReauthenticated(principal);
  await enforceRateLimit("requestDeletion", principal.userId);
  const db = getDb();
  const scheduledFor = await db.transaction().execute(async (trx) => {
    // The profile exists for every account (created on first sight). Its row lock orders this request with a
    // concurrent request or cancel (which locks it too); the job skips a locked row.
    const { rows: profiles } = await sql<{ user_id: string | null }>`select p.user_id from app.ensure_profile(${principal.userId}::uuid) p`.execute(trx);
    if (!profiles[0]?.user_id) throw callerGone();
    const profile = await trx
      .selectFrom("app.profiles")
      .select("deletion_scheduled_for")
      .where("user_id", "=", principal.userId)
      .forUpdate()
      .executeTakeFirst();
    // Gone: the job deleted the account while this request waited for its row.
    if (!profile) throw callerGone();
    if (profile.deletion_scheduled_for) throw deletionPending(new Date(profile.deletion_scheduled_for));
    const { rows } = await sql<{ at: Date | null }>`
      select app.request_account_deletion(${principal.userId}::uuid, make_interval(days => ${GRACE_DAYS}::integer)) as at
    `.execute(trx);
    const at = rows[0]?.at;
    if (!at) throw new Error("account deletion was not recorded");
    return new Date(at);
  });
  log.info("account.deletion_requested", { scheduledFor: scheduledFor.toISOString() });
  await stopRenewals(principal.userId, env);
  return { scheduledFor: scheduledFor.toISOString() };
}

/** POST /api/v1/me/deletion/cancel: 204; 404 when nothing is pending; 409 DELETION_DUE once its date has passed. */
export async function cancelAccountDeletion(caller: Caller): Promise<void> {
  const { principal } = caller;
  assertAccount(principal);
  await enforceRateLimit("cancelDeletion", principal.userId);
  await getDb()
    .transaction()
    .execute(async (trx) => {
      // Locked: the job takes the same row (skip locked) before it deletes the account.
      const profile = await trx
        .selectFrom("app.profiles")
        .select(["deletion_scheduled_for", sql<boolean>`deletion_scheduled_for <= now()`.as("due")])
        .where("user_id", "=", principal.userId)
        .forUpdate()
        .executeTakeFirst();
      if (!profile?.deletion_scheduled_for) throw notFound();
      if (profile.due) throw new ApiError(409, "DELETION_DUE", "This account's deletion date has passed; it can't be cancelled any more");
      const { rows } = await sql<{ cancelled: boolean }>`select app.cancel_account_deletion(${principal.userId}::uuid) as cancelled`.execute(trx);
      if (!rows[0]?.cancelled) throw notFound();
    });
  log.info("account.deletion_cancelled", {});
}
