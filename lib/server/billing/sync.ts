import "server-only";
import { sql, type Transaction } from "kysely";
import { getDb } from "../db/client";
import type { DB } from "../db/types.gen";
import { log } from "../log";
import {
  SubscriptionNotFoundError,
  type BillingProvider,
  type BillingSubject,
  type NormalizedDispute,
  type NormalizedSubscription,
} from "./types";

/**
 * Subscription state synchronization (phase 4 §17.7.5 steps 6–8, §17.7.7). The only caller of
 * app.apply_subscription_state, always with state fetched from the provider: never a webhook
 * payload's copy, a redirect parameter or anything a browser sent (tests/unit/billing-authority.test.ts
 * checks that nothing else calls it). Resolution (4B) then reads the row: there is no other path to Pro.
 */

export type ApplyOutcome = "applied" | "unchanged" | "stale" | "subject_mismatch";
export type SyncOutcome = ApplyOutcome | "unknown_subject" | "unknown_subscription" | "not_our_plan" | "already_finished";
export type EventStatus = "processed" | "ignored_stale" | "ignored_unknown";

export type SyncResult = { outcome: SyncOutcome; subjectId: string | null };

/** What an event becomes once its subscription was synced (§17.7.5 step 8). */
export function eventStatusFor(outcome: SyncOutcome): EventStatus {
  if (outcome === "applied" || outcome === "unchanged" || outcome === "already_finished") return "processed";
  if (outcome === "stale") return "ignored_stale";
  return "ignored_unknown";
}

/**
 * Whose subscription this is (§17.7.2, B13, B16), in order:
 *   1. the subject of our existing row for it: a subscription is never moved to another subject;
 *   2. the subject of our checkout its checkoutRef names; the custom data's own subject must agree;
 *   3. the subject our customer mapping names for its customer.
 * Otherwise unknown: logged, never applied. The custom data's subject alone never decides.
 */
async function resolveSubject(trx: Transaction<DB>, providerId: string, sub: NormalizedSubscription): Promise<BillingSubject | null> {
  const existing = await trx
    .selectFrom("app.subscriptions")
    .select("subject_id")
    .where("provider", "=", providerId)
    .where("provider_subscription_id", "=", sub.id)
    .executeTakeFirst();
  if (existing) return { type: "user", id: existing.subject_id };

  if (sub.checkoutRef) {
    const checkout = await trx
      .selectFrom("app.billing_checkouts")
      .select("subject_id")
      .where("id", "=", sub.checkoutRef)
      .where("provider", "=", providerId)
      .executeTakeFirst();
    if (checkout) {
      if (sub.subject && sub.subject.id !== checkout.subject_id) {
        log.warn("billing.subject_mismatch", { provider: providerId, checkoutRef: sub.checkoutRef });
        return null;
      }
      return { type: "user", id: checkout.subject_id };
    }
  }

  const customer = await trx
    .selectFrom("app.billing_customers")
    .select("subject_id")
    .where("provider", "=", providerId)
    .where("provider_customer_id", "=", sub.customerId)
    .executeTakeFirst();
  return customer ? { type: "user", id: customer.subject_id } : null;
}

async function apply(trx: Transaction<DB>, providerId: string, sub: NormalizedSubscription, subject: BillingSubject): Promise<ApplyOutcome> {
  const { rows } = await sql<{ outcome: ApplyOutcome }>`
    select app.apply_subscription_state(
      ${providerId}, ${sub.id}, ${sub.customerId}, ${subject.type}, ${subject.id}::uuid, ${sub.plan}, ${sub.interval},
      ${sub.status}, ${sub.currentPeriodStart}::timestamptz, ${sub.currentPeriodEnd}::timestamptz, ${sub.cancelAtPeriodEnd},
      ${sub.canceledAt}::timestamptz, ${sub.graceUntil}::timestamptz, ${sub.updatedAt}::timestamptz) as outcome
  `.execute(trx);
  return rows[0]?.outcome as ApplyOutcome;
}

