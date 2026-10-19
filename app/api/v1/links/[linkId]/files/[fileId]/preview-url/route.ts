import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { viewerFileUrl } from "@/lib/server/links/viewer";
import { emptyBody } from "@/lib/shared/api/schemas";

/** POST /api/v1/links/{linkId}/files/{fileId}/preview-url: a 300 s presigned GET for a verified raster image (03 §6). */
export const POST = withApi<RouteContext<"/api/v1/links/[linkId]/files/[fileId]/preview-url">>(async ({ request, env, ctx }) => {
  const { linkId, fileId } = await ctx.params;
  await readJson(request, emptyBody);
  const { url, expiresAt } = await viewerFileUrl(request, env, linkId, fileId, "preview");
  return { url, expiresAt };
});
