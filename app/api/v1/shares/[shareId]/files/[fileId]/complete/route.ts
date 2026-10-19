import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { currentNetwork } from "@/lib/server/network/current";
import { completeFile } from "@/lib/server/shares/complete";
import { emptyBody } from "@/lib/shared/api/schemas";

/** POST /api/v1/shares/{shareId}/files/{fileId}/complete: verify an uploaded object (03 §7.3). */
export const POST = withApi<RouteContext<"/api/v1/shares/[shareId]/files/[fileId]/complete">>(
  async ({ request, env, ctx }) => {
    const caller = await requireCaller(request, env);
    const { shareId, fileId } = await ctx.params;
    await readJson(request, emptyBody);
    const network = await currentNetwork(request, env);
    return { share: await completeFile(caller, network, shareId, fileId, env) };
  },
);
