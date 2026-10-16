import { requireCaller } from "@/lib/server/auth/device";
import { withApi } from "@/lib/server/http/handler";
import { revokeLink } from "@/lib/server/links/create";
import { currentNetwork } from "@/lib/server/network/current";

/** DELETE /api/v1/links/{linkId}: the link's creator revokes it; viewers lose access on their next request. */
export const DELETE = withApi<RouteContext<"/api/v1/links/[linkId]">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { linkId } = await ctx.params;
  const network = await currentNetwork(request, env);
  await revokeLink(caller, network, linkId);
  return new Response(null, { status: 204 });
});
