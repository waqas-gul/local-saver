import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { currentNetwork } from "@/lib/server/network/current";
import { editText } from "@/lib/server/shares/text";
import { editTextBody } from "@/lib/shared/api/schemas";

/** PATCH /api/v1/shares/{shareId}/text: versioned edit by the creator (409 on conflict, DEC-027). */
export const PATCH = withApi<RouteContext<"/api/v1/shares/[shareId]/text">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { shareId } = await ctx.params;
  const body = await readJson(request, editTextBody, { maxBytes: 1024 * 1024 });
  const network = await currentNetwork(request, env);
  return { share: await editText(caller, network, shareId, body) };
});
