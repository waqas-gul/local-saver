import { after } from "next/server";
import { billingNotConfigured, billingProvider } from "@/lib/server/billing/provider";
import { beginReconcile, reconcileAuthorized, runReconcile } from "@/lib/server/billing/reconcile";
import { ApiError } from "@/lib/server/http/errors";
import { withWebhook } from "@/lib/server/http/webhook";
import { log } from "@/lib/server/log";
import { enforceRateLimit } from "@/lib/server/ratelimit/limits";

/**
 * POST /api/v1/internal/billing/reconcile (phase 4 §17.7.7, D4-22): posted daily by pg_cron through
 * pg_net with the Vault secret. Authenticated by that bearer secret alone (constant time, current and
 * previous); a user's session token is never enough. Answers 202 and reconciles after the response.
 */
export const POST = withWebhook(async ({ request, env }) => {
  if (env.billingReconcileSecrets.length === 0) throw billingNotConfigured();
  if (!reconcileAuthorized(request.headers.get("authorization"), env.billingReconcileSecrets)) {
    throw new ApiError(401, "UNAUTHENTICATED", "Authentication required");
  }
  const provider = billingProvider(env);
  await enforceRateLimit("billingReconcile", "global");
  const run = await beginReconcile();
  if (!run) return Response.json({ started: false, reason: "running" }, { status: 202 });
  after(async () => {
    try {
      await runReconcile(provider, run.updatedSince);
    } catch (error) {
      log.error("billing.reconcile_crashed", { provider: provider.id, err: error });
    }
  });
  return Response.json({ started: true }, { status: 202 });
});
