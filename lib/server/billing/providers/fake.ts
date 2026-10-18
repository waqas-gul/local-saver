import "server-only";
import { z } from "zod";
import type { BillingConfig } from "../../env";
import { assertFreshTimestamp, matchesAnySignature } from "../signature";
import {
  BillingProviderError,
  SubscriptionNotFoundError,
  WebhookPayloadError,
  WebhookSignatureError,
  type BillingProvider,
  type EventSummary,
  type Interval,
  type NormalizedEvent,
  type NormalizedEventType,
  type NormalizedSubscription,
  type SubscriptionStatus,
  type VerifiedWebhook,
} from "../types";

/**
 * The fake billing provider's adapter (phase 4 §17.7.2, §17.19): tests and local development only
 * (env.ts refuses it in production builds and deployments). The provider itself is a separate local
 * HTTP server (tests/support/fake-billing.ts) with its own API, hosted checkout and portal pages, and
 * a control API that moves subscriptions through their lifecycle. This adapter talks to it the way a
 * real adapter talks to its provider: over HTTP with an API key, verifying signed webhooks.
 *
 * Its webhooks are signed like Standard Webhooks: `webhook-id`, `webhook-timestamp` (Unix seconds)
 * and `webhook-signature` ("v1,<base64 HMAC-SHA256 of id.timestamp.body>", several separated by
 * spaces during rotation). Its subscription states and event types are deliberately not the internal
 * names, so the mapping is exercised.
 */

const TIMEOUT_MS = 10_000;
const ID = z.string().min(1).max(255);
const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const TIME = z.iso.datetime({ offset: true });

const customData = z
  .object({
    checkout_ref: UUID.optional(),
    subject_type: z.string().max(20).optional(),
    subject_id: UUID.optional(),
  })
  .nullish();

// Not strict: providers add fields (a customer's email or address among them), which are dropped here.
const eventSchema = z.object({
  id: ID,
  type: z.string().min(1).max(100),
  created_at: TIME,
  data: z.object({
    dispute_id: ID.optional(),
    subscription_id: ID.optional(),
    customer_id: ID.optional(),
    checkout_id: ID.optional(),
    custom_data: customData,
    status: z.string().max(40).optional(),
    amount: z.number().int().nonnegative().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    full: z.boolean().optional(),
  }),
});

const subscriptionSchema = z.object({
  id: ID,
  customer_id: ID,
  status: z.enum(["trialing", "active", "past_due", "paused", "canceled", "ended"]),
  price_id: z.string().min(1).max(255),
  current_period_start: TIME.nullable(),
  current_period_end: TIME.nullable(),
  cancel_at_period_end: z.boolean(),
  canceled_at: TIME.nullable(),
  grace_until: TIME.nullable().optional(),
  updated_at: TIME,
  custom_data: customData,
});

const disputeSchema = z.object({
  id: ID,
  subscription_id: ID.nullable(),
  status: z.enum(["needs_response", "under_review", "won", "lost"]),
});

const STATUS: Record<z.infer<typeof subscriptionSchema>["status"], SubscriptionStatus> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  paused: "paused",
  canceled: "canceled",
  ended: "expired",
};

const EVENT_TYPES: Record<string, NormalizedEventType> = {
  "checkout.completed": "checkout.completed",
  "subscription.created": "subscription.updated",
  "subscription.updated": "subscription.updated",
  "subscription.renewed": "subscription.updated",
  "subscription.canceled": "subscription.updated",
  "payment.succeeded": "payment.succeeded",
  "payment.failed": "payment.failed",
  "refund.created": "refund.created",
  "dispute.created": "dispute.opened",
  "dispute.lost": "dispute.lost",
  "dispute.won": "dispute.won",
};

const date = (value: string | null | undefined) => (value ? new Date(value) : null);

