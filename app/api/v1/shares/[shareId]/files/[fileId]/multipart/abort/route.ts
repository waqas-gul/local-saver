import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { currentNetwork } from "@/lib/server/network/current";
import { abortMultipart } from "@/lib/server/shares/multipart";
import { emptyBody } from "@/lib/shared/api/schemas";

/** POST /api/v1/shares/{shareId}/files/{fileId}/multipart/abort: cancel the upload; the share ends (P4-14). */
export const POST = withApi<RouteContext<"/api/v1/shares/[shareId]/files/[fileId]/multipart/abort">>(
  async ({ request, env, ctx }) => {
    const caller = await requireCaller(request, env);
    const { shareId, fileId } = await ctx.params;
    await readJson(request, emptyBody);
    const network = await currentNetwork(request, env);
    await abortMultipart(caller, network, shareId, fileId);
    return new Response(null, { status: 204 });
  },
);
