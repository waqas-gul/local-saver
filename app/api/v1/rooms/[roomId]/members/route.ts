import { requireCaller } from "@/lib/server/auth/device";
import { withApi } from "@/lib/server/http/handler";
import { enforceRateLimit } from "@/lib/server/ratelimit/limits";
import { listMembers } from "@/lib/server/rooms/members";

/** GET /api/v1/rooms/{roomId}/members: who is in the room, as members see each other (D4-15); anyone else 404. */
export const GET = withApi<RouteContext<"/api/v1/rooms/[roomId]/members">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { roomId } = await ctx.params;
  await enforceRateLimit("listMembers", caller.device.id);
  return { members: await listMembers(caller, roomId) };
});
