import { requireCaller } from "@/lib/server/auth/device";
import { withApi } from "@/lib/server/http/handler";
import { revokeInvite } from "@/lib/server/rooms/invites";

/** DELETE /api/v1/invites/{inviteId}: the owner of the invite's room revokes it; anyone else 404. */
export const DELETE = withApi<RouteContext<"/api/v1/invites/[inviteId]">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { inviteId } = await ctx.params;
  await revokeInvite(caller, inviteId);
  return new Response(null, { status: 204 });
});
