import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { createLink, listLinks } from "@/lib/server/links/create";
import { currentNetwork } from "@/lib/server/network/current";
import { createLinkBody } from "@/lib/shared/api/schemas";

type Ctx = RouteContext<"/api/v1/shares/[shareId]/links">;

/**
 * POST /api/v1/shares/{shareId}/links: the share's creator creates a link, optionally with a
 * short code, from any network (DEC-033). The URL (secret in the fragment) and the code are
 * returned once.
 */
export const POST = withApi<Ctx>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { shareId } = await ctx.params;
  const body = await readJson(request, createLinkBody);
  const network = await currentNetwork(request, env);
  return Response.json({ link: await createLink(caller, network, shareId, body, env) }, { status: 201 });
});

/** GET /api/v1/shares/{shareId}/links: the creator's links for the share, without secrets or codes. */
export const GET = withApi<Ctx>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { shareId } = await ctx.params;
  const network = await currentNetwork(request, env);
  return { links: await listLinks(caller, network, shareId) };
});
