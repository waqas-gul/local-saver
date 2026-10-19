import "server-only";
import type { Env } from "../env";
import { ApiError } from "../http/errors";
import { createFakeProvider } from "./providers/fake";
import type { BillingProvider } from "./types";

/** This deployment's billing provider (phase 4 §17.7.2), chosen by BILLING_PROVIDER. */

export function billingNotConfigured(): ApiError {
  return new ApiError(503, "BILLING_NOT_CONFIGURED", "Payments aren't available");
}

const cache = new WeakMap<Env, BillingProvider>();

/** This deployment's provider, or 503 BILLING_NOT_CONFIGURED (§17.7.2). */
export function billingProvider(env: Env): BillingProvider {
  const config = env.billing;
  if (!config) throw billingNotConfigured();
  let provider = cache.get(env);
  if (!provider) {
    provider = createFakeProvider(config);
    cache.set(env, provider);
  }
  return provider;
}
