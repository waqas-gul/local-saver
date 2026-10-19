import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { currentNetwork } from "@/lib/server/network/current";
import { createText, TEXT_BODY_MAX_BYTES } from "@/lib/server/shares/text";
import { createTextBody } from "@/lib/shared/api/schemas";

/** POST /api/v1/texts: post text to this network or link-only (04 §4.5, DEC-033). */
export const POST = withApi(async ({ request, env }) => {
  const caller = await requireCaller(request, env);
  // A text can take up to twice its size once JSON-escaped; the service enforces the plan's limit.
  const body = await readJson(request, createTextBody, { maxBytes: TEXT_BODY_MAX_BYTES });
  const network = await currentNetwork(request, env);
  return Response.json({ share: await createText(caller, network, body, env, request) }, { status: 201 });
});
