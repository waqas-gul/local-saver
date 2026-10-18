import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { enforceRateLimit } from "@/lib/server/ratelimit/limits";
import { deleteRoom, getRoom, updateRoom } from "@/lib/server/rooms/rooms";
import { updateRoomBody } from "@/lib/shared/api/schemas";

/** GET /api/v1/rooms/{roomId}: an active member's view of the room; anyone else 404 (T4-R1). */
export const GET = withApi<RouteContext<"/api/v1/rooms/[roomId]">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { roomId } = await ctx.params;
  await enforceRateLimit("roomRead", caller.device.id);
  return { room: await getRoom(caller, roomId) };
});

/** PATCH /api/v1/rooms/{roomId} { name?, membersCanCreateLinks?, defaultExpirySeconds? }: the owner's settings. */
export const PATCH = withApi<RouteContext<"/api/v1/rooms/[roomId]">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { roomId } = await ctx.params;
  const body = await readJson(request, updateRoomBody);
  return { room: await updateRoom(caller, roomId, body) };
});

/** DELETE /api/v1/rooms/{roomId}: the owner deletes the room; its shares end and its members are removed. */
export const DELETE = withApi<RouteContext<"/api/v1/rooms/[roomId]">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { roomId } = await ctx.params;
  await deleteRoom(caller, roomId);
  return new Response(null, { status: 204 });
});
