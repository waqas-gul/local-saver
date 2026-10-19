import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { regenerateCode } from "@/lib/server/links/create";
import { currentNetwork } from "@/lib/server/network/current";
import { regenerateCodeBody } from "@/lib/shared/api/schemas";

/** POST /api/v1/links/{linkId}/code: the link's creator gets a new short code; the old one stops working (DV2-5). */
export const POST = withApi<RouteContext<"/api/v1/links/[linkId]/code">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { linkId } = await ctx.params;
  const body = await readJson(request, regenerateCodeBody);
  const network = await currentNetwork(request, env);
  return { shortCode: await regenerateCode(caller, network, linkId, body, env) };
});
