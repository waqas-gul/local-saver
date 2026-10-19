import "server-only";
import { sql } from "kysely";
import type { DeviceDto, DeviceListItem } from "@/lib/shared/api/schemas";
import { deviceIdFrom, deviceRevoked } from "../auth/device";
import { mfaEnrolled, mfaRequired, type Principal } from "../auth/session";
import { getDb } from "../db/client";
import { resolveEntitlements } from "../entitlements/resolve";
import { ApiError, notFound } from "../http/errors";
import { enforceRateLimit } from "../ratelimit/limits";
import { cleanLabel, generateDeviceLabel, platformFromUserAgent } from "./labels";

/**
 * Devices (04 §3.2): one row per browser installation, bound to that browser's Auth session
 * (C4-2). POST /devices registers a new device, or refreshes or rebinds the caller's own device
 * when X-Device-Id names it (app.register_device decides, under the user's row lock).
 *
 * Phase 4 (§17.5.6): an account has at most its plan's maxSignedInDevices active devices (E26;
 * D4-5, the plan's recommendation: 10 for every account, Free or Pro); anonymous users are one
 * browser each and have no cap. List and revoke work with the token alone, so a new browser at the
 * cap can see and revoke a device before it has one of its own.
 */

/** The caller's device cap (E26), from the entitlements of this request. */
export async function deviceCap(principal: Principal): Promise<number> {
  return (await resolveEntitlements(principal)).limits.maxSignedInDevices;
}

/** Revoked devices stay visible this long (they are purged after it, 04 §3.2). */
const REVOKED_VISIBLE_DAYS = 30;

type Registered = { outcome: string; device_id: string | null; label: string | null; platform: string | null; active_devices: number | null };

export function deviceLimit(activeDevices: number, maxDevices: number): ApiError {
  return new ApiError(409, "DEVICE_LIMIT", "This account has the most devices it can have", { maxDevices, activeDevices });
}

export async function registerDevice(principal: Principal, request: Request): Promise<DeviceDto> {
  // Per session, i.e. per browser (deviation DV4-3): an account's browsers each start the app, so a
  // per-user budget would make them refuse one another. Anonymous users have one session each, so
  // for them nothing changes. New rows still need new sessions, which Supabase Auth rate-limits.
  await enforceRateLimit("registerDevice", principal.sessionId);
  const cap = await deviceCap(principal);
  const { rows } = await sql<Registered>`
    select outcome, device_id, label, platform, active_devices
      from app.register_device(${principal.userId}::uuid, ${principal.sessionId}::uuid, ${deviceIdFrom(request)}::uuid,
                               ${cap}::integer, ${generateDeviceLabel()},
                               ${platformFromUserAgent(request.headers.get("user-agent"))})
  `.execute(getDb());
  const row = rows[0];
  switch (row?.outcome) {
    case "created":
    case "refreshed":
    case "bound":
      return { id: row.device_id as string, label: row.label as string, platform: row.platform as string };
    case "revoked":
      throw deviceRevoked();
    case "suspended":
      throw new ApiError(403, "USER_SUSPENDED", "This account is suspended");
    case "limit":
      throw deviceLimit(row.active_devices ?? cap, cap);
    default:
      // session_ended: the token verified, but its session was signed out, revoked or deleted.
      throw new ApiError(401, "UNAUTHENTICATED", "A valid session is required");
  }
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

/** GET /me/devices: the caller's devices, with recently revoked ones. */
export async function listDevices(principal: Principal): Promise<DeviceListItem[]> {
  await enforceRateLimit("listDevices", principal.userId);
  const rows = await getDb()
    .selectFrom("app.devices")
    .select(["id", "label", "platform", "created_at", "last_seen_at", "revoked_at", "auth_session_id"])
    .where("user_id", "=", principal.userId)
    .where((eb) =>
      eb.or([eb("revoked_at", "is", null), eb("revoked_at", ">", sql<Date>`now() - make_interval(days => ${REVOKED_VISIBLE_DAYS})`)]),
    )
    .orderBy(sql`revoked_at is not null`)
    .orderBy("last_seen_at", "desc")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    platform: row.platform,
    createdAt: new Date(row.created_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    current: row.revoked_at === null && row.auth_session_id === principal.sessionId,
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
  }));
}

/**
 * DELETE /me/devices/{id}: revoke one of the caller's devices (app.revoke_device deletes its Auth
 * session and ends its presence). From a session that has no active device of its own, an account
 * with MFA must be at aal2 (D4-30, recommended): a stolen code session alone can't sign every
 * browser out. Since P4-24 the route's guard (requireLiveSession since P4-26) refuses every aal1 session of such an
 * account; this stays as the action's own rule.
 */
export async function revokeOwnDevice(principal: Principal, deviceId: string): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) throw notFound();
  await enforceRateLimit("revokeDevice", principal.userId);
  const db = getDb();
  const current = await db
    .selectFrom("app.devices")
    .select("id")
    .where("user_id", "=", principal.userId)
    .where("auth_session_id", "=", principal.sessionId)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  if (!current && principal.aal !== "aal2" && (await mfaEnrolled(principal.userId))) throw mfaRequired();
  const { rows } = await sql<{ revoked: boolean }>`
    select app.revoke_device(${principal.userId}::uuid, ${deviceId.toLowerCase()}::uuid, 'user', ${current?.id ?? null}::uuid) as revoked
  `.execute(db);
  if (!rows[0]?.revoked) throw notFound();
}
