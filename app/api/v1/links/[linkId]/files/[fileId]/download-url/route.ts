import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { viewerFileUrl } from "@/lib/server/links/viewer";
import { downloadUrlBody } from "@/lib/shared/api/schemas";

/**
 * POST /api/v1/links/{linkId}/files/{fileId}/download-url: a 60 s presigned GET for a grant holder
 * (03 §6). For a burn share the first one claims it and needs { "confirm": true }.
 */
export const POST = withApi<RouteContext<"/api/v1/links/[linkId]/files/[fileId]/download-url">>(async ({ request, env, ctx }) => {
  const { linkId, fileId } = await ctx.params;
  const body = await readJson(request, downloadUrlBody);
  return viewerFileUrl(request, env, linkId, fileId, "download", body.confirm);
});
