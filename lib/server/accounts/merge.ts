import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { MergeAnonymousResponse, MergeIntentResponse } from "@/lib/shared/api/schemas";
import { audit } from "../audit/log";
import { deviceIdFrom, type Caller } from "../auth/device";
import { assertAccount, type Principal } from "../auth/session";
import { IntegrationNotConfiguredError } from "../config/integrations";
import { getDb } from "../db/client";
import { deviceCap, deviceLimit } from "../devices/service";
import type { Env } from "../env";
import { ApiError } from "../http/errors";
import { enforceRateLimit } from "../ratelimit/limits";
import { mergeSecretHmacs, newMergeSecret, verifyMergeSecret } from "./secrets";

/**
 * Merging an anonymous browser into an existing account (§17.5.4; threat model §17.9, RISK-024).
 *
 * Signing in replaces the anonymous session in the browser, so the proof is made first: the
 * anonymous session creates an intent (POST /account/merge-intents) and keeps its one-time secret.
 * After signing in, the same browser redeems it (POST /account/merge-anonymous) with the account's
 * token, the secret and its X-Device-Id, which must be the intent's device. app.merge_anonymous_user
 * moves everything in one transaction and deletes the anonymous user. A stolen secret is useless
 * without the device ID and a session of the account it is redeemed into (M1, M13).
 */

function mergeUnavailable(): ApiError {
  return new ApiError(404, "MERGE_UNAVAILABLE", "This merge isn't available");
}

function linkPeppers(env: Env) {
  if (env.linkPeppers.length === 0) throw new IntegrationNotConfiguredError("Account merge", ["LINK_PEPPER"]);
  return env.linkPeppers;
}

export async function createMergeIntent(caller: Caller, env: Env): Promise<MergeIntentResponse> {
  if (!caller.principal.isAnonymous) throw new ApiError(403, "NOT_ANONYMOUS", "This device is already signed in to an account");
  const [pepper] = linkPeppers(env);
  await enforceRateLimit("mergeIntent", caller.principal.userId);
  const intentId = randomUUID();
  const secret = newMergeSecret();
  const [hashed] = mergeSecretHmacs([pepper!], intentId, secret);
  const db = getDb();
  const { rows } = await sql<{ outcome: string; expires_at: Date | null }>`
    select outcome, expires_at
      from app.create_merge_intent(${caller.principal.userId}::uuid, ${caller.principal.sessionId}::uuid, ${caller.device.id}::uuid,
                                   ${intentId}::uuid, ${hashed!.hmac}, ${hashed!.version}::integer)
  `.execute(db);
  const row = rows[0];
  if (row?.outcome === "not_anonymous") throw new ApiError(403, "NOT_ANONYMOUS", "This device is already signed in to an account");
  if (row?.outcome === "suspended") throw new ApiError(403, "USER_SUSPENDED", "This account is suspended");
  if (row?.outcome !== "created" || !row.expires_at) throw new ApiError(401, "DEVICE_UNKNOWN", "Unknown device");
  await audit(db, {
    action: "account.merge_intent_created",
    actorUserId: caller.principal.userId,
    actorDeviceId: caller.device.id,
    networkSpaceId: null,
    targetType: "user",
    targetId: caller.principal.userId,
    metadata: { intentId },
  });
  return { intentId, secret, expiresAt: new Date(row.expires_at).toISOString() };
}

type MergeResult = {
  outcome: string;
  shares?: number;
  links?: number;
  devices?: number;
  memberships?: number;
  bytes?: number;
  activeDevices?: number;
};

export async function redeemMerge(
  principal: Principal,
  request: Request,
  body: { intentId: string; secret: string },
  env: Env,
): Promise<MergeAnonymousResponse> {
  assertAccount(principal);
  const peppers = linkPeppers(env);
  const deviceId = deviceIdFrom(request);
  await enforceRateLimit("mergeRedeemUser", principal.userId);
  await enforceRateLimit("mergeRedeemDevice", deviceId ?? "none");
  const db = getDb();

  // Timing-safe check first (unknown and wrong look the same); the function checks again under its lock.
  const stored = await db
    .selectFrom("app.merge_intents")
    .select(["secret_hmac", "pepper_version"])
    .where("id", "=", body.intentId)
    .executeTakeFirst();
  const proven = verifyMergeSecret(
    peppers,
    stored ? { secretHmac: stored.secret_hmac, pepperVersion: stored.pepper_version } : null,
    body.intentId,
    body.secret,
  );
  if (!proven || !deviceId) throw mergeUnavailable();

  const hmacs = mergeSecretHmacs(peppers, body.intentId, body.secret).map((h) => h.hmac);
  // The target account's cap (E26): the device that arrives with the merge counts against it.
  const cap = await deviceCap(principal);
  const { rows } = await sql<{ result: MergeResult }>`
    select app.merge_anonymous_user(${body.intentId}::uuid, ${hmacs}::bytea[], ${principal.userId}::uuid,
                                    ${principal.sessionId}::uuid, ${deviceId}::uuid, ${cap}::integer) as result
  `.execute(db);
  const result = rows[0]?.result;
  switch (result?.outcome) {
    case "merged":
      return {
        merged: {
          shares: result.shares ?? 0,
          links: result.links ?? 0,
          devices: result.devices ?? 0,
          memberships: result.memberships ?? 0,
          bytes: result.bytes ?? 0,
        },
      };
    case "suspended":
      throw new ApiError(403, "USER_SUSPENDED", "This account is suspended");
    case "device_limit":
      throw deviceLimit(result.activeDevices ?? cap, cap);
    case "conflict":
    case "invalid":
      throw new ApiError(409, "MERGE_CONFLICT", "This merge can't be completed for this account");
    default:
      throw mergeUnavailable();
  }
}
