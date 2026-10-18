import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { revokeLink, updateLink } from "@/lib/server/links/create";
import { currentNetwork } from "@/lib/server/network/current";
import { updateLinkBody } from "@/lib/shared/api/schemas";

/** DELETE /api/v1/links/{linkId}: the link's creator revokes it; viewers lose access on their next request. */
export const DELETE = withApi<RouteContext<"/api/v1/links/[linkId]">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { linkId } = await ctx.params;
  const network = await currentNetwork(request, env);
  await revokeLink(caller, network, linkId);
  return new Response(null, { status: 204 });
});

/**
 * PATCH /api/v1/links/{linkId} { password }: the link's creator sets or changes (Pro) or removes (null, always)
 * its password (P4-16). Every change invalidates the link's grants. The password is never logged or returned.
 */
export const PATCH = withApi<RouteContext<"/api/v1/links/[linkId]">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { linkId } = await ctx.params;
  const body = await readJson(request, updateLinkBody);
  const network = await currentNetwork(request, env);
  return { link: await updateLink(caller, network, linkId, body, env) };
});