async function finishEvent(trx: Transaction<DB> | ReturnType<typeof getDb>, eventRowId: string, status: string, subjectId: string | null, error: string | null = null) {
  await sql`
    select app.finish_billing_event(${eventRowId}::bigint, ${status}, ${error}, ${subjectId ? "user" : null}, ${subjectId}::uuid)
  `.execute(trx);
}

export type SyncOptions = {
  /** The webhook event being processed: locked, then finished in the same transaction as the state. */
  eventRowId?: string;
  /** A provider-confirmed lost dispute for this subscription (counted in the same transaction). */
  dispute?: NormalizedDispute;
};

/**
 * Apply one provider-reported subscription: resolve its subject, write it (ordered by the provider's
 * updated time), mark our checkout completed, count a lost dispute, and finish the event, all in one
 * transaction, so a failure leaves nothing half-applied and a retry starts clean.
 */
export async function syncSubscription(provider: BillingProvider, sub: NormalizedSubscription, options: SyncOptions = {}): Promise<SyncResult> {
  return getDb()
    .transaction()
    .execute(async (trx) => {
      if (options.eventRowId) {
        const { rows } = await sql<{ locked: boolean }>`select app.lock_billing_event(${options.eventRowId}::bigint) as locked`.execute(trx);
        // Another delivery of this event finished it meanwhile: apply nothing twice.
        if (!rows[0]?.locked) return { outcome: "already_finished" as const, subjectId: null };
      }

      const subject = await resolveSubject(trx, provider.id, sub);
      if (!subject) {
        log.warn("billing.subject_unknown", { provider: provider.id, subscriptionId: sub.id });
        if (options.eventRowId) await finishEvent(trx, options.eventRowId, "ignored_unknown", null);
        return { outcome: "unknown_subject" as const, subjectId: null };
      }

      const outcome = await apply(trx, provider.id, sub, subject);
      if (outcome !== "subject_mismatch") {
        if (sub.checkoutRef) {
          await trx
            .updateTable("app.billing_checkouts")
            .set({ status: "completed" })
            .where("id", "=", sub.checkoutRef)
            .where("provider", "=", provider.id)
            .where("subject_id", "=", subject.id)
            .where("status", "<>", "completed")
            .execute();
        }
        if (options.dispute) {
          await sql`
            select app.record_billing_dispute(${provider.id}, ${options.dispute.id}, ${sub.id}, ${subject.type}, ${subject.id}::uuid)
          `.execute(trx);
        }
      }
      if (options.eventRowId) await finishEvent(trx, options.eventRowId, eventStatusFor(outcome), subject.id);
      return { outcome, subjectId: subject.id };
    });
}

/**
 * Fetch-on-event (§17.7.5 step 6): the provider's current state of `subscriptionId`, applied. A
 * subscription the provider doesn't know (a forged event, B14) or that isn't for our Pro prices is
 * never applied.
 */
export async function fetchAndSync(provider: BillingProvider, subscriptionId: string, options: SyncOptions = {}): Promise<SyncResult> {
  let sub: NormalizedSubscription | null;
  try {
    sub = await provider.fetchSubscription(subscriptionId);
  } catch (error) {
    if (!(error instanceof SubscriptionNotFoundError)) throw error;
    log.warn("billing.subscription_unknown", { provider: provider.id, subscriptionId });
    if (options.eventRowId) await finishEvent(getDb(), options.eventRowId, "ignored_unknown", null);
    return { outcome: "unknown_subscription", subjectId: null };
  }
  if (!sub) {
    log.warn("billing.subscription_not_our_plan", { provider: provider.id, subscriptionId });
    if (options.eventRowId) await finishEvent(getDb(), options.eventRowId, "ignored_unknown", null);
    return { outcome: "not_our_plan", subjectId: null };
  }
  return syncSubscription(provider, sub, options);
}

/** Finish an event that changes no subscription (logged only, or unknown). */
export async function finishWithoutState(eventRowId: string, status: "processed" | "ignored_unknown" | "rejected", error: string | null = null) {
  await finishEvent(getDb(), eventRowId, status, null, error);
}

/** A failed processing attempt (§17.7.5 step 9): the provider retries; `code` is an error code only. */
export async function markEventFailed(eventRowId: string, code: string) {
  await finishEvent(getDb(), eventRowId, "failed", null, code);
}
