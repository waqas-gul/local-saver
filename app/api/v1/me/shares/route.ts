import { requireCaller } from "@/lib/server/auth/device";
import { withApi } from "@/lib/server/http/handler";
import { enforceRateLimit } from "@/lib/server/ratelimit/limits";
import { listMyShares } from "@/lib/server/shares/read";

/** GET /api/v1/me/shares: My uploads, from any network (T-014). */
export const GET = withApi(async ({ request, env }) => {
  const caller = await requireCaller(request, env);
  await enforceRateLimit("myShares", caller.device.id);
  return listMyShares(caller, new URL(request.url));
});
