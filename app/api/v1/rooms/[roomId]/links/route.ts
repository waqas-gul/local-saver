import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { createRoomLink, listRoomLinks } from "@/lib/server/links/create";
import { createRoomLinkBody } from "@/lib/shared/api/schemas";

/** GET /api/v1/rooms/{roomId}/links: the owner's read-only room links (P4-19), never their secrets or URLs. */
export const GET = withApi<RouteContext<"/api/v1/rooms/[roomId]/links">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { roomId } = await ctx.params;
  return { links: await listRoomLinks(caller, roomId) };
});

/**
 * POST /api/v1/rooms/{roomId}/links { expiresIn, password? }: the owner makes a read-only link to the room's current and
 * future active shares (Pro, roomLinks, E22). Its URL carries the secret and is returned once; the secret and the
 * password are never logged or stored.
 */
export const POST = withApi<RouteContext<"/api/v1/rooms/[roomId]/links">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { roomId } = await ctx.params;
  const body = await readJson(request, createRoomLinkBody);
  return Response.json({ link: await createRoomLink(caller, roomId, body, env) }, { status: 201 });
});
