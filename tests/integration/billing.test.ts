import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { FAKE_BILLING, fakeWebhookHeaders } from "../support/fake-billing";
import { claimsOf } from "./support/accounts";
import { adminDb, api, closeAdminDb, newNetwork, stack } from "./support/api";
import {
  act,
  auditCount,
  checkout,
  checkoutIdOf,
  control,
  countEvents,
  deliver,
  entitlementsOf,
  eventRow,
  lastReconcileFinish,
  postReconcile,
  providerState,
  reconcile,
  reconcileFinished,
  requestDeletion,
  subscriber,
  subscriptionRow,
  type Controlled,
} from "./support/billing";
import { accountDevice, DAY, grantOverride, setCounter } from "./support/entitlements";

/**
 * Phase 4C: the provider-neutral billing core against the fake provider (phase 4 §17.7, §17.10,
 * §17.19.3): checkout (T4-B1), portal (T4-B2), the lifecycle (T4-B3), reconciliation (T4-B4) and the
 * threat rows B1 … B16 (T-052.1 … 15). The only way to Pro is the provider's state reaching the app.
 */

afterAll(closeAdminDb);

const ISO = /^\d{4}-\d{2}-\d{2}T/;
const serverLog = () => readFileSync(stack().serverLog, "utf8");
const isPro = async (device: Parameters<typeof entitlementsOf>[0]) => (await entitlementsOf(device)).plan === "pro";
/** A Pro-only action: a 30-day text (E5). Free gets 422 EXPIRY_NOT_ALLOWED. */
const thirtyDayText = (device: Parameters<typeof entitlementsOf>[0]) =>
  device.call("POST", "/api/v1/texts", { destination: "network", content: "pro text", expiresIn: 30 * DAY });

