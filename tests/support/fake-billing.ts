import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * The fake billing provider (phase 4 §17.7.2, §17.19 "a fake billing provider"): a local HTTP server
 * that behaves like a hosted-checkout merchant of record, for the integration and E2E suites. The
 * app reaches it only through lib/server/billing/providers/fake.ts, as it will reach the real
 * provider through its adapter (P4-13). Never deployed: env.ts refuses the fake provider in
 * production builds and deployments.
 *
 *   Provider API (Bearer API key)  POST /v1/checkouts, POST /v1/portal-sessions,
 *                                  GET /v1/subscriptions[/:id], POST /v1/subscriptions/:id/cancel,
 *                                  GET /v1/disputes/:id
 *   Hosted pages                   GET/POST /pay/:checkoutId (pay → webhooks → 303 to the success URL),
 *                                  GET /portal/:sessionId
 *   Control API (tests only)       /control/*: move subscriptions through their lifecycle, sign custom
 *                                  events, make reads stale, make the API fail, inspect the state.
 *
 * Webhooks are signed like Standard Webhooks (webhook-id, webhook-timestamp, webhook-signature
 * "v1,<base64 HMAC-SHA256 of id.timestamp.body>"). By default each control action delivers its events
 * to the app at once and returns them with the app's answers; `deliver: false` only returns them, so a
 * test can deliver them late, twice, out of order, concurrently, or never.
 */

export const FAKE_BILLING = {
  apiKey: "fake-billing-api-key-local-only-0000000000000001",
  webhookSecret: "fake-billing-webhook-secret-local-only-00000001",
  previousWebhookSecret: "fake-billing-webhook-secret-local-only-00000000",
  prices: { month: "price_fake_pro_month", year: "price_fake_pro_year" },
  /** Another product on the same provider account: never Pro. */
  otherPrice: "price_fake_other_product",
} as const;

const DAY_MS = 86_400_000;

export type FakeSubscription = {
  id: string;
  customer_id: string;
  status: "trialing" | "active" | "past_due" | "paused" | "canceled" | "ended";
  price_id: string;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  grace_until: string | null;
  updated_at: string;
  custom_data: Record<string, string> | null;
};

type Checkout = {
  id: string;
  price_id: string;
  customer_id: string | null;
  custom_data: Record<string, string>;
  success_url: string;
  cancel_url: string;
  status: "open" | "completed";
  subscription_id: string | null;
};

type Dispute = { id: string; subscription_id: string; status: "needs_response" | "under_review" | "won" | "lost" };

export type Delivery = {
  eventId: string;
  type: string;
  headers: Record<string, string>;
  body: string;
  /** The app's answer, when delivered. */
  status?: number;
};

/** The signature a provider would send for this body (base64 HMAC-SHA256 of `id.timestamp.body`). */
export function signFakeWebhook(secret: string, id: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`, "utf8").digest("base64");
}

/** Headers for a signed delivery; `secrets` sign it several times (rotation). */
export function fakeWebhookHeaders(id: string, body: string, options: { timestamp?: number; secrets?: string[] } = {}): Record<string, string> {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const secrets = options.secrets ?? [FAKE_BILLING.webhookSecret];
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": secrets.map((s) => `v1,${signFakeWebhook(s, id, timestamp, body)}`).join(" "),
  };
}

const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  if ((req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function page(res: ServerResponse, html: string) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Fake billing</title></head><body>${html}</body></html>`);
}

export class FakeBillingProvider {
  private server: Server | null = null;
  private lastTime = 0;
  readonly subscriptions = new Map<string, FakeSubscription>();
  private readonly history = new Map<string, FakeSubscription[]>();
  private readonly staleReads = new Map<string, number>();
  /** Left out of the list endpoint (a provider whose listing misses a change): only a refetch finds them. */
  private readonly hidden = new Set<string>();
  readonly checkouts = new Map<string, Checkout>();
  readonly disputes = new Map<string, Dispute>();
  readonly portalSessions = new Map<string, { customer_id: string; return_url: string }>();
  readonly calls: { method: string; path: string }[] = [];
  /** Events the provider produced on its own (API-initiated changes), not delivered automatically. */
  readonly pending: Delivery[] = [];
  private failNext = { count: 0, status: 500 };

