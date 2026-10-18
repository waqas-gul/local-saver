import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { enforceRateLimit } from "@/lib/server/ratelimit/limits";
import { createInvite, listInvites } from "@/lib/server/rooms/invites";
import { createInviteBody } from "@/lib/shared/api/schemas";

/** GET /api/v1/rooms/{roomId}/invites: the owner's open invites, links and pairing codes (never their secrets). */
export const GET = withApi<RouteContext<"/api/v1/rooms/[roomId]/invites">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { roomId } = await ctx.params;
  await enforceRateLimit("listInvites", caller.principal.userId);
  return { invites: await listInvites(caller, roomId) };
});

/**
 * POST /api/v1/rooms/{roomId}/invites: the owner makes an invite link { kind: "invite_link", expiresIn, maxUses? }
 * (multiUseInvites, E21) or a QR pairing code { kind: "pairing" } (one use, 10 minutes; E20, P4-18). Its URL carries
 * the secret and is returned once; the secret is never logged or stored.
 */
export const POST = withApi<RouteContext<"/api/v1/rooms/[roomId]/invites">>(async ({ request, env, ctx }) => {
  const caller = await requireCaller(request, env);
  const { roomId } = await ctx.params;
  const body = await readJson(request, createInviteBody);
  return Response.json({ invite: await createInvite(caller, roomId, body, env) }, { status: 201 });
});
