import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { currentNetwork } from "@/lib/server/network/current";
import { issueDownloadUrl } from "@/lib/server/shares/download";
import { downloadUrlBody } from "@/lib/shared/api/schemas";

/**
 * POST /api/v1/files/{fileId}/download-url: a 60 s presigned GET (03 §6). For a burn share the
 * first one claims it and needs { "confirm": true } (phase 3 §17.12).
 */
export const POST = withApi<RouteContext<"/api/v1/files/[fileId]/download-url">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { fileId } = await ctx.params;
  const body = await readJson(request, downloadUrlBody);
  const network = await currentNetwork(request, env);
  return issueDownloadUrl(caller, network, fileId, request, env, body.confirm);
});
