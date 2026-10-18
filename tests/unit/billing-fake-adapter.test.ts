import { afterEach, describe, expect, it, vi } from "vitest";
import type { BillingConfig } from "@/lib/server/env";
import { createFakeProvider } from "@/lib/server/billing/providers/fake";
import { BillingProviderError, SubscriptionNotFoundError, WebhookPayloadError, WebhookSignatureError } from "@/lib/server/billing/types";
import { FAKE_BILLING, fakeWebhookHeaders, signFakeWebhook } from "../support/fake-billing";

/**
 * The fake provider's adapter (phase 4 §17.7.2, §17.19.3): signature verification (B1, B2), payload
 * normalization (minimized, §17.7.5) and the mapping of the provider's states to the internal ones.
 * The real adapter (P4-13) gets the same tests with its provider's published vectors.
 */

const CONFIG: BillingConfig = {
  provider: "fake",
  apiKey: FAKE_BILLING.apiKey,
  webhookSecrets: [FAKE_BILLING.webhookSecret, FAKE_BILLING.previousWebhookSecret],
  prices: { month: FAKE_BILLING.prices.month, year: FAKE_BILLING.prices.year },
  fakeApiUrl: "http://fake.test",
};
const provider = createFakeProvider(CONFIG);
const NOW = new Date("2026-10-17T12:00:00Z");
const TS = Math.floor(NOW.getTime() / 1000);
const REF = "5a1f3c9e-2b4d-4e6f-8a0b-1c2d3e4f5a6b";
const SUBJECT = "0b8e6a2c-4d1f-4c3a-9e5b-7f6a5b4c3d2e";

const body = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "evt_1",
    type: "subscription.updated",
    created_at: "2026-10-17T11:59:00Z",
    data: { subscription_id: "sub_1", customer_id: "cus_1", status: "active" },
    ...overrides,
  });

function verify(raw: string, headers: Record<string, string>, now = NOW) {
  return provider.verifyWebhook(raw, new Headers(headers), now);
}

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof WebhookSignatureError) return error.reason;
    throw error;
  }
  return "accepted";
}

describe("fake adapter: verifyWebhook (B1, B2)", () => {
  const raw = body();

  it("accepts the provider's signature and returns the signed event ID", () => {
    expect(verify(raw, fakeWebhookHeaders("evt_1", raw, { timestamp: TS }))).toEqual({ eventId: "evt_1", rawBody: raw });
  });

  it("accepts the previous secret during a rotation, and any one of several signatures", () => {
    expect(reason(() => verify(raw, fakeWebhookHeaders("evt_1", raw, { timestamp: TS, secrets: [FAKE_BILLING.previousWebhookSecret] })))).toBe("accepted");
    expect(reason(() => verify(raw, fakeWebhookHeaders("evt_1", raw, { timestamp: TS, secrets: ["not-ours-not-ours-not-ours-not-ours", FAKE_BILLING.webhookSecret] })))).toBe("accepted");
  });

  it("refuses a wrong key, a changed byte, another event's signature and malformed entries", () => {
    expect(reason(() => verify(raw, fakeWebhookHeaders("evt_1", raw, { timestamp: TS, secrets: ["wrong-secret-wrong-secret-wrong-secret"] })))).toBe("signature_mismatch");
    const headers = fakeWebhookHeaders("evt_1", raw, { timestamp: TS });
    expect(reason(() => verify(raw.replace('"active"', '"activf"'), headers))).toBe("signature_mismatch");
    expect(reason(() => verify(`${raw} `, headers))).toBe("signature_mismatch");
    expect(reason(() => verify(raw, { ...headers, "webhook-id": "evt_2" }))).toBe("signature_mismatch");
    const good = signFakeWebhook(FAKE_BILLING.webhookSecret, "evt_1", TS, raw);
    expect(reason(() => verify(raw, { ...headers, "webhook-signature": `v2,${good}` }))).toBe("signature_mismatch");
    expect(reason(() => verify(raw, { ...headers, "webhook-signature": "v1,not base64!" }))).toBe("signature_mismatch");
    expect(reason(() => verify(raw, { ...headers, "webhook-signature": `v1,${good.slice(0, 20)}` }))).toBe("signature_mismatch");
  });

  it("refuses missing headers", () => {
    const headers = fakeWebhookHeaders("evt_1", raw, { timestamp: TS });
    for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
      const { [name]: _dropped, ...rest } = headers;
      expect(reason(() => verify(raw, rest)), name).toBe("missing_header");
    }
  });

  it("refuses a signed timestamp more than 300 seconds away, either side (replays)", () => {
    for (const [offset, expected] of [
      [-301, "timestamp_out_of_tolerance"],
      [301, "timestamp_out_of_tolerance"],
      [-299, "accepted"],
      [299, "accepted"],
    ] as const) {
      const timestamp = TS + offset;
      expect(reason(() => verify(raw, fakeWebhookHeaders("evt_1", raw, { timestamp }))), String(offset)).toBe(expected);
    }
    const headers = fakeWebhookHeaders("evt_1", raw, { timestamp: TS });
    expect(reason(() => verify(raw, { ...headers, "webhook-timestamp": "17e8" }))).toBe("bad_timestamp");
  });
});

