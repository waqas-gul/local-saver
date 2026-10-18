import "server-only";

/**
 * The billing integration boundary (phase 4 §17.7.2). Everything provider-specific sits behind
 * BillingProvider: nothing outside lib/server/billing/providers/* names a provider field or calls a
 * provider's API. No provider is chosen yet (Q-005); the fake adapter stands in for tests and local
 * development, and the real adapter comes with P4-13.
 *
 * Trust: a webhook's payload is only a hint that something changed. The state that is applied is
 * always fetched from the provider (fetchSubscription, listSubscriptions), so a forged, replayed or
 * reordered event can at most make the app look again (B2, B4, B14).
 */

export type Interval = "month" | "year";

/** Internal subscription statuses (07 §6.3); adapters map their provider's states to these. */
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "paused" | "canceled" | "expired";

export type BillingSubject = { type: "user"; id: string };

/** A webhook whose signature (and timestamp, where signed) checked out. */
export type VerifiedWebhook = {
  /** The provider's event ID when the signed envelope carries one (else the payload's). */
  eventId: string | null;
  rawBody: string;
};

/** Provider-neutral event kinds. Anything else is stored and ignored. */
export type NormalizedEventType =
  | "checkout.completed"
  | "subscription.updated"
  | "payment.succeeded"
  | "payment.failed"
  | "refund.created"
  | "dispute.opened"
  | "dispute.lost"
  | "dispute.won"
  | "other";

export type NormalizedEvent = {
  providerEventId: string;
  type: NormalizedEventType;
  /** The provider's own event type, for the log (≤ 100 characters). */
  providerType: string;
  occurredAt: Date | null;
  subscriptionId: string | null;
  customerId: string | null;
  checkoutRef: string | null;
  /** Dispute events: the provider's dispute ID (confirmed with fetchDispute before anything is done). */
  disputeId: string | null;
  /** Minimized copy for support (§17.7.5): IDs, status, amount, currency. Never personal data. */
  summary: EventSummary;
};

export type EventSummary = {
  disputeId?: string;
  subscriptionId?: string;
  customerId?: string;
  checkoutRef?: string;
  status?: string;
  amount?: number;
  currency?: string;
  full?: boolean;
};

/** The authoritative state of one subscription, as the provider reports it. */
export type NormalizedSubscription = {
  id: string;
  customerId: string;
  status: SubscriptionStatus;
  plan: "pro";
  interval: Interval;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  /** The provider's dunning end while past_due, when it gives one (else 7 days, D4-21). */
  graceUntil: Date | null;
  /** The ordering key (provider_updated_at): an older state never overwrites a newer one. */
  updatedAt: Date;
  /** Our billing_checkouts.id, carried in the provider's custom data. */
  checkoutRef: string | null;
  /** The subject the custom data names; only trusted when it matches our checkout row. */
  subject: BillingSubject | null;
};

/** A chargeback as the provider reports it (D4-21). */
export type NormalizedDispute = {
  id: string;
  subscriptionId: string | null;
  status: "open" | "won" | "lost";
};

export type CheckoutInput = {
  subject: BillingSubject;
  plan: "pro";
  interval: Interval;
  customerId: string | null;
  checkoutRef: string;
  successUrl: string;
  cancelUrl: string;
};

export interface BillingProvider {
  /** "fake" | "<provider>": stored with every row (provider column). */
  readonly id: string;
  createCheckout(input: CheckoutInput): Promise<{ url: string; providerCheckoutId: string }>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Throws WebhookSignatureError. HMAC over the exact bytes; timestamp tolerance where signed. */
  verifyWebhook(rawBody: string, headers: Headers, now: Date): VerifiedWebhook;
  /** Throws WebhookPayloadError for a verified body that doesn't parse (stored as rejected). */
  normalize(event: VerifiedWebhook): NormalizedEvent;
  /**
   * The authoritative state. Throws SubscriptionNotFoundError when the provider doesn't know it;
   * null when it isn't a subscription to our Pro prices (never applied).
   */
  fetchSubscription(id: string): Promise<NormalizedSubscription | null>;
  /** Items that aren't for our Pro prices are left out. */
  listSubscriptions(input: { updatedSince: Date | null; cursor?: string }): Promise<{ items: NormalizedSubscription[]; next?: string }>;
  cancelSubscription(id: string, input: { atPeriodEnd: boolean }): Promise<void>;
  /**
   * The authoritative state of a dispute (throws SubscriptionNotFoundError when unknown). A lost
   * dispute cancels a subscription and counts against the account, so it is confirmed with the
   * provider first, as subscription states are (B14).
   */
  fetchDispute(id: string): Promise<NormalizedDispute>;
}

/** The signature, its header or its timestamp didn't check out. `reason` is a code, never a value. */
export class WebhookSignatureError extends Error {
  constructor(readonly reason: "missing_header" | "bad_timestamp" | "timestamp_out_of_tolerance" | "signature_mismatch") {
    super(`webhook signature rejected: ${reason}`);
    this.name = "WebhookSignatureError";
  }
}

/** A verified body that isn't a valid event. */
export class WebhookPayloadError extends Error {
  constructor(readonly code: string) {
    super(`webhook payload rejected: ${code}`);
    this.name = "WebhookPayloadError";
  }
}

/** The provider doesn't know the subscription (or dispute) an event named. */
export class SubscriptionNotFoundError extends Error {
  constructor() {
    super("the provider does not know this object");
    this.name = "SubscriptionNotFoundError";
  }
}

/** The provider's API failed or answered something unexpected. `code` is safe to store and log. */
export class BillingProviderError extends Error {
  constructor(readonly code: string) {
    super(`billing provider error: ${code}`);
    this.name = "BillingProviderError";
  }
}
