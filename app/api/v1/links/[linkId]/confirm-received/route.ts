import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { viewerConfirmReceived } from "@/lib/server/links/viewer";
import { emptyBody } from "@/lib/shared/api/schemas";

/** POST /api/v1/links/{linkId}/confirm-received: the viewer who claimed a burn share ends it now. */
export const POST = withApi<RouteContext<"/api/v1/links/[linkId]/confirm-received">>(async ({ request, env, ctx }) => {
  const { linkId } = await ctx.params;
  await readJson(request, emptyBody);
  await viewerConfirmReceived(request, env, linkId);
  return new Response(null, { status: 204 });
});
