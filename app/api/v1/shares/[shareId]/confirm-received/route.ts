import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { currentNetwork } from "@/lib/server/network/current";
import { confirmReceived } from "@/lib/server/shares/download";
import { emptyBody } from "@/lib/shared/api/schemas";

/** POST /api/v1/shares/{shareId}/confirm-received: the claimant of a burn share ends it now ("I've got it"). */
export const POST = withApi<RouteContext<"/api/v1/shares/[shareId]/confirm-received">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { shareId } = await ctx.params;
  await readJson(request, emptyBody);
  const network = await currentNetwork(request, env);
  await confirmReceived(caller, network, shareId);
  return new Response(null, { status: 204 });
});
