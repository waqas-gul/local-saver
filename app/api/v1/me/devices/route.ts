import { requireLiveSession } from "@/lib/server/auth/device";
import { deviceCap, listDevices } from "@/lib/server/devices/service";
import { withApi } from "@/lib/server/http/handler";

/**
 * GET /api/v1/me/devices (§17.5.6): the caller's devices. Token only, no X-Device-Id: a browser
 * refused at the device cap has no device yet and must still see what it can revoke. Its Auth
 * session must still exist (P4-26).
 */
export const GET = withApi(async ({ request, env }) => {
  const principal = await requireLiveSession(request, env);
  return { devices: await listDevices(principal), maxDevices: await deviceCap(principal) };
});
