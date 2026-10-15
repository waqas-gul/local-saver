import "server-only";
import { getDb } from "../db/client";
import type { Env } from "../env";
import { ApiError } from "../http/errors";
import { requirePrincipal, type Principal } from "./session";

/**
 * Device binding (03 §8): X-Device-Id must name a non-revoked device of the authenticated
 * user. Suspended users are refused here, before any service runs.
 */

export const DEVICE_HEADER = "x-device-id";

export type Device = { id: string; label: string; platform: string };
export type Caller = { principal: Principal; device: Device };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function deviceIdFrom(request: Request): string | null {
  const value = request.headers.get(DEVICE_HEADER);
  return value && UUID.test(value) ? value.toLowerCase() : null;
}

export async function findOwnDevice(principal: Principal, deviceId: string): Promise<Device | null> {
  const row = await getDb()
    .selectFrom("app.devices")
    .select(["id", "label", "platform"])
    .where("id", "=", deviceId)
    .where("user_id", "=", principal.userId)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return row ?? null;
}

async function assertNotSuspended(principal: Principal): Promise<void> {
  const flags = await getDb()
    .selectFrom("app.user_flags")
    .select("suspended_at")
    .where("user_id", "=", principal.userId)
    .executeTakeFirst();
  if (flags?.suspended_at) throw new ApiError(403, "USER_SUSPENDED", "This account is suspended");
}

/** Authenticated user plus a device they own: required by every Phase 1 endpoint except registration. */
export async function requireCaller(request: Request, env: Env): Promise<Caller> {
  const principal = await requirePrincipal(request, env);
  const deviceId = deviceIdFrom(request);
  if (!deviceId) throw new ApiError(401, "DEVICE_REQUIRED", "X-Device-Id is required");
  const device = await findOwnDevice(principal, deviceId);
  if (!device) throw new ApiError(401, "DEVICE_UNKNOWN", "Unknown device");
  await assertNotSuspended(principal);
  return { principal, device };
}
