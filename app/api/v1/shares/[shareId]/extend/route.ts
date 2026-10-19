import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { currentNetwork } from "@/lib/server/network/current";
import { extendShare } from "@/lib/server/shares/extend";
import { extendShareBody } from "@/lib/shared/api/schemas";

/** POST /api/v1/shares/{shareId}/extend: a later expiry, in place (200 with the share) or by copy (202), P4-15. */
export const POST = withApi<RouteContext<"/api/v1/shares/[shareId]/extend">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { shareId } = await ctx.params;
  const body = await readJson(request, extendShareBody);
  const network = await currentNetwork(request, env);
  const result = await extendShare(caller, network, shareId, body, env);
  if (result.status === 202) return Response.json({ extension: { status: "pending" } }, { status: 202 });
  return { share: result.share };
});
