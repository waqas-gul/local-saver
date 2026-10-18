import "server-only";
import { sql } from "kysely";
import { getDb } from "../db/client";
import { log } from "../log";
import { timingSafeEqualString } from "../security/crypto";
import { fetchAndSync, syncSubscription, type SyncOutcome } from "./sync";
import { SubscriptionNotFoundError, type BillingProvider } from "./types";

/**
 * Daily billing reconciliation (phase 4 §17.7.7, D4-22, B12): pg_cron → run_job →
 * trigger_billing_reconcile → pg_net → POST /api/v1/internal/billing/reconcile → this, after the
 * response. It repairs what webhooks missed:
 *   1. every subscription the provider changed since the last success (minus a day) is applied;
 *   2. every local subscription in an entitled state that the provider hasn't confirmed for 36 hours
 *      is fetched again (a cancellation that never arrived, a grace period gone stale);
 *   3. an account in its deletion grace whose subscription still renews is cancelled at period end
 *      at the provider (§17.7.6: the request's own cancellation is retried here).
 * One run at a time (app.begin_billing_reconcile); the 'billing-reconcile' heartbeat feeds
 * /health/cron. Counts only: no IDs in the result.
 */

export type ReconcileCounts = {
  listed: number;
  refetched: number;
  deletionCancels: number;
  applied: number;
  unchanged: number;
  stale: number;
  unknown: number;
  errors: number;
};

const STALE_AFTER = "36 hours";

/** Constant-time check of the route's bearer secret against the current and previous one. */
export function reconcileAuthorized(header: string | null, secrets: readonly string[]): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? "");
  if (!match) return false;
  let ok = false;
  // Compared with every secret, so the time doesn't reveal which one matched.
  for (const secret of secrets) {
    if (timingSafeEqualString(match[1] as string, secret)) ok = true;
  }
  return ok;
}

/** Claims the run; null when another run holds it. */
export async function beginReconcile(): Promise<{ updatedSince: Date | null } | null> {
  const { rows } = await sql<{ started: boolean; updated_since: Date | null }>`
    select started, updated_since from app.begin_billing_reconcile()
  `.execute(getDb());
  const row = rows[0];
  return row?.started ? { updatedSince: row.updated_since } : null;
}

function tally(counts: ReconcileCounts, outcome: SyncOutcome) {
  if (outcome === "applied") counts.applied += 1;
  else if (outcome === "unchanged" || outcome === "already_finished") counts.unchanged += 1;
  else if (outcome === "stale") counts.stale += 1;
  else counts.unknown += 1;
}

export async function runReconcile(provider: BillingProvider, updatedSince: Date | null): Promise<ReconcileCounts> {
  const counts: ReconcileCounts = { listed: 0, refetched: 0, deletionCancels: 0, applied: 0, unchanged: 0, stale: 0, unknown: 0, errors: 0 };
  let failure: string | null = null;
  try {
    // 1. Everything the provider changed since the last success.
    let cursor: string | undefined;
    do {
      const page = await provider.listSubscriptions({ updatedSince, cursor });
      for (const sub of page.items) {
        counts.listed += 1;
        try {
          tally(counts, (await syncSubscription(provider, sub)).outcome);
        } catch (error) {
          counts.errors += 1;
          log.error("billing.reconcile_item_failed", { provider: provider.id, err: error });
        }
      }
      cursor = page.next;
    } while (cursor);

    // 2. Entitled subscriptions the provider hasn't confirmed for 36 hours (the same states as
    //    app.entitlement_state's).
    const unseen = await sql<{ provider_subscription_id: string }>`
      select s.provider_subscription_id from app.subscriptions s
       where s.provider = ${provider.id}
         and s.synced_at < now() - ${STALE_AFTER}::interval
         and (s.status in ('trialing', 'active')
              or (s.status = 'past_due' and s.grace_until > now())
              or (s.status = 'canceled' and s.current_period_end > now()))
       order by s.synced_at
    `.execute(getDb());
    for (const row of unseen.rows) {
      counts.refetched += 1;
      try {
        tally(counts, (await fetchAndSync(provider, row.provider_subscription_id)).outcome);
      } catch (error) {
        counts.errors += 1;
        log.error("billing.reconcile_item_failed", { provider: provider.id, err: error });
      }
    }

    // 3. Accounts being deleted keep Pro until their period ends, but don't renew (§17.7.6).
    const deleting = await sql<{ provider_subscription_id: string }>`
      select s.provider_subscription_id from app.subscriptions s
        join app.profiles p on p.user_id = s.subject_id
       where s.provider = ${provider.id} and s.subject_type = 'user'
         and p.deletion_requested_at is not null
         and s.status in ('trialing', 'active', 'past_due') and not s.cancel_at_period_end
    `.execute(getDb());
    for (const row of deleting.rows) {
      counts.deletionCancels += 1;
      try {
        await provider.cancelSubscription(row.provider_subscription_id, { atPeriodEnd: true });
        tally(counts, (await fetchAndSync(provider, row.provider_subscription_id)).outcome);
      } catch (error) {
        if (error instanceof SubscriptionNotFoundError) {
          counts.unknown += 1;
          continue;
        }
        counts.errors += 1;
        log.error("billing.reconcile_item_failed", { provider: provider.id, err: error });
      }
    }
    if (counts.errors > 0) failure = "items_failed";
  } catch (error) {
    failure = "provider_failed";
    log.error("billing.reconcile_failed", { provider: provider.id, err: error });
  }

  await sql`
    select app.finish_billing_reconcile(${failure === null}, ${JSON.stringify(counts)}::jsonb, ${failure})
  `.execute(getDb());
  log.info("billing.reconcile_finished", { provider: provider.id, ok: failure === null, ...counts });
  return counts;
}