describe("fake adapter: normalize (§17.7.5)", () => {
  const normalize = (raw: string, eventId: string | null = "evt_1") => provider.normalize({ eventId, rawBody: raw });
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      if (error instanceof WebhookPayloadError) return error.code;
      throw error;
    }
    return "ok";
  };

  it("maps the provider's event types and keeps only IDs, status, amounts and currency", () => {
    const event = normalize(
      body({
        type: "checkout.completed",
        data: {
          checkout_id: "chk_1",
          subscription_id: "sub_1",
          customer_id: "cus_1",
          custom_data: { checkout_ref: REF.toUpperCase(), subject_type: "user", subject_id: SUBJECT },
          customer_email: "payer@example.com",
          billing_address: { line1: "1 Example Street" },
          amount: 500,
          currency: "USD",
        },
      }),
    );
    expect(event).toEqual({
      providerEventId: "evt_1",
      type: "checkout.completed",
      providerType: "checkout.completed",
      occurredAt: new Date("2026-10-17T11:59:00Z"),
      subscriptionId: "sub_1",
      customerId: "cus_1",
      checkoutRef: REF,
      disputeId: null,
      summary: { subscriptionId: "sub_1", customerId: "cus_1", checkoutRef: REF, amount: 500, currency: "USD" },
    });
    expect(JSON.stringify(event)).not.toMatch(/example|Street/);
    const types = Object.fromEntries(
      ["subscription.created", "subscription.renewed", "payment.failed", "refund.created", "dispute.created", "dispute.lost", "dispute.won", "invoice.paid"].map(
        (type) => [type, normalize(body({ type })).type],
      ),
    );
    expect(types).toEqual({
      "subscription.created": "subscription.updated",
      "subscription.renewed": "subscription.updated",
      "payment.failed": "payment.failed",
      "refund.created": "refund.created",
      "dispute.created": "dispute.opened",
      "dispute.lost": "dispute.lost",
      "dispute.won": "dispute.won",
      "invoice.paid": "other",
    });
  });

  it("rejects a verified body that isn't a valid event", () => {
    expect(code(() => normalize("{not json"))).toBe("invalid_json");
    expect(code(() => normalize(JSON.stringify({ id: "evt_1", type: "x" })))).toBe("schema_invalid");
    expect(code(() => normalize(body({ data: { custom_data: { checkout_ref: "not-a-uuid" } } })))).toBe("schema_invalid");
    expect(code(() => normalize(body({ data: { currency: "usd" } })))).toBe("schema_invalid");
    expect(code(() => normalize(body(), "evt_other"))).toBe("event_id_mismatch");
  });
});

