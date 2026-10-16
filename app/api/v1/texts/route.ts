import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { currentNetwork } from "@/lib/server/network/current";
import { createText } from "@/lib/server/shares/text";
import { createTextBody } from "@/lib/shared/api/schemas";

/** POST /api/v1/texts: post text to this network or link-only (04 §4.5, DEC-033). */
export const POST = withApi(async ({ request, env }) => {
  const caller = await requireCaller(request, env);
  // 100 KB of text can take several times that once JSON-escaped; the service enforces the limit.
  const body = await readJson(request, createTextBody, { maxBytes: 1024 * 1024 });
  const network = await currentNetwork(request, env);
  return Response.json({ share: await createText(caller, network, body, env, request) }, { status: 201 });
});
