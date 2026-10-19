import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { currentNetwork } from "@/lib/server/network/current";
import { issuePreviewUrl } from "@/lib/server/shares/download";
import { emptyBody } from "@/lib/shared/api/schemas";

/** POST /api/v1/files/{fileId}/preview-url: a 300 s presigned GET for verified raster images only. */
export const POST = withApi<RouteContext<"/api/v1/files/[fileId]/preview-url">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { fileId } = await ctx.params;
  await readJson(request, emptyBody);
  const network = await currentNetwork(request, env);
  return issuePreviewUrl(caller, network, fileId, request, env);
});
