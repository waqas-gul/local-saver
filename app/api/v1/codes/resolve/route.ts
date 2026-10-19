import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { resolveCode } from "@/lib/server/links/codes";
import { resolveCodeBody } from "@/lib/shared/api/schemas";

/**
 * POST /api/v1/codes/resolve { code }: a valid short code grants this browser access to its
 * link and returns only the link ID, never the link secret (DEC-014).
 */
export const POST = withApi(async ({ request, env }) => {
  const body = await readJson(request, resolveCodeBody);
  const { linkId, setCookie } = await resolveCode(request, env, body);
  return Response.json({ linkId }, { headers: { "Set-Cookie": setCookie } });
});
