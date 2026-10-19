import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { unlockLink } from "@/lib/server/links/unlock";
import { unlockBody } from "@/lib/shared/api/schemas";

/**
 * POST /api/v1/links/{linkId}/unlock { secret, password?, turnstileToken? }: anyone with the link proves its
 * secret and gets a viewer session cookie plus a grant (03 §4.2). No Supabase session is involved. A password
 * link answers 409 PASSWORD_REQUIRED (with the cookie) unless the right password comes along (P4-16).
 */
export const POST = withApi<RouteContext<"/api/v1/links/[linkId]/unlock">>(async ({ request, env, ctx }) => {
  const { linkId } = await ctx.params;
  const body = await readJson(request, unlockBody);
  const { content, setCookie } = await unlockLink(request, env, linkId, body);
  return Response.json(content, { headers: { "Set-Cookie": setCookie } });
});
