import { requireCaller } from "@/lib/server/auth/device";
import { withApi } from "@/lib/server/http/handler";
import { enforceRateLimit } from "@/lib/server/ratelimit/limits";
import { listRoomShares } from "@/lib/server/rooms/rooms";

/** GET /api/v1/rooms/{roomId}/shares: the room's feed, for its members on any network (cursor pagination). */
export const GET = withApi<RouteContext<"/api/v1/rooms/[roomId]/shares">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { roomId } = await ctx.params;
  await enforceRateLimit("roomShares", caller.device.id);
  return listRoomShares(caller, roomId, new URL(request.url));
});
