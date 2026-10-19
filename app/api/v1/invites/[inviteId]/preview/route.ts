import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { previewInvite } from "@/lib/server/rooms/invites";
import { inviteSecretBody } from "@/lib/shared/api/schemas";

/**
 * POST /api/v1/invites/{inviteId}/preview { secret }: the room's name and size, only after the secret is proven
 * (D4-15). Unknown, wrong or malformed: the same 404 INVITE_UNAVAILABLE.
 */
export const POST = withApi<RouteContext<"/api/v1/invites/[inviteId]/preview">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { inviteId } = await ctx.params;
  const { secret } = await readJson(request, inviteSecretBody);
  return previewInvite(caller, inviteId, secret, request, env);
});
