import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { observeNetwork } from "@/lib/server/network/observe";
import { observeBody } from "@/lib/shared/api/schemas";

/** POST /api/v1/network/observe: derive the network, record presence, return its status (03 §3.6). */
export const POST = withApi(async ({ request, env }) => {
  const caller = await requireCaller(request, env);
  await readJson(request, observeBody);
  return observeNetwork(caller, request, env);
});
