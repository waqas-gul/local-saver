import { requirePrincipal } from "@/lib/server/auth/session";
import { registerDevice } from "@/lib/server/devices/service";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { registerDeviceBody } from "@/lib/shared/api/schemas";

/** POST /api/v1/devices: register or refresh the current device (02 §6.2). */
export const POST = withApi(async ({ request, env }) => {
  const principal = await requirePrincipal(request, env);
  await readJson(request, registerDeviceBody);
  return { device: await registerDevice(principal, request) };
});
