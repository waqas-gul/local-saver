import "server-only";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { z } from "zod";
import type { checkoutBody, CheckoutResponse, PortalResponse } from "@/lib/shared/api/schemas";
import { audit } from "../audit/log";
import type { Caller } from "../auth/device";
import { assertAccount } from "../auth/session";
import { getDb } from "../db/client";
import { loadEntitlementState } from "../entitlements/resolve";
import type { Env } from "../env";
import { ApiError, notFound } from "../http/errors";
import { log } from "../log";
import { enforceRateLimit } from "../ratelimit/limits";
import { billingProvider } from "./provider";
import type { BillingProvider } from "./types";

/**
 * Checkout and the customer portal (phase 4 §17.7.6). The subject is always the caller: no request
 * field can name another (strict schema, B16). A checkout grants nothing: Pro starts only when the
 * provider's subscription state arrives through the webhook or reconciliation (§17.7.4). The return
 * page ignores its query parameters for entitlement and only polls GET /me/entitlements (B11).
 */

const IDEMPOTENCY_ENDPOINT = "POST /api/v1/billing/checkout";
const BILLING_PAGE = "/settings/billing";

type StoredCheckout = { checkoutRef: string; url: string | null };

function keyHash(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

/** `Idempotency-Key` is required here (§17.13): a double click must not start two checkouts. */
export function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key");
  if (key === null) throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required");
  if (key.length < 1 || key.length > 200) throw new ApiError(400, "INVALID_IDEMPOTENCY_KEY", "Invalid Idempotency-Key");
  return key;
}

async function storedCheckout(userId: string, hash: Buffer): Promise<StoredCheckout | null> {
  const row = await getDb()
    .selectFrom("app.idempotency_keys")
    .select("response")
    .where("user_id", "=", userId)
    .where("endpoint", "=", IDEMPOTENCY_ENDPOINT)
    .where("key_hash", "=", hash)
    .where(sql<boolean>`expires_at > now()`)
    .executeTakeFirst();
  return (row?.response as StoredCheckout | undefined) ?? null;
}

function replayOf(stored: StoredCheckout): CheckoutResponse {
  // The first request with this key is still talking to the provider.
  if (!stored.url) throw new ApiError(409, "CHECKOUT_IN_PROGRESS", "This checkout is still being created, try again in a moment");
  return { url: stored.url };
}

/** Only an http(s) URL from the provider is handed to the browser; https wherever the app is. */
function safeRedirect(url: string, env: Env): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError(502, "BILLING_PROVIDER_ERROR", "The payment provider didn't answer as expected");
  }
  const allowed = env.isHttps ? ["https:"] : ["https:", "http:"];
  if (!allowed.includes(parsed.protocol)) throw new ApiError(502, "BILLING_PROVIDER_ERROR", "The payment provider didn't answer as expected");
  return parsed.toString();
}

async function customerOf(provider: BillingProvider, userId: string): Promise<string | null> {
  const row = await getDb()
    .selectFrom("app.billing_customers")
    .select("provider_customer_id")
    .where("subject_type", "=", "user")
    .where("subject_id", "=", userId)
    .where("provider", "=", provider.id)
    .executeTakeFirst();
  return row?.provider_customer_id ?? null;
}

/**
 * POST /api/v1/billing/checkout: an account, not in its deletion grace, not already entitled by a
 * subscription (an operator's override doesn't count: it may end), with an Idempotency-Key.
 */