export function createFakeProvider(config: BillingConfig): BillingProvider {
  const base = (config.fakeApiUrl ?? "").replace(/\/$/, "");
  const intervalOf = (priceId: string): Interval | null =>
    priceId === config.prices.month ? "month" : priceId === config.prices.year ? "year" : null;

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${config.apiKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
    } catch {
      throw new BillingProviderError("unreachable");
    }
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      // A bodiless answer is checked by the caller.
    }
    return { status: response.status, json };
  }

  /** `isSubscription`: a 404 means the provider doesn't know that subscription. */
  async function expectOk(method: "GET" | "POST", path: string, body?: unknown, isSubscription = false): Promise<unknown> {
    const { status, json } = await call(method, path, body);
    if (status === 404 && isSubscription) throw new SubscriptionNotFoundError();
    if (status < 200 || status >= 300) throw new BillingProviderError(`http_${status}`);
    return json;
  }

  function subscription(raw: unknown): NormalizedSubscription | null {
    const parsed = subscriptionSchema.safeParse(raw);
    if (!parsed.success) throw new BillingProviderError("invalid_subscription");
    const s = parsed.data;
    const interval = intervalOf(s.price_id);
    // Not one of our Pro prices: another product on the same provider account never grants Pro.
    if (!interval) return null;
    const custom = s.custom_data ?? {};
    return {
      id: s.id,
      customerId: s.customer_id,
      status: STATUS[s.status],
      plan: "pro",
      interval,
      currentPeriodStart: date(s.current_period_start),
      currentPeriodEnd: date(s.current_period_end),
      cancelAtPeriodEnd: s.cancel_at_period_end,
      canceledAt: date(s.canceled_at),
      graceUntil: date(s.grace_until),
      updatedAt: new Date(s.updated_at),
      checkoutRef: custom.checkout_ref?.toLowerCase() ?? null,
      subject: custom.subject_type === "user" && custom.subject_id ? { type: "user", id: custom.subject_id.toLowerCase() } : null,
    };
  }

  return {
    id: "fake",

    async createCheckout(input) {
      const json = (await expectOk("POST", "/v1/checkouts", {
        price_id: config.prices[input.interval],
        customer_id: input.customerId,
        custom_data: { checkout_ref: input.checkoutRef, subject_type: input.subject.type, subject_id: input.subject.id },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      })) as { id?: unknown; url?: unknown };
      if (typeof json?.id !== "string" || typeof json.url !== "string") throw new BillingProviderError("invalid_checkout");
      return { url: json.url, providerCheckoutId: json.id };
    },

    async createPortalSession(input) {
      const json = (await expectOk("POST", "/v1/portal-sessions", { customer_id: input.customerId, return_url: input.returnUrl })) as {
        url?: unknown;
      };
      if (typeof json?.url !== "string") throw new BillingProviderError("invalid_portal_session");
      return { url: json.url };
    },

    verifyWebhook(rawBody: string, headers: Headers, now: Date): VerifiedWebhook {
      const id = headers.get("webhook-id");
      const timestamp = headers.get("webhook-timestamp");
      const signature = headers.get("webhook-signature");
      if (!id || !timestamp || !signature) throw new WebhookSignatureError("missing_header");
      assertFreshTimestamp(timestamp, now);
      const candidates = signature
        .split(" ")
        .filter((entry) => entry.startsWith("v1,"))
        .map((entry) => entry.slice(3));
      if (!matchesAnySignature(`${id}.${timestamp}.${rawBody}`, candidates, config.webhookSecrets)) {
        throw new WebhookSignatureError("signature_mismatch");
      }
      return { eventId: id, rawBody };
    },

    normalize(event: VerifiedWebhook): NormalizedEvent {
      let json: unknown;
      try {
        json = JSON.parse(event.rawBody);
      } catch {
        throw new WebhookPayloadError("invalid_json");
      }
      const parsed = eventSchema.safeParse(json);
      if (!parsed.success) throw new WebhookPayloadError("schema_invalid");
      const e = parsed.data;
      if (event.eventId !== null && event.eventId !== e.id) throw new WebhookPayloadError("event_id_mismatch");
      const d = e.data;
      const checkoutRef = d.custom_data?.checkout_ref?.toLowerCase() ?? null;
      const summary: EventSummary = {
        ...(d.dispute_id ? { disputeId: d.dispute_id } : {}),
        ...(d.subscription_id ? { subscriptionId: d.subscription_id } : {}),
        ...(d.customer_id ? { customerId: d.customer_id } : {}),
        ...(checkoutRef ? { checkoutRef } : {}),
        ...(d.status ? { status: d.status } : {}),
        ...(d.amount !== undefined ? { amount: d.amount } : {}),
        ...(d.currency ? { currency: d.currency } : {}),
        ...(d.full !== undefined ? { full: d.full } : {}),
      };
      return {
        providerEventId: e.id,
        type: EVENT_TYPES[e.type] ?? "other",
        providerType: e.type,
        occurredAt: new Date(e.created_at),
        subscriptionId: d.subscription_id ?? null,
        customerId: d.customer_id ?? null,
        checkoutRef,
        disputeId: d.dispute_id ?? null,
        summary,
      };
    },

    async fetchSubscription(id: string) {
      return subscription(await expectOk("GET", `/v1/subscriptions/${encodeURIComponent(id)}`, undefined, true));
    },

    async listSubscriptions(input) {
      const query = new URLSearchParams();
      if (input.updatedSince) query.set("updated_since", input.updatedSince.toISOString());
      if (input.cursor) query.set("cursor", input.cursor);
      const json = (await expectOk("GET", `/v1/subscriptions?${query}`)) as { data?: unknown; next_cursor?: unknown };
      if (!Array.isArray(json?.data)) throw new BillingProviderError("invalid_list");
      const items = json.data.map(subscription).filter((s): s is NormalizedSubscription => s !== null);
      return typeof json.next_cursor === "string" && json.next_cursor !== "" ? { items, next: json.next_cursor } : { items };
    },

    async cancelSubscription(id: string, input: { atPeriodEnd: boolean }) {
      await expectOk("POST", `/v1/subscriptions/${encodeURIComponent(id)}/cancel`, { at_period_end: input.atPeriodEnd }, true);
    },

    async fetchDispute(id: string) {
      const parsed = disputeSchema.safeParse(await expectOk("GET", `/v1/disputes/${encodeURIComponent(id)}`, undefined, true));
      if (!parsed.success) throw new BillingProviderError("invalid_dispute");
      const d = parsed.data;
      return { id: d.id, subscriptionId: d.subscription_id, status: d.status === "won" ? "won" : d.status === "lost" ? "lost" : "open" };
    },
  };
}
