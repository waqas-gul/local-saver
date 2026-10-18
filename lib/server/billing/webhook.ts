import "server-only";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { getDb } from "../db/client";
import { ApiError } from "../http/errors";
import { log } from "../log";
import { eventStatusFor, fetchAndSync, finishWithoutState, markEventFailed, type SyncOptions } from "./sync";
import {
  BillingProviderError,
  SubscriptionNotFoundError,
  WebhookPayloadError,
  WebhookSignatureError,
  type BillingProvider,
  type NormalizedEvent,
} from "./types";

/**
 * POST /api/v1/billing/webhook (phase 4 §17.7.5):
 *   1. verify the signature over the raw body (and the signed timestamp)  → 400, nothing stored
 *   2. parse the verified body                                           → rejected, 200 (no retries)
 *   3. store the event once (provider, event ID)                         → a duplicate: 200, nothing done
 *   4. fetch the subscription from the provider and apply that state     → processed / ignored_*, 200
 *   5. anything unexpected                                               → failed, 500 (the provider retries)
 * Logs carry event IDs, types, statuses and subject IDs only: never the body.
 */

export type WebhookResult = { status: 200 | 500; outcome: string };

function bodyHash(rawBody: string): string {
  return `sha256:${createHash("sha256").update(rawBody, "utf8").digest("hex")}`;
}

async function record(providerId: string, event: Pick<NormalizedEvent, "providerEventId" | "providerType" | "occurredAt" | "summary">) {
  const { rows } = await sql<{ event_id: string; outcome: "new" | "retry" | "duplicate" }>`
    select event_id, outcome
      from app.record_billing_event(${providerId}, ${event.providerEventId}, ${event.providerType}, ${event.occurredAt}::timestamptz,
                                    ${JSON.stringify(event.summary)}::jsonb)
  `.execute(getDb());
  return rows[0] as { event_id: string; outcome: "new" | "retry" | "duplicate" };
}

type Processed = { status: string; outcome: string; subjectId: string | null };

/** What the event asks the app to do. Every state comes from the provider, never from `event`. */
async function process(provider: BillingProvider, event: NormalizedEvent, eventRowId: string): Promise<Processed> {
  const sync = async (subscriptionId: string, options: Omit<SyncOptions, "eventRowId"> = {}): Promise<Processed> => {
    const result = await fetchAndSync(provider, subscriptionId, { eventRowId, ...options });
    return { ...result, status: eventStatusFor(result.outcome) };
  };
  const skip = async (status: "processed" | "ignored_unknown", outcome: string): Promise<Processed> => {
    await finishWithoutState(eventRowId, status);
    return { status, outcome, subjectId: null };
  };

  switch (event.type) {
    case "checkout.completed": {
      // Completing a checkout grants nothing by itself; its subscription's state does (§17.7.4).
      if (event.subscriptionId) return sync(event.subscriptionId);
      if (!event.checkoutRef) return skip("ignored_unknown", "no_reference");
      const completed = await getDb()
        .updateTable("app.billing_checkouts")
        .set({ status: "completed" })
        .where("id", "=", event.checkoutRef)
        .where("provider", "=", provider.id)
        .executeTakeFirst();
      return completed.numUpdatedRows > BigInt(0) ? skip("processed", "checkout_completed") : skip("ignored_unknown", "unknown_checkout");
    }
    case "subscription.updated":
    case "payment.succeeded":
    case "payment.failed":
    case "refund.created":
      // A full refund with revocation ends the subscription at the provider; a partial one doesn't (D4-21).
      return event.subscriptionId ? sync(event.subscriptionId) : skip("ignored_unknown", "no_subscription");
    case "dispute.lost": {
      if (!event.disputeId) return skip("ignored_unknown", "no_dispute");
      let dispute;
      try {
        dispute = await provider.fetchDispute(event.disputeId);
      } catch (error) {
        if (error instanceof SubscriptionNotFoundError) return skip("ignored_unknown", "unknown_dispute");
        throw error;
      }
      // Only a dispute the provider confirms as lost, on one of its subscriptions, counts (B7, B14).
      if (dispute.status !== "lost" || !dispute.subscriptionId) return skip("ignored_unknown", "dispute_not_lost");
      const known = await getDb()
        .selectFrom("app.subscriptions")
        .select("id")
        .where("provider", "=", provider.id)
        .where("provider_subscription_id", "=", dispute.subscriptionId)
        .executeTakeFirst();
      if (!known) return skip("ignored_unknown", "unknown_subscription");
      // Lost: Free at once (D4-21). The provider ends the subscription, then its state is applied.
      await provider.cancelSubscription(dispute.subscriptionId, { atPeriodEnd: false });
      return sync(dispute.subscriptionId, { dispute });
    }
    case "dispute.opened":
    case "dispute.won":
      // No change (D4-21); the event row is the record.
      return skip("processed", "logged");
    default:
      return skip("ignored_unknown", "unknown_type");
  }
}

export async function handleBillingWebhook(provider: BillingProvider, rawBody: string, headers: Headers, now: Date): Promise<WebhookResult> {
  let verified;
  try {
    verified = provider.verifyWebhook(rawBody, headers, now);
  } catch (error) {
    if (error instanceof WebhookSignatureError) {
      log.warn("billing.webhook_rejected", { provider: provider.id, reason: error.reason });
      throw new ApiError(400, "WEBHOOK_SIGNATURE_INVALID", "Webhook signature is invalid");
    }
    throw error;
  }

  let event: NormalizedEvent;
  try {
    event = provider.normalize(verified);
  } catch (error) {
    if (!(error instanceof WebhookPayloadError)) throw error;
    // A poison event must not be retried forever: stored as rejected (an error code only), answered 200.
    const eventId = verified.eventId && verified.eventId.length <= 255 ? verified.eventId : bodyHash(rawBody);
    const stored = await record(provider.id, { providerEventId: eventId, providerType: "invalid", occurredAt: null, summary: {} });
    if (stored.outcome !== "duplicate") await finishWithoutState(stored.event_id, "rejected", error.code);
    log.error("billing.webhook_invalid", { provider: provider.id, eventId, code: error.code });
    return { status: 200, outcome: "rejected" };
  }

  const stored = await record(provider.id, event);
  if (stored.outcome === "duplicate") {
    log.info("billing.webhook_duplicate", { provider: provider.id, eventId: event.providerEventId, type: event.providerType });
    return { status: 200, outcome: "duplicate" };
  }

  try {
    const result = await process(provider, event, stored.event_id);
    log.info("billing.webhook_processed", {
      provider: provider.id,
      eventId: event.providerEventId,
      type: event.providerType,
      status: result.status,
      outcome: result.outcome,
      subjectId: result.subjectId,
    });
    return { status: 200, outcome: result.status };
  } catch (error) {
    const code = error instanceof BillingProviderError ? `provider_${error.code}` : "processing_error";
    await markEventFailed(stored.event_id, code);
    log.error("billing.webhook_failed", { provider: provider.id, eventId: event.providerEventId, type: event.providerType, code, err: error });
    return { status: 500, outcome: "failed" };
  }
}
