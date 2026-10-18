import { requireCaller } from "@/lib/server/auth/device";
import { withApi } from "@/lib/server/http/handler";
import { currentNetwork } from "@/lib/server/network/current";
import { multipartStatus } from "@/lib/server/shares/multipart";

/** GET /api/v1/shares/{shareId}/files/{fileId}/multipart: the parts storage holds, to resume (P4-14). */
export const GET = withApi<RouteContext<"/api/v1/shares/[shareId]/files/[fileId]/multipart">>(
  async ({ request, env, ctx }) => {
    const caller = await requireCaller(request, env);
    const { shareId, fileId } = await ctx.params;
    const network = await currentNetwork(request, env);
    return multipartStatus(caller, network, shareId, fileId, env);
  },
);
