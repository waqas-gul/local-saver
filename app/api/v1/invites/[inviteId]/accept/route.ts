import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { acceptInvite } from "@/lib/server/rooms/invites";
import { inviteSecretBody } from "@/lib/shared/api/schemas";

/**
 * POST /api/v1/invites/{inviteId}/accept { secret }: join the invite's room (anonymous browsers too, D4-19), after a
 * confirmation on the page, so link unfurlers never join. Idempotent for members.
 */
export const POST = withApi<RouteContext<"/api/v1/invites/[inviteId]/accept">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { inviteId } = await ctx.params;
  const { secret } = await readJson(request, inviteSecretBody);
  return { room: await acceptInvite(caller, inviteId, secret, request, env) };
});
