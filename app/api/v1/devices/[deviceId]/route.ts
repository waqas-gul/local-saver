import { requireCaller } from "@/lib/server/auth/device";
import { renameDevice } from "@/lib/server/devices/service";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { renameDeviceBody } from "@/lib/shared/api/schemas";

/** PATCH /api/v1/devices/{deviceId}: rename one of the caller's own devices. */
export const PATCH = withApi<RouteContext<"/api/v1/devices/[deviceId]">>(async ({ request, env, ctx }) => {
  const { principal } = await requireCaller(request, env);
  const { deviceId } = await ctx.params;
  const body = await readJson(request, renameDeviceBody);
  return { device: await renameDevice(principal, deviceId, body.label) };
});
