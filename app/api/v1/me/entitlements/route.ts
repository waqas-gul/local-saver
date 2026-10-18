import { requireCaller } from "@/lib/server/auth/device";
import { describeEntitlements } from "@/lib/server/entitlements/me";
import { withApi } from "@/lib/server/http/handler";
import { enforceRateLimit } from "@/lib/server/ratelimit/limits";

/**
 * GET /api/v1/me/entitlements (C-7, phase 4 §17.6.3): what this device may use right now, so the UI
 * shows only what the server will accept. Resolved on the server; never read from the client (07 §2.2).
 */
export const GET = withApi(async ({ request, env }) => {
  const caller = await requireCaller(request, env);
  await enforceRateLimit("entitlements", caller.device.id);
  return describeEntitlements(caller, env);
});
