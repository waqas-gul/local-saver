import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { enforceRateLimit } from "@/lib/server/ratelimit/limits";
import { createRoom, listRooms } from "@/lib/server/rooms/rooms";
import { createRoomBody } from "@/lib/shared/api/schemas";

/** GET /api/v1/rooms: the caller's rooms (active memberships), from any network (P4-17). */
export const GET = withApi(async ({ request, env }) => {
  const caller = await requireCaller(request, env);
  await enforceRateLimit("listRooms", caller.device.id);
  return listRooms(caller, new URL(request.url));
});

/** POST /api/v1/rooms { name? }: a private room (Pro, E17; a custom name too, E18). The caller becomes its owner. */
export const POST = withApi(async ({ request, env }) => {
  const caller = await requireCaller(request, env);
  const body = await readJson(request, createRoomBody);
  return Response.json({ room: await createRoom(caller, body) }, { status: 201 });
});
