import { requireCaller } from "@/lib/server/auth/device";
import { listShareHistory } from "@/lib/server/history/history";
import { withApi } from "@/lib/server/http/handler";
import { enforceRateLimit } from "@/lib/server/ratelimit/limits";

/** GET /api/v1/history/shares (P4-20, E24): the caller's shares in every state, within the plan's history window. */
export const GET = withApi(async ({ request, env }) => {
  const caller = await requireCaller(request, env);
  await enforceRateLimit("historyShares", caller.device.id);
  return listShareHistory(caller, new URL(request.url));
});
