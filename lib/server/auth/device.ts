import "server-only";
import { sql } from "kysely";
import { getDb } from "../db/client";
import type { Env } from "../env";
import { ApiError } from "../http/errors";
import { assertMfaSatisfied, requireSession, type Principal } from "./session";

/**
 * Device binding (03 §8): X-Device-Id must name a non-revoked device of the authenticated
 * user. Suspended users are refused here, before any service runs.
 *
 * Phase 4 (C4-2): the device must also be bound to the token's Auth session, so one browser of an
 * account can't act as another. A mismatch answers like an unknown device (the browser registers
 * again at its next start, which binds); a revoked device answers 401 DEVICE_REVOKED and the
 * client signs out.
 *
 * P4-24: then an account with an authenticator must be at aal2 (403 MFA_REQUIRED), before the suspension check, so an
 * aal1 session learns nothing more about the account.
 */

export const DEVICE_HEADER = "x-device-id";

export type Device = { id: string; label: string; platform: string };
export type Caller = { principal: Principal; device: Device };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function deviceIdFrom(request: Request): string | null {
  const value = request.headers.get(DEVICE_HEADER);
  return value && UUID.test(value) ? value.toLowerCase() : null;
}

type OwnDevice = Device & { authSessionId: string | null; revoked: boolean };

async function findOwnDevice(principal: Principal, deviceId: string): Promise<OwnDevice | null> {
  const row = await getDb()
    .selectFrom("app.devices")
    .select(["id", "label", "platform", "auth_session_id", "revoked_at"])
    .where("id", "=", deviceId)
    .where("user_id", "=", principal.userId)
    .executeTakeFirst();
  if (!row) return null;
  return { id: row.id, label: row.label, platform: row.platform, authSessionId: row.auth_session_id, revoked: row.revoked_at !== null };
}

export function deviceRevoked(): ApiError {
  return new ApiError(401, "DEVICE_REVOKED", "This device was signed out");
}

export async function assertNotSuspended(principal: Principal): Promise<void> {
  const flags = await getDb()
    .selectFrom("app.user_flags")
    .select("suspended_at")
    .where("user_id", "=", principal.userId)
    .executeTakeFirst();
  if (flags?.suspended_at) throw new ApiError(403, "USER_SUSPENDED", "This account is suspended");
}

/** Authenticated user plus a device they own: required by every Phase 1 endpoint except registration. */
export async function requireCaller(request: Request, env: Env): Promise<Caller> {
  const principal = await requireSession(request, env);
  const deviceId = deviceIdFrom(request);
  if (!deviceId) throw new ApiError(401, "DEVICE_REQUIRED", "X-Device-Id is required");
  const device = await findOwnDevice(principal, deviceId);
  if (device?.revoked) throw deviceRevoked();
  if (!device || device.authSessionId !== principal.sessionId) throw new ApiError(401, "DEVICE_UNKNOWN", "Unknown device");
  await assertMfaSatisfied(principal);
  await assertNotSuspended(principal);
  return { principal, device: { id: device.id, label: device.label, platform: device.platform } };
}

/**
 * The device list and revocation (§17.5.6) take the token alone: a browser at the device cap has no device yet. P4-26:
 * its Auth session must still exist, as registration and the merge require in their own functions, so a revoked or
 * signed-out browser's still-valid token can't list the account's devices or revoke the others. The order is the other
 * guards': a revoked device first (requireCaller), then the MFA check, then a session that ended (registration).
 */
export async function requireLiveSession(request: Request, env: Env): Promise<Principal> {
  const principal = await requireSession(request, env);
  const { rows } = await sql<{ state: string }>`
    select app.auth_session_state(${principal.userId}::uuid, ${principal.sessionId}::uuid) as state
  `.execute(getDb());
  if (rows[0]?.state === "revoked") throw deviceRevoked();
  await assertMfaSatisfied(principal);
  if (rows[0]?.state !== "live") throw new ApiError(401, "UNAUTHENTICATED", "A valid session is required");
  return principal;
}
