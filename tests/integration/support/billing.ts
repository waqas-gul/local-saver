import { randomUUID } from "node:crypto";
import type { Delivery, FakeSubscription } from "../../support/fake-billing";
import { accountDevice } from "./entitlements";
import { adminDb, api, stack, type Device, type Json } from "./api";

/**
 * Billing fixtures for Phase 4C (§17.19.3): drive the fake provider through its control API, deliver
 * its signed webhooks to the app, and read what the app stored. Pro here only ever comes from the
 * provider's state reaching the app (webhook or reconciliation), as in production.
 */

export type Controlled = { subscription: FakeSubscription; deliveries: Delivery[] };

export async function control<T = Json>(path: string, body: unknown = {}, method: "GET" | "POST" = "POST"): Promise<T> {
  const response = await fetch(`${stack().billing.url}/control${path}`, {
    method,
    headers: method === "POST" ? { "content-type": "application/json" } : undefined,
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`control ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

export const providerState = () =>
  control<{ subscriptions: FakeSubscription[]; checkouts: Json[]; portalSessions: Json[]; calls: { method: string; path: string }[]; pending: Delivery[] }>(
    "/state",
    undefined,
    "GET",
  );

/** One lifecycle step at the provider; its events are delivered unless `deliver: false`. */
export function act(subscriptionId: string, action: string, body: Record<string, unknown> = {}): Promise<Controlled> {
  return control<Controlled>(`/subscriptions/${encodeURIComponent(subscriptionId)}/${action}`, body);
}

/** Deliver a signed webhook (or any body and headers) to the app, as the provider would. */
export async function deliver(delivery: Pick<Delivery, "headers" | "body">): Promise<{ status: number; body: Json; text: string }> {
  const response = await fetch(`${stack().origin}/api/v1/billing/webhook`, { method: "POST", headers: delivery.headers, body: delivery.body });
  const text = await response.text();
  let body: Json = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, body, text };
}

export function checkout(device: Device, interval: "month" | "year" = "month", key: string = randomUUID(), body?: unknown) {
  return device.call("POST", "/api/v1/billing/checkout", body ?? { plan: "pro", interval }, { headers: { "idempotency-key": key } });
}

/** The fake provider's checkout ID from a checkout URL (…/pay/{id}). */
export const checkoutIdOf = (url: string) => url.split("/pay/")[1] as string;

/** An account that bought Pro through the whole flow: checkout, payment, webhooks. */
export async function subscriber(options: { interval?: "month" | "year"; trial?: boolean; ip?: string | null } = {}) {
  const account = await accountDevice(options.ip);
  const started = await checkout(account.device, options.interval ?? "month");
  if (started.status !== 201) throw new Error(`checkout failed: ${started.status} ${started.text}`);
  const paid = await control<Controlled>(`/checkouts/${checkoutIdOf(started.body.url)}/complete`, { trial: options.trial ?? false });
  const failed = paid.deliveries.filter((d) => d.status !== 200);
  if (failed.length > 0) throw new Error(`webhook delivery failed: ${failed.map((d) => d.status).join(", ")}`);
  return { ...account, subscriptionId: paid.subscription.id, customerId: paid.subscription.customer_id, url: started.body.url as string };
}

export async function entitlementsOf(device: Device) {
  const response = await device.call("GET", "/api/v1/me/entitlements");
  if (response.status !== 200) throw new Error(`entitlements: ${response.status} ${response.text}`);
  return response.body as { plan: string; source: string; subscription: { status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; graceUntil: string | null } | null };
}

export async function subscriptionRow(providerSubscriptionId: string) {
  const { rows } = await adminDb().query("select * from app.subscriptions where provider = 'fake' and provider_subscription_id = $1", [
    providerSubscriptionId,
  ]);
  return rows[0] as Json;
}

export async function eventRow(providerEventId: string) {
  const { rows } = await adminDb().query("select * from app.billing_events where provider = 'fake' and provider_event_id = $1", [providerEventId]);
  return rows[0] as Json;
}

export async function countEvents(): Promise<number> {
  return Number((await adminDb().query("select count(*) from app.billing_events")).rows[0].count);
}

export async function auditCount(userId: string, action = "billing.subscription_changed"): Promise<number> {
  const { rows } = await adminDb().query("select count(*) from app.audit_events where action = $1 and target_id = $2", [action, userId]);
  return Number(rows[0].count);
}

/** POST the reconcile route; `secret` null sends no Authorization header. */
export function postReconcile(secret: string | null = stack().billing.reconcileSecret, extra: Record<string, string> = {}) {
  return api("POST", "/api/v1/internal/billing/reconcile", {
    origin: null,
    headers: { ...(secret === null ? {} : { authorization: `Bearer ${secret}` }), ...extra },
    body: {},
  });
}

/** When the last reconcile run finished, by the database's clock (null before the first). */
export async function lastReconcileFinish(): Promise<string | null> {
  const { rows } = await adminDb().query(
    "select greatest(last_succeeded_at, last_failed_at)::text as at from app.job_heartbeats where job = 'billing-reconcile'",
  );
  return (rows[0]?.at as string | null) ?? null;
}

/** Wait until a run finishes after `before` (lastReconcileFinish); returns its heartbeat. */
export async function reconcileFinished(before: string | null, timeoutMs = 20_000): Promise<Json> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await adminDb().query(
      `select * from app.job_heartbeats
        where job = 'billing-reconcile'
          and greatest(last_succeeded_at, last_failed_at) > coalesce($1::timestamptz, '-infinity')`,
      [before],
    );
    if (rows[0]) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("reconciliation did not finish");
}

/** Run reconciliation to the end (clearing any hold or rate limit a previous test left). */
export async function reconcile(): Promise<Json> {
  await adminDb().query("update app.job_heartbeats set last_started_at = now() - interval '1 hour' where job = 'billing-reconcile'");
  await adminDb().query("delete from app.rate_counters where key like 'billingReconcile:%'");
  const before = await lastReconcileFinish();
  const response = await postReconcile();
  if (response.status !== 202 || response.body.started !== true) throw new Error(`reconcile: ${response.status} ${response.text}`);
  return reconcileFinished(before);
}

/** An account in its deletion grace (E30; the request API comes with P4-22). */
export async function requestDeletion(userId: string): Promise<void> {
  await adminDb().query("select app.ensure_profile($1)", [userId]);
  const { rows } = await adminDb().query("select app.request_account_deletion($1, interval '7 days') as at", [userId]);
  if (!rows[0]?.at) throw new Error("deletion request failed");
}