  constructor(
    readonly port: number,
    private readonly webhookUrl: string,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.route(req, res).catch((error: unknown) => send(res, 500, { error: String(error) }));
    });
    return new Promise((resolve) => this.server?.listen(this.port, "127.0.0.1", () => resolve()));
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Strictly increasing provider times, so every change is newer than the last (provider_updated_at). */
  private tick(): string {
    this.lastTime = Math.max(Date.now(), this.lastTime + 1);
    return new Date(this.lastTime).toISOString();
  }

  private save(sub: FakeSubscription) {
    sub.updated_at = this.tick();
    const copy = { ...sub, custom_data: sub.custom_data ? { ...sub.custom_data } : null };
    this.subscriptions.set(sub.id, copy);
    this.history.set(sub.id, [...(this.history.get(sub.id) ?? []), copy]);
    return copy;
  }

  private event(type: string, data: Record<string, unknown>, id = newId("evt")): Delivery {
    const body = JSON.stringify({ id, type, created_at: new Date().toISOString(), data });
    return { eventId: id, type, body, headers: fakeWebhookHeaders(id, body) };
  }

  private subEvent(type: string, sub: FakeSubscription, extra: Record<string, unknown> = {}): Delivery {
    return this.event(type, { subscription_id: sub.id, customer_id: sub.customer_id, status: sub.status, ...extra });
  }

  /** POST each delivery to the app, in order, recording its answer. */
  async deliver(deliveries: Delivery[]): Promise<Delivery[]> {
    for (const d of deliveries) {
      const response = await fetch(this.webhookUrl, { method: "POST", headers: d.headers, body: d.body });
      d.status = response.status;
      await response.text();
    }
    return deliveries;
  }

  private periodEnd(priceId: string, from: number): string {
    return new Date(from + (priceId === FAKE_BILLING.prices.year ? 365 : 30) * DAY_MS).toISOString();
  }

  /** Pay a checkout: a customer (if none), an active (or trialing) subscription, two events. */
  complete(checkoutId: string, options: { trial?: boolean } = {}): { subscription: FakeSubscription; events: Delivery[] } {
    const checkout = this.checkouts.get(checkoutId);
    if (!checkout) throw new Error("unknown checkout");
    if (checkout.status === "completed" && checkout.subscription_id) {
      return { subscription: this.subscriptions.get(checkout.subscription_id) as FakeSubscription, events: [] };
    }
    const now = Date.now();
    const sub = this.save({
      id: newId("sub"),
      customer_id: checkout.customer_id ?? newId("cus"),
      status: options.trial ? "trialing" : "active",
      price_id: checkout.price_id,
      current_period_start: new Date(now).toISOString(),
      current_period_end: this.periodEnd(checkout.price_id, now),
      cancel_at_period_end: false,
      canceled_at: null,
      grace_until: null,
      updated_at: "",
      custom_data: { ...checkout.custom_data },
    });
    checkout.status = "completed";
    checkout.subscription_id = sub.id;
    return {
      subscription: sub,
      events: [
        // A real provider sends personal data too; the app must drop it (§17.7.5 logging).
        this.event("checkout.completed", {
          checkout_id: checkout.id,
          subscription_id: sub.id,
          customer_id: sub.customer_id,
          custom_data: checkout.custom_data,
          customer_email: "payer@example.com",
          billing_address: { line1: "1 Example Street", country: "GB" },
        }),
        this.subEvent("subscription.created", sub),
      ],
    };
  }

  /** One lifecycle step on a subscription (the provider's own state machine, as tests drive it). */
  act(id: string, action: string, input: Record<string, unknown>): { subscription: FakeSubscription; events: Delivery[] } {
    const current = this.subscriptions.get(id);
    if (!current) throw new Error("unknown subscription");
    const sub: FakeSubscription = { ...current, custom_data: current.custom_data ? { ...current.custom_data } : null };
    const now = Date.now();
    const events: Delivery[] = [];
    switch (action) {
      case "renew": {
        const start = sub.current_period_end ? Date.parse(sub.current_period_end) : now;
        sub.current_period_start = new Date(start).toISOString();
        sub.current_period_end = this.periodEnd(sub.price_id, start);
        sub.status = "active";
        sub.grace_until = null;
        break;
      }
      case "fail-payment":
        sub.status = "past_due";
        sub.grace_until = typeof input.grace_until === "string" ? input.grace_until : null;
        break;
      case "recover":
        sub.status = "active";
        sub.grace_until = null;
        break;
      case "expire":
        sub.status = "ended";
        sub.grace_until = null;
        sub.canceled_at = new Date(now).toISOString();
        break;
      case "cancel":
        sub.status = "canceled";
        sub.canceled_at = new Date(now).toISOString();
        sub.cancel_at_period_end = input.at_period_end !== false;
        if (!sub.cancel_at_period_end) sub.current_period_end = new Date(now).toISOString();
        break;
      case "resume":
        sub.status = "active";
        sub.cancel_at_period_end = false;
        sub.canceled_at = null;
        break;
      case "pause":
        sub.status = "paused";
        break;
      case "interval":
        sub.price_id = input.interval === "year" ? FAKE_BILLING.prices.year : FAKE_BILLING.prices.month;
        break;
      case "refund": {
        const full = input.full === true;
        if (full) {
          // A full refund with revocation ends the subscription at once (D4-21).
          sub.status = "ended";
          sub.canceled_at = new Date(now).toISOString();
          sub.current_period_end = new Date(now).toISOString();
        }
        const saved = full ? this.save(sub) : current;
        events.push(this.subEvent("refund.created", saved, { amount: full ? 500 : 100, currency: "USD", full }));
        return { subscription: saved, events };
      }
      case "dispute": {
        const outcome = String(input.outcome ?? "created");
        const disputeId = typeof input.dispute_id === "string" ? input.dispute_id : newId("dp");
        const status = outcome === "lost" ? "lost" : outcome === "won" ? "won" : "needs_response";
        this.disputes.set(disputeId, { id: disputeId, subscription_id: sub.id, status });
        events.push(this.event(`dispute.${outcome}`, { dispute_id: disputeId, subscription_id: sub.id, amount: 500, currency: "USD" }));
        return { subscription: current, events };
      }
      case "set":
        Object.assign(sub, input.fields as Partial<FakeSubscription>);
        break;
      default:
        throw new Error(`unknown action ${action}`);
    }
    const saved = this.save(sub);
    const type =
      action === "renew" ? "subscription.renewed" : action === "fail-payment" ? "payment.failed" : action === "recover" ? "payment.succeeded" : "subscription.updated";
    events.push(this.subEvent(type, saved));
    return { subscription: saved, events };
  }

  private authorized(req: IncomingMessage): boolean {
    return req.headers.authorization === `Bearer ${FAKE_BILLING.apiKey}`;
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", this.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";

    if (parts[0] === "v1") {
      this.calls.push({ method, path: url.pathname });
      if (!this.authorized(req)) return send(res, 401, { error: "unauthorized" });
      if (this.failNext.count > 0) {
        this.failNext.count -= 1;
        return send(res, this.failNext.status, { error: "injected failure" });
      }
      return this.api(method, parts.slice(1), url, req, res);
    }
    if (parts[0] === "pay" && parts[1]) return this.payPage(method, parts[1], res);
    if (parts[0] === "portal" && parts[1]) {
      const session = this.portalSessions.get(parts[1]);
      if (!session) return send(res, 404, { error: "not found" });
      return page(res, `<h1>Fake customer portal</h1><p data-testid="fake-portal-customer">${session.customer_id}</p><a href="${session.return_url}">Back</a>`);
    }
    if (parts[0] === "control") return this.control(method, parts.slice(1), req, res);
    return send(res, 404, { error: "not found" });
  }

  private async api(method: string, parts: string[], url: URL, req: IncomingMessage, res: ServerResponse) {
    const [resource, id, verb] = parts;
    if (method === "POST" && resource === "checkouts" && !id) {
      const body = await readBody(req);
      const priceId = String(body.price_id);
      if (![FAKE_BILLING.prices.month, FAKE_BILLING.prices.year, FAKE_BILLING.otherPrice].includes(priceId as never)) {
        return send(res, 400, { error: "unknown price" });
      }
      const checkout: Checkout = {
        id: newId("chk"),
        price_id: priceId,
        customer_id: typeof body.customer_id === "string" ? body.customer_id : null,
        custom_data: (body.custom_data ?? {}) as Record<string, string>,
        success_url: String(body.success_url),
        cancel_url: String(body.cancel_url),
        status: "open",
        subscription_id: null,
      };
      this.checkouts.set(checkout.id, checkout);
      return send(res, 201, { id: checkout.id, url: `${this.url}/pay/${checkout.id}` });
    }
    if (method === "POST" && resource === "portal-sessions" && !id) {
      const body = await readBody(req);
      const sessionId = newId("ps");
      this.portalSessions.set(sessionId, { customer_id: String(body.customer_id), return_url: String(body.return_url) });
      return send(res, 201, { url: `${this.url}/portal/${sessionId}` });
    }
    if (method === "GET" && resource === "subscriptions" && id) {
      const sub = this.subscriptions.get(id);
      if (!sub) return send(res, 404, { error: "not found" });
      const stale = this.staleReads.get(id) ?? 0;
      if (stale > 0) {
        this.staleReads.set(id, stale - 1);
        const versions = this.history.get(id) ?? [];
        return send(res, 200, versions[versions.length - 2] ?? sub);
      }
      return send(res, 200, sub);
    }
    if (method === "GET" && resource === "subscriptions" && !id) {
      const since = url.searchParams.get("updated_since");
      const all = [...this.subscriptions.values()]
        .filter((s) => !this.hidden.has(s.id))
        .filter((s) => !since || Date.parse(s.updated_at) >= Date.parse(since))
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
      const offset = Number(url.searchParams.get("cursor") ?? "0");
      const pageSize = 2;
      const data = all.slice(offset, offset + pageSize);
      return send(res, 200, { data, next_cursor: offset + pageSize < all.length ? String(offset + pageSize) : null });
    }
    if (method === "POST" && resource === "subscriptions" && id && verb === "cancel") {
      if (!this.subscriptions.has(id)) return send(res, 404, { error: "not found" });
      const body = await readBody(req);
      const result = this.act(id, "cancel", { at_period_end: body.at_period_end === true });
      this.pending.push(...result.events);
      return send(res, 200, result.subscription);
    }
    if (method === "GET" && resource === "disputes" && id) {
      const dispute = this.disputes.get(id);
      return dispute ? send(res, 200, dispute) : send(res, 404, { error: "not found" });
    }
    return send(res, 404, { error: "not found" });
  }

  private async payPage(method: string, checkoutId: string, res: ServerResponse) {
    const checkout = this.checkouts.get(checkoutId);
    if (!checkout) return send(res, 404, { error: "not found" });
    if (method === "GET") {
      return page(
        res,
        `<h1>Fake checkout</h1><form method="post"><button type="submit" data-testid="fake-pay">Pay</button></form>` +
          `<a href="${checkout.cancel_url}" data-testid="fake-cancel">Cancel</a>`,
      );
    }
    const { events } = this.complete(checkoutId);
    await this.deliver(events);
    res.writeHead(303, { location: checkout.success_url });
    res.end();
  }

  private async control(method: string, parts: string[], req: IncomingMessage, res: ServerResponse) {
    const body = method === "POST" ? await readBody(req) : {};
    const deliver = body.deliver !== false;
    const respond = async (result: { subscription?: FakeSubscription; events: Delivery[] }) =>
      send(res, 200, { subscription: result.subscription, deliveries: deliver ? await this.deliver(result.events) : result.events });

    try {
      if (method === "GET" && parts[0] === "state") {
        return send(res, 200, {
          subscriptions: [...this.subscriptions.values()],
          checkouts: [...this.checkouts.values()],
          disputes: [...this.disputes.values()],
          portalSessions: [...this.portalSessions.values()],
          calls: this.calls,
          pending: this.pending,
        });
      }
      if (method === "POST" && parts[0] === "checkouts" && parts[1] && parts[2] === "complete") {
        return respond(this.complete(parts[1], { trial: body.trial === true }));
      }
      if (method === "POST" && parts[0] === "subscriptions" && !parts[1]) {
        // A subscription made outside our checkouts (another product, or a stranger's custom data).
        const now = Date.now();
        const priceId = typeof body.price_id === "string" ? body.price_id : FAKE_BILLING.prices.month;
        const sub = this.save({
          id: newId("sub"),
          customer_id: typeof body.customer_id === "string" ? body.customer_id : newId("cus"),
          status: "active",
          price_id: priceId,
          current_period_start: new Date(now).toISOString(),
          current_period_end: this.periodEnd(priceId, now),
          cancel_at_period_end: false,
          canceled_at: null,
          grace_until: null,
          updated_at: "",
          custom_data: (body.custom_data ?? null) as Record<string, string> | null,
        });
        return respond({ subscription: sub, events: [this.subEvent("subscription.created", sub)] });
      }
      if (method === "POST" && parts[0] === "subscriptions" && parts[1] && parts[2] === "hide-from-list") {
        if (body.hidden === false) this.hidden.delete(parts[1]);
        else this.hidden.add(parts[1]);
        return send(res, 200, {});
      }
      if (method === "POST" && parts[0] === "subscriptions" && parts[1] && parts[2] === "stale-reads") {
        this.staleReads.set(parts[1], Number(body.count ?? 1));
        return send(res, 200, {});
      }
      if (method === "POST" && parts[0] === "subscriptions" && parts[1] && parts[2]) {
        return respond(this.act(parts[1], parts[2], body));
      }
      if (method === "POST" && parts[0] === "events") {
        const delivery = this.event(String(body.type), (body.data ?? {}) as Record<string, unknown>, typeof body.id === "string" ? body.id : undefined);
        return respond({ events: [delivery] });
      }
      if (method === "POST" && parts[0] === "fail-api") {
        this.failNext = { count: Number(body.count ?? 1), status: Number(body.status ?? 500) };
        return send(res, 200, {});
      }
      if (method === "POST" && parts[0] === "pending" && parts[1] === "clear") {
        this.pending.length = 0;
        return send(res, 200, {});
      }
    } catch (error) {
      return send(res, 400, { error: String(error) });
    }
    return send(res, 404, { error: "not found" });
  }
}
