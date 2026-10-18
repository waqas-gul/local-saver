import { requireCaller } from "@/lib/server/auth/device";
import { assertAccount } from "@/lib/server/auth/session";
import { createCheckout, requireIdempotencyKey } from "@/lib/server/billing/checkout";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { checkoutBody } from "@/lib/shared/api/schemas";

/**
 * POST /api/v1/billing/checkout (phase 4 §17.7.6): start a hosted checkout for the caller's account
 * and answer its URL, which the browser navigates to. Grants nothing: Pro arrives with the provider's
 * subscription state (webhook or reconciliation).
 */
export const POST = withApi(async ({ request, env }) => {
  const caller = await requireCaller(request, env);
  assertAccount(caller.principal);
  const body = await readJson(request, checkoutBody);
  const idempotencyKey = requireIdempotencyKey(request);
  return Response.json(await createCheckout(caller, env, body, idempotencyKey), { status: 201 });
});
