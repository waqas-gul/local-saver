import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { currentNetwork } from "@/lib/server/network/current";
import { issuePartUrls } from "@/lib/server/shares/multipart";
import { partUrlsBody } from "@/lib/shared/api/schemas";

/** POST /api/v1/shares/{shareId}/files/{fileId}/multipart/parts: part URLs, each signed for its size (P4-14). */
export const POST = withApi<RouteContext<"/api/v1/shares/[shareId]/files/[fileId]/multipart/parts">>(
  async ({ request, env, ctx }) => {
    const caller = await requireCaller(request, env);
    const { shareId, fileId } = await ctx.params;
    const { partNumbers } = await readJson(request, partUrlsBody);
    const network = await currentNetwork(request, env);
    return issuePartUrls(caller, network, shareId, fileId, partNumbers, env);
  },
);
