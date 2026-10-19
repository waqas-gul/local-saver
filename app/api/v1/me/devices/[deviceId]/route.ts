import { requireLiveSession } from "@/lib/server/auth/device";
import { revokeOwnDevice } from "@/lib/server/devices/service";
import { withApi } from "@/lib/server/http/handler";

/**
 * DELETE /api/v1/me/devices/{deviceId} (§17.5.6): revoke one of the caller's devices. Its Auth
 * session is deleted and its next request answers 401 DEVICE_REVOKED. Token only, like the list,
 * and its Auth session must still exist (P4-26).
 */
export const DELETE = withApi<RouteContext<"/api/v1/me/devices/[deviceId]">>(async ({ request, env, ctx }) => {
  const principal = await requireLiveSession(request, env);
  const { deviceId } = await ctx.params;
  await revokeOwnDevice(principal, deviceId);
  return new Response(null, { status: 204 });
});
