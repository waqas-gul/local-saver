import "server-only";
import { sql } from "kysely";
import type { DeviceDto } from "@/lib/shared/api/schemas";
import { deviceIdFrom, findOwnDevice } from "../auth/device";
import type { Principal } from "../auth/session";
import { getDb } from "../db/client";
import { ApiError, notFound } from "../http/errors";
import { enforceRateLimit } from "../ratelimit/limits";
import { cleanLabel, generateDeviceLabel, platformFromUserAgent } from "./labels";

/**
 * Devices (04 §3.2): one row per browser installation. POST /devices registers a new device,
 * or refreshes the caller's own device when X-Device-Id names it.
 */

export async function registerDevice(principal: Principal, request: Request): Promise<DeviceDto> {
  await enforceRateLimit("registerDevice", principal.userId);
  const db = getDb();

  const existingId = deviceIdFrom(request);
  if (existingId) {
    const existing = await findOwnDevice(principal, existingId);
    if (existing) {
      await db.updateTable("app.devices").set({ last_seen_at: sql`now()` }).where("id", "=", existing.id).execute();
      return existing;
    }
  }

  return db
    .insertInto("app.devices")
    .values({
      user_id: principal.userId,
      label: generateDeviceLabel(),
      platform: platformFromUserAgent(request.headers.get("user-agent")),
    })
    .returning(["id", "label", "platform"])
    .executeTakeFirstOrThrow();
}

export async function renameDevice(principal: Principal, deviceId: string, rawLabel: string): Promise<DeviceDto> {
  const label = cleanLabel(rawLabel);
  if (label === "") {
    throw new ApiError(400, "VALIDATION_FAILED", "Request body failed validation", [{ path: "label", code: "too_small" }]);
  }
  await enforceRateLimit("renameDevice", principal.userId);
  const device = /^[0-9a-f-]{36}$/i.test(deviceId)
    ? await getDb()
        .updateTable("app.devices")
        .set({ label })
        .where("id", "=", deviceId)
        .where("user_id", "=", principal.userId)
        .where("revoked_at", "is", null)
        .returning(["id", "label", "platform"])
        .executeTakeFirst()
    : undefined;
  if (!device) throw notFound();
  return device;
}
