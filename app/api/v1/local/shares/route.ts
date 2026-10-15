import { requireCaller } from "@/lib/server/auth/device";
import { withApi } from "@/lib/server/http/handler";
import { currentNetwork } from "@/lib/server/network/current";
import { enforceRateLimit } from "@/lib/server/ratelimit/limits";
import { listLocalFeed } from "@/lib/server/shares/read";

/** GET /api/v1/local/shares: the "This network" feed for the caller's current eligible network. */
export const GET = withApi(async ({ request, env }) => {
  const caller = await requireCaller(request, env);
  await enforceRateLimit("feed", caller.device.id);
  const network = await currentNetwork(request, env);
  return listLocalFeed(caller, network, new URL(request.url));
});
