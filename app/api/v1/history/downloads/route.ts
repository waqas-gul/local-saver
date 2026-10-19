import { requireCaller } from "@/lib/server/auth/device";
import { listDownloadHistory } from "@/lib/server/history/history";
import { withApi } from "@/lib/server/http/handler";
import { enforceRateLimit } from "@/lib/server/ratelimit/limits";

/** GET /api/v1/history/downloads (P4-20, E24): what happened to the caller's own shares, by actor kind only. */
export const GET = withApi(async ({ request, env }) => {
  const caller = await requireCaller(request, env);
  await enforceRateLimit("historyDownloads", caller.device.id);
  return listDownloadHistory(caller, new URL(request.url));
});