describe("checkout (T4-B1, B16)", () => {
  it("needs an account: anonymous browsers get 403 and start nothing", async () => {
    const { Device } = await import("./support/api");
    const anon = await Device.create(newNetwork().ip());
    const response = await checkout(anon);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("ACCOUNT_REQUIRED");
    expect((await adminDb().query("select count(*) from app.billing_checkouts where subject_id = $1", [anon.userId])).rows[0].count).toBe("0");
  });

  it("needs an Idempotency-Key and accepts a plan and an interval only: no field can name another subject", async () => {
    const { device } = await accountDevice();
    const other = await accountDevice();
    const noKey = await device.call("POST", "/api/v1/billing/checkout", { plan: "pro", interval: "month" });
    expect([noKey.status, noKey.body.error.code]).toEqual([400, "IDEMPOTENCY_KEY_REQUIRED"]);
    for (const body of [
      { plan: "pro", interval: "month", subjectId: other.userId },
      { plan: "pro", interval: "month", userId: other.userId },
      { plan: "pro", interval: "month", customerId: "cus_x" },
      { plan: "team", interval: "month" },
      { plan: "free", interval: "month" },
      { plan: "pro", interval: "week" },
    ]) {
      const response = await checkout(device, "month", randomUUID(), body);
      expect([response.status, response.body.error.code], JSON.stringify(body)).toEqual([400, "VALIDATION_FAILED"]);
    }
    expect((await adminDb().query("select count(*) from app.billing_checkouts where subject_id in ($1, $2)", [device.userId, other.userId])).rows[0].count).toBe("0");
  });

  it("starts a hosted checkout for the caller, which grants nothing by itself", async () => {
    const { device, userId } = await accountDevice();
    const response = await checkout(device, "year");
    expect(response.status).toBe(201);
    expect(Object.keys(response.body)).toEqual(["url"]);
    const { rows } = await adminDb().query("select * from app.billing_checkouts where subject_id = $1", [userId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject_type: "user", provider: "fake", plan: "pro", billing_interval: "year", status: "created" });
    const providerCheckout = (await providerState()).checkouts.find((c) => c.id === checkoutIdOf(response.body.url));
    expect(providerCheckout).toMatchObject({
      price_id: FAKE_BILLING.prices.year,
      custom_data: { checkout_ref: rows[0].id, subject_type: "user", subject_id: userId },
      success_url: `${stack().origin}/settings/billing?checkout=${rows[0].id}`,
      cancel_url: `${stack().origin}/settings/billing`,
    });
    expect(rows[0].provider_checkout_id).toBe(providerCheckout.id);
    expect(await auditCount(userId, "billing.checkout_created")).toBe(1);
    expect(await isPro(device)).toBe(false);
  });

  it("is idempotent: the same key gives the same checkout, also when sent in parallel", async () => {
    const { device, userId } = await accountDevice();
    const key = randomUUID();
    const first = await checkout(device, "month", key);
    const again = await checkout(device, "month", key);
    expect(again.status).toBe(201);
    expect(again.body.url).toBe(first.body.url);

    const parallelKey = randomUUID();
    const responses = await Promise.all(Array.from({ length: 6 }, () => checkout(device, "month", parallelKey)));
    for (const r of responses) expect([201, 409]).toContain(r.status);
    const urls = new Set(responses.filter((r) => r.status === 201).map((r) => r.body.url));
    expect(urls.size).toBe(1);
    expect(responses.filter((r) => r.status === 409).every((r) => r.body.error.code === "CHECKOUT_IN_PROGRESS")).toBe(true);
    expect((await adminDb().query("select count(*) from app.billing_checkouts where subject_id = $1", [userId])).rows[0].count).toBe("2");
  });

  it("refuses an account already entitled by a subscription, but not one with Pro by override", async () => {
    const sub = await subscriber();
    const refused = await checkout(sub.device);
    expect([refused.status, refused.body.error.code]).toEqual([409, "ALREADY_SUBSCRIBED"]);
    const overridden = await accountDevice();
    await grantOverride(overridden.userId);
    expect((await checkout(overridden.device)).status).toBe(201);
  });

  it("refuses an account in its deletion grace, and over the rate limit", async () => {
    const leaving = await accountDevice();
    await requestDeletion(leaving.userId);
    const refused = await checkout(leaving.device);
    expect([refused.status, refused.body.error.code]).toEqual([403, "ACCOUNT_DELETION_PENDING"]);

    const busy = await accountDevice();
    await setCounter(`checkout:${busy.userId}`, "1 hour", 10);
    const limited = await checkout(busy.device);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("answers 502 when the provider fails, and releases the key so the same click can be retried", async () => {
    const { device, userId } = await accountDevice();
    const key = randomUUID();
    await control("/fail-api", { count: 1, status: 503 });
    const failed = await checkout(device, "month", key);
    expect([failed.status, failed.body.error.code]).toEqual([502, "BILLING_PROVIDER_ERROR"]);
    expect((await adminDb().query("select status from app.billing_checkouts where subject_id = $1", [userId])).rows.map((r) => r.status)).toEqual(["expired"]);
    expect((await checkout(device, "month", key)).status).toBe(201);
  });
});

describe("the lifecycle with the fake provider (T4-B3)", () => {
  it("payment → webhooks → Pro, with the checkout completed, the customer mapped and the events processed", async () => {
    const sub = await subscriber();
    const ent = await entitlementsOf(sub.device);
    expect(ent.plan).toBe("pro");
    expect(ent.source).toBe("subscription");
    expect(ent.subscription).toMatchObject({ status: "active", cancelAtPeriodEnd: false, graceUntil: null });
    expect(ent.subscription?.currentPeriodEnd).toMatch(ISO);
    expect((await sub.device.call("GET", "/api/v1/me")).body.plan).toBe("pro");
    expect((await thirtyDayText(sub.device)).status).toBe(201);

    const row = await subscriptionRow(sub.subscriptionId);
    expect(row).toMatchObject({ subject_id: sub.userId, status: "active", billing_interval: "month", provider_customer_id: sub.customerId });
    expect((await adminDb().query("select status from app.billing_checkouts where subject_id = $1", [sub.userId])).rows[0].status).toBe("completed");
    expect(
      (await adminDb().query("select subject_id from app.billing_customers where provider = 'fake' and provider_customer_id = $1", [sub.customerId])).rows[0]
        .subject_id,
    ).toBe(sub.userId);
    const events = await adminDb().query("select event_type, status, subject_id, payload from app.billing_events where payload ->> 'subscriptionId' = $1 order by id", [
      sub.subscriptionId,
    ]);
    expect(events.rows.map((e) => [e.event_type, e.status, e.subject_id])).toEqual([
      ["checkout.completed", "processed", sub.userId],
      ["subscription.created", "processed", sub.userId],
    ]);
    // The provider sent an email and an address; neither is stored or logged (§17.7.5).
    expect(JSON.stringify(events.rows.map((e) => e.payload))).not.toMatch(/payer@|Example Street|billing_address/);
    expect(serverLog()).not.toMatch(/payer@example\.com|Example Street/);
  });

  it("trial → Pro; the first payment → active", async () => {
    const sub = await subscriber({ trial: true });
    expect(await entitlementsOf(sub.device)).toMatchObject({ plan: "pro", subscription: { status: "trialing" } });
    await act(sub.subscriptionId, "recover");
    expect((await entitlementsOf(sub.device)).subscription?.status).toBe("active");
  });

  it("renewal moves the period and keeps Pro", async () => {
    const sub = await subscriber();
    const before = (await entitlementsOf(sub.device)).subscription?.currentPeriodEnd as string;
    await act(sub.subscriptionId, "renew");
    const after = await entitlementsOf(sub.device);
    expect(after.plan).toBe("pro");
    expect(Date.parse(after.subscription?.currentPeriodEnd as string)).toBeGreaterThan(Date.parse(before));
  });

  it("a failed payment keeps Pro for 7 days, repeated failures don't extend it, and recovery clears it (B9)", async () => {
    const sub = await subscriber();
    const failed = await act(sub.subscriptionId, "fail-payment");
    const graceUntil = (await entitlementsOf(sub.device)).subscription?.graceUntil as string;
    expect(Date.parse(graceUntil)).toBe(Date.parse(failed.subscription.updated_at) + 7 * DAY * 1000);
    expect(await isPro(sub.device)).toBe(true);
    // The provider retries and fails again, and even offers a later dunning end: grace doesn't move.
    await act(sub.subscriptionId, "fail-payment", { grace_until: new Date(Date.now() + 30 * DAY * 1000).toISOString() });
    expect((await entitlementsOf(sub.device)).subscription?.graceUntil).toBe(graceUntil);
    await act(sub.subscriptionId, "recover");
    expect(await entitlementsOf(sub.device)).toMatchObject({ plan: "pro", subscription: { status: "active", graceUntil: null } });
  });

  it("after grace, Free: the provider's dunning end passed, or the provider gave up", async () => {
    const sub = await subscriber();
    await act(sub.subscriptionId, "fail-payment", { grace_until: new Date(Date.now() - 1000).toISOString() });
    expect(await isPro(sub.device)).toBe(false);
    expect((await thirtyDayText(sub.device)).status).toBe(422);
    const other = await subscriber();
    await act(other.subscriptionId, "fail-payment");
    await act(other.subscriptionId, "expire");
    expect(await entitlementsOf(other.device)).toMatchObject({ plan: "free", subscription: { status: "expired" } });
  });

  it("cancel at period end keeps Pro until the period ends, with no job needed (B8); resume undoes it", async () => {
    const sub = await subscriber();
    await act(sub.subscriptionId, "cancel", { at_period_end: true });
    expect(await entitlementsOf(sub.device)).toMatchObject({ plan: "pro", subscription: { status: "canceled", cancelAtPeriodEnd: true } });
    await act(sub.subscriptionId, "resume");
    expect(await entitlementsOf(sub.device)).toMatchObject({ plan: "pro", subscription: { status: "active", cancelAtPeriodEnd: false } });

    await act(sub.subscriptionId, "cancel", { at_period_end: true });
    const events = await countEvents();
    await act(sub.subscriptionId, "set", { fields: { current_period_end: new Date(Date.now() + 3000).toISOString() } });
    expect(await isPro(sub.device)).toBe(true);
    const settled = await countEvents();
    // Time passes; nothing is sent or run. Resolution compares the period end with the database's now().
    const deadline = Date.now() + 15_000;
    while ((await isPro(sub.device)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await isPro(sub.device)).toBe(false);
    expect(await countEvents()).toBe(settled);
    expect(settled).toBe(events + 1);
  });

  it("an immediate cancel, a pause and a full refund are Free at once; a partial refund changes nothing (D4-21)", async () => {
    const cancelled = await subscriber();
    await act(cancelled.subscriptionId, "cancel", { at_period_end: false });
    expect(await isPro(cancelled.device)).toBe(false);

    const paused = await subscriber();
    await act(paused.subscriptionId, "pause");
    expect(await isPro(paused.device)).toBe(false);

    const refunded = await subscriber();
    const partial = await act(refunded.subscriptionId, "refund", { full: false });
    expect(partial.deliveries[0]?.status).toBe(200);
    expect(await isPro(refunded.device)).toBe(true);
    await act(refunded.subscriptionId, "refund", { full: true });
    expect(await entitlementsOf(refunded.device)).toMatchObject({ plan: "free", subscription: { status: "expired" } });
  });

  it("an interval change is recorded", async () => {
    const sub = await subscriber();
    await act(sub.subscriptionId, "interval", { interval: "year" });
    expect((await subscriptionRow(sub.subscriptionId)).billing_interval).toBe("year");
  });

  it("a downgrade changes new actions only: an existing Pro share keeps its snapshot (§17.16)", async () => {
    const sub = await subscriber();
    const share = await thirtyDayText(sub.device);
    expect(share.status).toBe(201);
    await act(sub.subscriptionId, "expire");
    expect((await thirtyDayText(sub.device)).status).toBe(422);
    const kept = await sub.device.call("GET", `/api/v1/shares/${share.body.share.id}`);
    expect(kept.status).toBe(200);
    expect(Date.parse(kept.body.share.expiresAt) - Date.now()).toBeGreaterThan(29 * DAY * 1000);
  });
});

describe("webhook security (T-052.1 … 5, 13, 14)", () => {
  async function pending(sub: { subscriptionId: string }, action = "renew", body: Record<string, unknown> = {}) {
    return (await act(sub.subscriptionId, action, { ...body, deliver: false })).deliveries;
  }

  it("B1: a forged signature, a changed byte or a missing header → 400, nothing stored, nothing changed", async () => {
    const sub = await subscriber();
    const [event] = await pending(sub, "expire");
    const events = await countEvents();
    const forged = { body: event!.body, headers: fakeWebhookHeaders(event!.eventId, event!.body, { secrets: ["attacker-secret-attacker-secret-0001"] }) };
    const changed = { body: event!.body.replace("ended", "activ"), headers: event!.headers };
    const { "webhook-signature": _s, ...unsigned } = event!.headers;
    for (const attempt of [forged, changed, { body: event!.body, headers: unsigned }]) {
      const response = await deliver(attempt);
      expect([response.status, response.body.error.code]).toEqual([400, "WEBHOOK_SIGNATURE_INVALID"]);
    }
    expect(await countEvents()).toBe(events);
    expect(await isPro(sub.device)).toBe(true);
    expect(serverLog()).toContain("billing.webhook_rejected");
    expect(serverLog()).not.toContain(event!.eventId);
  });

  it("B2: an old signed timestamp is refused; a redelivered event is a duplicate with no effect", async () => {
    const sub = await subscriber();
    const [event] = await pending(sub);
    const stale = { body: event!.body, headers: fakeWebhookHeaders(event!.eventId, event!.body, { timestamp: Math.floor(Date.now() / 1000) - 301 }) };
    expect((await deliver(stale)).status).toBe(400);
    expect(await eventRow(event!.eventId)).toBeUndefined();
    expect((await deliver(event!)).status).toBe(200);
    const changes = await auditCount(sub.userId);
    const resigned = { body: event!.body, headers: fakeWebhookHeaders(event!.eventId, event!.body) };
    expect(await deliver(resigned)).toMatchObject({ status: 200, body: { received: true } });
    expect(await auditCount(sub.userId)).toBe(changes);
    expect((await eventRow(event!.eventId)).attempts).toBe(1);
  });

  it("B3: the same event twice → one row, one change", async () => {
    const sub = await subscriber();
    const [event] = await pending(sub, "fail-payment");
    const changes = await auditCount(sub.userId);
    expect((await deliver(event!)).status).toBe(200);
    expect((await deliver(event!)).status).toBe(200);
    expect(await auditCount(sub.userId)).toBe(changes + 1);
    expect((await adminDb().query("select count(*) from app.billing_events where provider_event_id = $1", [event!.eventId])).rows[0].count).toBe("1");
  });

  it("B4: out of order (cancelled delivered before active) ends in the provider's current state", async () => {
    const account = await accountDevice();
    const started = await checkout(account.device);
    const paid = await control<Controlled>(`/checkouts/${checkoutIdOf(started.body.url)}/complete`, { deliver: false });
    const cancelled = await act(paid.subscription.id, "cancel", { at_period_end: false, deliver: false });
    for (const event of [...cancelled.deliveries, ...paid.deliveries.reverse()]) expect((await deliver(event)).status).toBe(200);
    expect(await entitlementsOf(account.device)).toMatchObject({ plan: "free", subscription: { status: "canceled" } });
  });

  it("B4: an older state read from the provider is ignored as stale (provider_updated_at)", async () => {
    const sub = await subscriber();
    const [cancelled] = await pending(sub, "cancel", { at_period_end: true });
    const [resumed] = await pending(sub, "resume");
    expect((await deliver(resumed!)).status).toBe(200);
    // The provider answers the next read with the previous version (replication lag).
    await control(`/subscriptions/${sub.subscriptionId}/stale-reads`, { count: 1 });
    expect((await deliver(cancelled!)).status).toBe(200);
    expect((await eventRow(cancelled!.eventId)).status).toBe("ignored_stale");
    expect(await subscriptionRow(sub.subscriptionId)).toMatchObject({ status: "active", cancel_at_period_end: false });
    expect(await isPro(sub.device)).toBe(true);
  });

  it("B5: a failure answers 500 and is retried; health reports an event failing for an hour", async () => {
    const sub = await subscriber();
    const [event] = await pending(sub, "fail-payment");
    await control("/fail-api", { count: 1, status: 500 });
    const failed = await deliver(event!);
    expect([failed.status, failed.body.error.code]).toEqual([500, "WEBHOOK_PROCESSING_FAILED"]);
    expect(await eventRow(event!.eventId)).toMatchObject({ status: "failed", error: "provider_http_500", attempts: 1 });
    expect((await subscriptionRow(sub.subscriptionId)).status).toBe("active");
    try {
      await adminDb().query("update app.billing_events set received_at = now() - interval '61 minutes' where provider_event_id = $1", [event!.eventId]);
      expect((await api("GET", "/api/v1/health/cron")).body.checks.billingWebhooks).toBe("failing");
    } finally {
      expect((await deliver(event!)).status).toBe(200);
    }
    expect(await eventRow(event!.eventId)).toMatchObject({ status: "processed", error: null, attempts: 2 });
    expect((await subscriptionRow(sub.subscriptionId)).status).toBe("past_due");
    expect((await api("GET", "/api/v1/health/cron")).body.checks.billingWebhooks).toBe("ok");
  });

  it("a verified event that doesn't parse is stored as rejected and answered 200 (no endless retries)", async () => {
    const id = `evt_bad_${randomUUID()}`;
    const body = JSON.stringify({ id, type: "subscription.updated", data: { subscription_id: 7 } });
    expect((await deliver({ body, headers: fakeWebhookHeaders(id, body) })).status).toBe(200);
    expect(await eventRow(id)).toMatchObject({ status: "rejected", error: "schema_invalid", payload: {} });
    expect((await deliver({ body, headers: fakeWebhookHeaders(id, body) })).status).toBe(200);
    expect((await eventRow(id)).attempts).toBe(1);
  });

  it("B13: a subscription with no checkout or customer of ours is stored as unknown and never applied", async () => {
    const stranger = await accountDevice();
    const made = await control<Controlled>("/subscriptions", { custom_data: { subject_type: "user", subject_id: stranger.userId } });
    expect(made.deliveries[0]?.status).toBe(200);
    expect((await eventRow(made.deliveries[0]!.eventId)).status).toBe("ignored_unknown");
    expect(await subscriptionRow(made.subscription.id)).toBeUndefined();
    expect(await isPro(stranger.device)).toBe(false);
  });

  it("B13: a later subscription of a customer we know attaches through billing_customers", async () => {
    const sub = await subscriber();
    await act(sub.subscriptionId, "expire");
    const second = await control<Controlled>("/subscriptions", { customer_id: sub.customerId });
    expect((await eventRow(second.deliveries[0]!.eventId)).status).toBe("processed");
    expect((await subscriptionRow(second.subscription.id)).subject_id).toBe(sub.userId);
    expect(await isPro(sub.device)).toBe(true);
  });

  it("B14: a correctly signed event for a subscription the provider doesn't know changes nothing", async () => {
    const sub = await subscriber();
    const [forged] = (
      await control<Controlled>("/events", {
        type: "subscription.updated",
        data: { subscription_id: "sub_does_not_exist", status: "active", custom_data: { subject_type: "user", subject_id: sub.userId } },
      })
    ).deliveries;
    expect(forged?.status).toBe(200);
    expect((await eventRow(forged!.eventId)).status).toBe("ignored_unknown");
    expect(await subscriptionRow("sub_does_not_exist")).toBeUndefined();
  });

  it("B16: custom data naming another account is ignored: our checkout decides, and the two must agree", async () => {
    const victim = await accountDevice();
    const payer = await accountDevice();
    const started = await checkout(payer.device);
    const ref = (await adminDb().query("select id from app.billing_checkouts where subject_id = $1", [payer.userId])).rows[0].id;
    // A subscription whose custom data pairs the payer's checkout with the victim's ID.
    const made = await control<Controlled>("/subscriptions", { custom_data: { checkout_ref: ref, subject_type: "user", subject_id: victim.userId } });
    expect((await eventRow(made.deliveries[0]!.eventId)).status).toBe("ignored_unknown");
    expect(await isPro(victim.device)).toBe(false);
    expect(await isPro(payer.device)).toBe(false);
    expect(started.status).toBe(201);
  });

  it("another product's subscription on the same provider account never grants Pro", async () => {
    const sub = await subscriber();
    await act(sub.subscriptionId, "expire");
    const other = await control<Controlled>("/subscriptions", { customer_id: sub.customerId, price_id: FAKE_BILLING.otherPrice });
    expect((await eventRow(other.deliveries[0]!.eventId)).status).toBe("ignored_unknown");
    expect(await isPro(sub.device)).toBe(false);
  });

  it("needs no Origin or JSON content type, accepts the previous secret, and caps the body at 256 KB", async () => {
    const sub = await subscriber();
    const [event] = await pending(sub);
    const rotated = { body: event!.body, headers: { ...fakeWebhookHeaders(event!.eventId, event!.body, { secrets: [FAKE_BILLING.previousWebhookSecret] }), "content-type": "text/plain" } };
    expect((await deliver(rotated)).status).toBe(200);
    const huge = "x".repeat(256 * 1024 + 1);
    const tooBig = await deliver({ body: huge, headers: fakeWebhookHeaders("evt_huge", huge) });
    expect([tooBig.status, tooBig.body.error.code]).toEqual([413, "PAYLOAD_TOO_LARGE"]);
    expect(await eventRow("evt_huge")).toBeUndefined();
  });
});

describe("disputes (B7, D4-21)", () => {
  it("an opened or won dispute changes nothing", async () => {
    const sub = await subscriber();
    for (const outcome of ["created", "won"]) {
      const { deliveries } = await act(sub.subscriptionId, "dispute", { outcome });
      expect((await eventRow(deliveries[0]!.eventId)).status).toBe("processed");
    }
    expect(await isPro(sub.device)).toBe(true);
  });

  it("a lost dispute ends the subscription at the provider and counts once; a second one restricts uploads", async () => {
    const sub = await subscriber();
    const lost = await act(sub.subscriptionId, "dispute", { outcome: "lost" });
    expect((await eventRow(lost.deliveries[0]!.eventId)).status).toBe("processed");
    expect((await providerState()).calls).toContainEqual({ method: "POST", path: `/v1/subscriptions/${sub.subscriptionId}/cancel` });
    expect(await entitlementsOf(sub.device)).toMatchObject({ plan: "free", subscription: { status: "canceled" } });
    const flags = async () => (await adminDb().query("select billing_dispute_count, upload_restricted from app.user_flags where user_id = $1", [sub.userId])).rows[0];
    expect(await flags()).toEqual({ billing_dispute_count: 1, upload_restricted: false });
    // The provider reports the same dispute again under another event.
    const disputeId = JSON.parse(lost.deliveries[0]!.body).data.dispute_id as string;
    await act(sub.subscriptionId, "dispute", { outcome: "lost", dispute_id: disputeId });
    expect((await flags()).billing_dispute_count).toBe(1);

    const second = await control<Controlled>("/subscriptions", { customer_id: sub.customerId });
    expect(await isPro(sub.device)).toBe(true);
    await act(second.subscription.id, "dispute", { outcome: "lost" });
    expect(await flags()).toEqual({ billing_dispute_count: 2, upload_restricted: true });
    const post = await sub.device.call("POST", "/api/v1/texts", { destination: "network", content: "after two disputes" });
    expect([post.status, post.body.error.code]).toEqual([403, "UPLOADS_RESTRICTED"]);
  });

  it("a lost dispute the provider doesn't confirm (a forged event) changes and counts nothing (B14)", async () => {
    const sub = await subscriber();
    const [forged] = (await control<Controlled>("/events", { type: "dispute.lost", data: { dispute_id: "dp_forged", subscription_id: sub.subscriptionId } })).deliveries;
    expect(forged?.status).toBe(200);
    expect((await eventRow(forged!.eventId)).status).toBe("ignored_unknown");
    expect(await isPro(sub.device)).toBe(true);
    expect((await adminDb().query("select billing_dispute_count from app.user_flags where user_id = $1", [sub.userId])).rows[0]?.billing_dispute_count ?? 0).toBe(0);
    expect((await providerState()).calls).not.toContainEqual({ method: "POST", path: `/v1/subscriptions/${sub.subscriptionId}/cancel` });
  });
});

describe("concurrent webhooks", () => {
  it("10 parallel deliveries of one event: one is processed, the rest are duplicates, one change", async () => {
    const sub = await subscriber();
    const [event] = (await act(sub.subscriptionId, "fail-payment", { deliver: false })).deliveries;
    const changes = await auditCount(sub.userId);
    const answers = await Promise.all(Array.from({ length: 10 }, () => deliver(event!)));
    expect(answers.map((a) => a.status)).toEqual(Array(10).fill(200));
    expect(await auditCount(sub.userId)).toBe(changes + 1);
    expect(await eventRow(event!.eventId)).toMatchObject({ status: "processed", attempts: 1 });
  });

  it("different events for one subscription in parallel end in the provider's final state", async () => {
    const sub = await subscriber();
    const deliveries = [
      ...(await act(sub.subscriptionId, "fail-payment", { deliver: false })).deliveries,
      ...(await act(sub.subscriptionId, "recover", { deliver: false })).deliveries,
      ...(await act(sub.subscriptionId, "renew", { deliver: false })).deliveries,
      ...(await act(sub.subscriptionId, "cancel", { at_period_end: true, deliver: false })).deliveries,
    ];
    const answers = await Promise.all(deliveries.map((d) => deliver(d)));
    expect(answers.map((a) => a.status)).toEqual(Array(deliveries.length).fill(200));
    const final = (await providerState()).subscriptions.find((s) => s.id === sub.subscriptionId)!;
    expect(await subscriptionRow(sub.subscriptionId)).toMatchObject({ status: "canceled", cancel_at_period_end: true });
    expect((await subscriptionRow(sub.subscriptionId)).provider_updated_at.toISOString()).toBe(final.updated_at);
  });
});

describe("entitlement synchronization", () => {
  it("the user's realtime topic gets account.changed (no IDs) when the subscription changes", async () => {
    const sub = await subscriber();
    const messages: Record<string, unknown>[] = [];
    let probes = 0;
    const channel = sub.device.supabase.channel(`user:${sub.userId}`, { config: { private: true } });
    channel.on("broadcast", { event: "account.changed" }, (m) => messages.push(m.payload as Record<string, unknown>));
    channel.on("broadcast", { event: "probe" }, () => (probes += 1));
    const status = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("TIMED_OUT"), 10_000);
      channel.subscribe((state) => {
        if (state === "SUBSCRIBED" || state === "CHANNEL_ERROR") {
          clearTimeout(timer);
          resolve(state);
        }
      });
    });
    try {
      expect(status).toBe("SUBSCRIBED");
      // Broadcasts are at-most-once (02 §5.3; the client refetches on every subscribe): first prove the
      // channel is live, as the Phase 1 Realtime tests do with a first post, then change the subscription.
      const live = Date.now() + 15_000;
      while (probes === 0 && Date.now() < live) {
        await adminDb().query(`select realtime.send('{"v":1,"type":"probe"}'::jsonb, 'probe', $1, true)`, [`user:${sub.userId}`]);
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(probes).toBeGreaterThan(0);
      await act(sub.subscriptionId, "cancel", { at_period_end: true });
      const deadline = Date.now() + 10_000;
      while (messages.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(messages).toHaveLength(1);
      expect(Object.keys(messages[0]!).sort()).toEqual(["id", "type", "v"]);
      expect(messages[0]).toMatchObject({ v: 1, type: "account.changed" });
    } finally {
      await sub.device.supabase.removeAllChannels();
    }
  });
});

describe("client spoofing and redirects (B10, B11, T4-EN5)", () => {
  it("no body field, header, query or token claim makes a Free account Pro", async () => {
    const { device } = await accountDevice();
    const spoofed = await device.call("POST", "/api/v1/texts", { destination: "network", content: "x", expiresIn: 30 * DAY, plan: "pro" });
    expect(spoofed.status).toBe(400);
    const headers = { "x-plan": "pro", "x-subscription-status": "active", "x-entitled": "true", "x-checkout": randomUUID() };
    const refused = await device.call("POST", "/api/v1/texts", { destination: "network", content: "x", expiresIn: 30 * DAY }, { headers });
    expect([refused.status, refused.body.error.code, refused.body.error.details.requiredPlan]).toEqual([422, "EXPIRY_NOT_ALLOWED", "pro"]);
    const queried = await device.call("GET", "/api/v1/me/entitlements?success=true&plan=pro&status=active&checkout=paid");
    expect(queried.body.plan).toBe("free");
    expect(claimsOf(device.token).app_metadata).not.toHaveProperty("plan");
  });

  it("the return page with forged parameters changes nothing; an unpaid checkout stays Free", async () => {
    const { device, userId } = await accountDevice();
    await checkout(device);
    const ref = (await adminDb().query("select id from app.billing_checkouts where subject_id = $1", [userId])).rows[0].id;
    for (const query of [`checkout=${ref}`, `checkout=${ref}&success=true&status=active&plan=pro`, `checkout=${randomUUID()}&paid=1`]) {
      const page = await fetch(`${stack().origin}/settings/billing?${query}`);
      expect(page.status).toBe(200);
      await page.text();
    }
    expect((await entitlementsOf(device)).plan).toBe("free");
    expect((await adminDb().query("select status from app.billing_checkouts where id = $1", [ref])).rows[0].status).toBe("created");
    await reconcile();
    expect((await entitlementsOf(device)).plan).toBe("free");
  });
});

describe("portal (T4-B2)", () => {
  it("opens the provider's portal for the caller's own customer only", async () => {
    const free = await accountDevice();
    expect((await free.device.call("POST", "/api/v1/billing/portal", {})).status).toBe(404);
    expect((await free.device.call("POST", "/api/v1/billing/portal", { customerId: "cus_someone" })).status).toBe(400);
    const sub = await subscriber();
    const opened = await sub.device.call("POST", "/api/v1/billing/portal", {});
    expect(opened.status).toBe(200);
    const session = (await providerState()).portalSessions.at(-1);
    expect(session).toEqual({ customer_id: sub.customerId, return_url: `${stack().origin}/settings/billing` });
    expect(opened.body.url).toMatch(new RegExp(`^${stack().billing.url}/portal/`));
  });
});

describe("reconciliation (T4-B4, B12)", () => {
  it("needs the bearer secret: none, a wrong one or a user's session token gets 401; current and previous are accepted", async () => {
    const { device } = await accountDevice();
    expect((await postReconcile(null)).status).toBe(401);
    expect((await postReconcile("wrong-secret-wrong-secret-wrong-secret-01")).status).toBe(401);
    expect((await postReconcile(device.token)).status).toBe(401);
    expect((await device.call("POST", "/api/v1/internal/billing/reconcile", {})).status).toBe(401);
    await adminDb().query("update app.job_heartbeats set last_started_at = now() - interval '1 hour' where job = 'billing-reconcile'");
    const before = await lastReconcileFinish();
    const accepted = await postReconcile(stack().billing.previousReconcileSecret);
    expect([accepted.status, accepted.body]).toEqual([202, { started: true }]);
    await reconcileFinished(before);
  });

  it("repairs dropped webhooks and records its heartbeat with counts only", async () => {
    const sub = await subscriber();
    await act(sub.subscriptionId, "cancel", { at_period_end: false, deliver: false });
    expect(await isPro(sub.device)).toBe(true);
    const beat = await reconcile();
    expect(await isPro(sub.device)).toBe(false);
    expect(beat.last_succeeded_at.getTime()).toBeGreaterThan(beat.last_failed_at?.getTime() ?? 0);
    expect(Object.keys(beat.last_result).sort()).toEqual(["applied", "deletionCancels", "errors", "listed", "refetched", "stale", "unchanged", "unknown"]);
    expect(beat.last_result.applied).toBeGreaterThanOrEqual(1);
  });

  it("refetches entitled subscriptions the provider hasn't confirmed for 36 hours", async () => {
    const sub = await subscriber();
    await control(`/subscriptions/${sub.subscriptionId}/hide-from-list`, { hidden: true });
    try {
      await act(sub.subscriptionId, "cancel", { at_period_end: false, deliver: false });
      await reconcile();
      expect(await isPro(sub.device)).toBe(true); // confirmed recently: not refetched, and not listed
      await adminDb().query("update app.subscriptions set synced_at = now() - interval '37 hours' where provider_subscription_id = $1", [sub.subscriptionId]);
      const beat = await reconcile();
      expect(beat.last_result.refetched).toBeGreaterThanOrEqual(1);
      expect(await isPro(sub.device)).toBe(false);
    } finally {
      await control(`/subscriptions/${sub.subscriptionId}/hide-from-list`, { hidden: false });
    }
  });

  it("cancels at period end the subscription of an account in its deletion grace (§17.7.6)", async () => {
    const sub = await subscriber();
    await requestDeletion(sub.userId);
    await reconcile();
    expect((await providerState()).calls).toContainEqual({ method: "POST", path: `/v1/subscriptions/${sub.subscriptionId}/cancel` });
    expect(await subscriptionRow(sub.subscriptionId)).toMatchObject({ status: "canceled", cancel_at_period_end: true });
    expect(await isPro(sub.device)).toBe(true);
  });

  it("one run at a time, 6 an hour, and a provider outage is a failed run that health reports", async () => {
    await adminDb().query("update app.job_heartbeats set last_started_at = now(), last_succeeded_at = now() - interval '1 minute' where job = 'billing-reconcile'");
    expect((await postReconcile()).body).toEqual({ started: false, reason: "running" });
    await setCounter("billingReconcile:global", "1 hour", 6);
    expect((await postReconcile()).status).toBe(429);
    await adminDb().query("delete from app.rate_counters where key like 'billingReconcile:%'");

    await adminDb().query("update app.job_heartbeats set last_started_at = now() - interval '1 hour' where job = 'billing-reconcile'");
    await control("/fail-api", { count: 1, status: 503 });
    const before = await lastReconcileFinish();
    expect((await postReconcile()).status).toBe(202);
    const failed = await reconcileFinished(before);
    expect(failed.last_error).toBe("provider_failed");
    expect((await api("GET", "/api/v1/health/cron")).body.checks.jobs).toBe("failing");
    // A later success clears it (the heartbeat keeps the last error for operators; success is newer).
    const recovered = await reconcile();
    expect(recovered.last_succeeded_at.getTime()).toBeGreaterThan(recovered.last_failed_at.getTime());
    expect((await api("GET", "/api/v1/health/cron")).body.checks.jobs).toBe("ok");
  });
});
