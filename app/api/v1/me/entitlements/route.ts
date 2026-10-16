import { requireCaller } from "@/lib/server/auth/device";
import { resolveEntitlements } from "@/lib/server/entitlements/plans";
import { withApi } from "@/lib/server/http/handler";
import { enforceRateLimit } from "@/lib/server/ratelimit/limits";
import { burnAvailable } from "@/lib/server/shares/burn";

/**
 * GET /api/v1/me/entitlements (C-7): what this device may use right now, so the UI shows only what
 * the server will accept. Resolved on the server; never read from the client (07 §2.2).
 */
export const GET = withApi(async ({ request, env }) => {
  const caller = await requireCaller(request, env);
  await enforceRateLimit("entitlements", caller.device.id);
  const entitlements = resolveEntitlements(caller.principal);
  return { plan: entitlements.plan, features: { burnAfterDownload: await burnAvailable(entitlements, env) } };
});
