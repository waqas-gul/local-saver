import { requireCaller } from "@/lib/server/auth/device";
import { withApi } from "@/lib/server/http/handler";
import { removeMember } from "@/lib/server/rooms/members";

/**
 * DELETE /api/v1/rooms/{roomId}/members/{memberId}: a member leaves (`me`, or their own ID); the owner removes anyone
 * else. The owner can't leave (409 OWNER_CANNOT_LEAVE).
 */
export const DELETE = withApi<RouteContext<"/api/v1/rooms/[roomId]/members/[memberId]">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { roomId, memberId } = await ctx.params;
  await removeMember(caller, roomId, memberId);
  return new Response(null, { status: 204 });
});
