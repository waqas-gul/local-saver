import { withApi } from "@/lib/server/http/handler";
import { viewerContent } from "@/lib/server/links/viewer";

/** GET /api/v1/links/{linkId}/content: the viewer DTO for a grant holder (G4); a room link's by `?cursor&limit` (P4-19). Changes nothing. */
export const GET = withApi<RouteContext<"/api/v1/links/[linkId]/content">>(async ({ request, env, ctx }) => {
  const { linkId } = await ctx.params;
  return viewerContent(request, env, linkId);
});
