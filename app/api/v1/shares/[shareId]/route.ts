import { requireCaller } from "@/lib/server/auth/device";
import { withApi } from "@/lib/server/http/handler";
import { currentNetwork } from "@/lib/server/network/current";
import { enforceRateLimit } from "@/lib/server/ratelimit/limits";
import { deleteShare } from "@/lib/server/shares/end";
import { getShare } from "@/lib/server/shares/read";

type Ctx = RouteContext<"/api/v1/shares/[shareId]">;

/** GET /api/v1/shares/{shareId}: detail for devices on the share's network, or its creator. */
export const GET = withApi<Ctx>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  await enforceRateLimit("shareRead", caller.device.id);
  const { shareId } = await ctx.params;
  const network = await currentNetwork(request, env);
  return { share: await getShare(caller, network, shareId) };
});

/** DELETE /api/v1/shares/{shareId}: the creator ends the share (T-011). */
export const DELETE = withApi<Ctx>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { shareId } = await ctx.params;
  const network = await currentNetwork(request, env);
  await deleteShare(caller, network, shareId);
  return new Response(null, { status: 204 });
});