describe("fake adapter: the provider's API", () => {
  afterEach(() => vi.unstubAllGlobals());

  const subscription = (overrides: Record<string, unknown> = {}) => ({
    id: "sub_1",
    customer_id: "cus_1",
    status: "active",
    price_id: FAKE_BILLING.prices.year,
    current_period_start: "2026-10-01T00:00:00Z",
    current_period_end: "2027-10-01T00:00:00Z",
    cancel_at_period_end: false,
    canceled_at: null,
    grace_until: null,
    updated_at: "2026-10-17T11:00:00Z",
    custom_data: { checkout_ref: REF, subject_type: "user", subject_id: SUBJECT },
    ...overrides,
  });

  function stubFetch(status: number, json: unknown) {
    const fetch = vi.fn(async () => new Response(JSON.stringify(json), { status }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("fetches a subscription with the API key and maps it to the internal state", async () => {
    const fetch = stubFetch(200, subscription({ status: "ended" }));
    expect(await provider.fetchSubscription("sub/1")).toEqual({
      id: "sub_1",
      customerId: "cus_1",
      status: "expired",
      plan: "pro",
      interval: "year",
      currentPeriodStart: new Date("2026-10-01T00:00:00Z"),
      currentPeriodEnd: new Date("2027-10-01T00:00:00Z"),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      graceUntil: null,
      updatedAt: new Date("2026-10-17T11:00:00Z"),
      checkoutRef: REF,
      subject: { type: "user", id: SUBJECT },
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://fake.test/v1/subscriptions/sub%2F1");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${FAKE_BILLING.apiKey}`);
  });

  it("maps every provider status", async () => {
    const statuses: Record<string, string> = {};
    for (const status of ["trialing", "active", "past_due", "paused", "canceled", "ended"]) {
      stubFetch(200, subscription({ status }));
      statuses[status] = (await provider.fetchSubscription("sub_1"))?.status as string;
    }
    expect(statuses).toEqual({ trialing: "trialing", active: "active", past_due: "past_due", paused: "paused", canceled: "canceled", ended: "expired" });
  });

  it("never treats another product's subscription as Pro", async () => {
    stubFetch(200, subscription({ price_id: FAKE_BILLING.otherPrice }));
    expect(await provider.fetchSubscription("sub_1")).toBeNull();
  });

  it("reports an unknown subscription, a failing provider and an unexpected answer distinctly", async () => {
    stubFetch(404, { error: "not found" });
    await expect(provider.fetchSubscription("sub_1")).rejects.toBeInstanceOf(SubscriptionNotFoundError);
    stubFetch(503, { error: "down" });
    await expect(provider.fetchSubscription("sub_1")).rejects.toMatchObject({ code: "http_503" });
    stubFetch(200, subscription({ status: "lifetime" }));
    await expect(provider.fetchSubscription("sub_1")).rejects.toMatchObject({ code: "invalid_subscription" });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(provider.fetchSubscription("sub_1")).rejects.toEqual(new BillingProviderError("unreachable"));
    stubFetch(404, { error: "not found" });
    await expect(provider.createPortalSession({ customerId: "cus_1", returnUrl: "http://app" })).rejects.toMatchObject({ code: "http_404" });
  });

  it("lists only Pro subscriptions, page by page", async () => {
    const fetch = stubFetch(200, { data: [subscription(), subscription({ id: "sub_2", price_id: FAKE_BILLING.otherPrice })], next_cursor: "2" });
    const page = await provider.listSubscriptions({ updatedSince: new Date("2026-10-16T00:00:00Z"), cursor: "0" });
    expect(page.items.map((s) => s.id)).toEqual(["sub_1"]);
    expect(page.next).toBe("2");
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("http://fake.test/v1/subscriptions?updated_since=2026-10-16T00%3A00%3A00.000Z&cursor=0");
  });

  it("maps disputes and creates checkouts for the configured prices", async () => {
    stubFetch(200, { id: "dp_1", subscription_id: "sub_1", status: "under_review" });
    expect(await provider.fetchDispute("dp_1")).toEqual({ id: "dp_1", subscriptionId: "sub_1", status: "open" });
    const fetch = stubFetch(201, { id: "chk_1", url: "http://fake.test/pay/chk_1" });
    const created = await provider.createCheckout({
      subject: { type: "user", id: SUBJECT },
      plan: "pro",
      interval: "month",
      customerId: null,
      checkoutRef: REF,
      successUrl: "http://app/s",
      cancelUrl: "http://app/c",
    });
    expect(created).toEqual({ url: "http://fake.test/pay/chk_1", providerCheckoutId: "chk_1" });
    expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      price_id: FAKE_BILLING.prices.month,
      customer_id: null,
      custom_data: { checkout_ref: REF, subject_type: "user", subject_id: SUBJECT },
      success_url: "http://app/s",
      cancel_url: "http://app/c",
    });
  });
});
