import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { currentNetwork } from "@/lib/server/network/current";
import { refreshUploadUrl } from "@/lib/server/shares/create";
import { emptyBody } from "@/lib/shared/api/schemas";

/** POST /api/v1/shares/{shareId}/files/{fileId}/upload-url: a fresh PUT URL for a pending file (C4-13). */
export const POST = withApi<RouteContext<"/api/v1/shares/[shareId]/files/[fileId]/upload-url">>(
  async ({ request, env, ctx }) => {
    const caller = await requireCaller(request, env);
    const { shareId, fileId } = await ctx.params;
    await readJson(request, emptyBody);
    const network = await currentNetwork(request, env);
    return { upload: await refreshUploadUrl(caller, network, shareId, fileId, env) };
  },
);
