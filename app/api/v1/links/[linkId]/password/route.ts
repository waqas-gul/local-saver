import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { requireOpenGrant } from "@/lib/server/links/grants";
import { proveLinkPassword } from "@/lib/server/links/password";
import { linkPasswordBody } from "@/lib/shared/api/schemas";

/**
 * POST /api/v1/links/{linkId}/password { password, turnstileToken? }: a browser holding a grant for this link
 * (from its secret or a code) proves the link's password, and its grant opens the link (P4-16, C4-8). 404
 * without a grant, 410 for an ended link whatever the password, then the attempt limits, then the hash.
 */
export const POST = withApi<RouteContext<"/api/v1/links/[linkId]/password">>(async ({ request, env, ctx }) => {
  const { linkId } = await ctx.params;
  const { password, turnstileToken } = await readJson(request, linkPasswordBody);
  const grant = await requireOpenGrant(request, env, linkId);
  await proveLinkPassword(request, env, grant, password, turnstileToken);
  return new Response(null, { status: 204 });
});
