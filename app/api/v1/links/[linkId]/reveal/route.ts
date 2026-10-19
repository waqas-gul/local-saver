import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { viewerReveal } from "@/lib/server/links/viewer";
import { revealBody } from "@/lib/shared/api/schemas";

/**
 * POST /api/v1/links/{linkId}/reveal { "confirm": true, "shareId"? }: a grant holder reveals a burn text, claiming it.
 * Through a room link (P4-19) the share is named.
 */
export const POST = withApi<RouteContext<"/api/v1/links/[linkId]/reveal">>(async ({ request, env, ctx }) => {
  const { linkId } = await ctx.params;
  const body = await readJson(request, revealBody);
  return viewerReveal(request, env, linkId, body.confirm, body.shareId);
});