export async function createCheckout(
  caller: Caller,
  env: Env,
  body: z.infer<typeof checkoutBody>,
  idempotencyKey: string,
): Promise<CheckoutResponse> {
  const { principal } = caller;
  assertAccount(principal);
  const provider = billingProvider(env);
  const hash = keyHash(idempotencyKey);
  const previous = await storedCheckout(principal.userId, hash);
  if (previous) return replayOf(previous);

  const state = await loadEntitlementState(principal.userId);
  if (state.deletionPending) {
    throw new ApiError(403, "ACCOUNT_DELETION_PENDING", "This account is being deleted. Cancel the deletion to subscribe.");
  }
  if (state.entitled) throw new ApiError(409, "ALREADY_SUBSCRIBED", "This account already has a subscription");
  await enforceRateLimit("checkout", principal.userId);

  const customerId = await customerOf(provider, principal.userId);
  let checkoutRef: string;
  try {
    checkoutRef = await getDb()
      .transaction()
      .execute(async (trx) => {
        const checkout = await trx
          .insertInto("app.billing_checkouts")
          .values({ subject_type: "user", subject_id: principal.userId, provider: provider.id, plan: body.plan, billing_interval: body.interval })
          .returning("id")
          .executeTakeFirstOrThrow();
        // Claims the key before the provider is called: a concurrent request with it waits for this one.
        await trx
          .insertInto("app.idempotency_keys")
          .values({
            user_id: principal.userId,
            endpoint: IDEMPOTENCY_ENDPOINT,
            key_hash: hash,
            response: JSON.stringify({ checkoutRef: checkout.id, url: null } satisfies StoredCheckout),
          })
          .execute();
        return checkout.id;
      });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      const winner = await storedCheckout(principal.userId, hash);
      if (winner) return replayOf(winner);
    }
    throw error;
  }

  let created: { url: string; providerCheckoutId: string };
  try {
    created = await provider.createCheckout({
      subject: { type: "user", id: principal.userId },
      plan: body.plan,
      interval: body.interval,
      customerId,
      checkoutRef,
      successUrl: `${env.appOrigin}${BILLING_PAGE}?checkout=${checkoutRef}`,
      cancelUrl: `${env.appOrigin}${BILLING_PAGE}`,
    });
  } catch (error) {
    // Release the key so the same click can be retried, and close the attempt.
    await getDb()
      .deleteFrom("app.idempotency_keys")
      .where("user_id", "=", principal.userId)
      .where("endpoint", "=", IDEMPOTENCY_ENDPOINT)
      .where("key_hash", "=", hash)
      .execute();
    await getDb().updateTable("app.billing_checkouts").set({ status: "expired" }).where("id", "=", checkoutRef).execute();
    log.error("billing.checkout_failed", { provider: provider.id, checkoutRef, err: error });
    throw new ApiError(502, "BILLING_PROVIDER_ERROR", "The payment provider isn't answering, try again later");
  }

  const url = safeRedirect(created.url, env);
  await getDb()
    .transaction()
    .execute(async (trx) => {
      await trx.updateTable("app.billing_checkouts").set({ provider_checkout_id: created.providerCheckoutId }).where("id", "=", checkoutRef).execute();
      await trx
        .updateTable("app.idempotency_keys")
        .set({ response: JSON.stringify({ checkoutRef, url } satisfies StoredCheckout) })
        .where("user_id", "=", principal.userId)
        .where("endpoint", "=", IDEMPOTENCY_ENDPOINT)
        .where("key_hash", "=", hash)
        .execute();
      await audit(trx, {
        action: "billing.checkout_created",
        actorUserId: principal.userId,
        actorDeviceId: caller.device.id,
        networkSpaceId: null,
        targetType: "user",
        targetId: principal.userId,
        metadata: { checkoutRef, provider: provider.id, interval: body.interval },
      });
    });
  return { url };
}

/** POST /api/v1/billing/portal: the provider's customer portal, for an account with a billing customer. */
export async function createPortal(caller: Caller, env: Env): Promise<PortalResponse> {
  const { principal } = caller;
  assertAccount(principal);
  const provider = billingProvider(env);
  await enforceRateLimit("portal", principal.userId);
  const customerId = await customerOf(provider, principal.userId);
  if (!customerId) throw notFound();
  let session: { url: string };
  try {
    session = await provider.createPortalSession({ customerId, returnUrl: `${env.appOrigin}${BILLING_PAGE}` });
  } catch (error) {
    log.error("billing.portal_failed", { provider: provider.id, err: error });
    throw new ApiError(502, "BILLING_PROVIDER_ERROR", "The payment provider isn't answering, try again later");
  }
  return { url: safeRedirect(session.url, env) };
}
