import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { currentNetwork } from "@/lib/server/network/current";
import { revealText } from "@/lib/server/shares/download";
import { revealBody } from "@/lib/shared/api/schemas";

/** POST /api/v1/shares/{shareId}/reveal { "confirm": true }: reveal a burn text, claiming it (phase 3 §17.12, C-7). */
export const POST = withApi<RouteContext<"/api/v1/shares/[shareId]/reveal">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { shareId } = await ctx.params;
  const body = await readJson(request, revealBody);
  const network = await currentNetwork(request, env);
  return revealText(caller, network, shareId, request, body.confirm);
});
