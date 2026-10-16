import "server-only";
import { sql } from "kysely";
import type { z } from "zod";
import type { createLinkBody, CreatedLinkDto, LinkSummaryDto, regenerateCodeBody } from "@/lib/shared/api/schemas";
import { formatShortCode } from "@/lib/shared/short-code";
import { audit } from "../audit/log";
import type { Caller } from "../auth/device";
import { IntegrationNotConfiguredError } from "../config/integrations";
import { getDb } from "../db/client";
import { resolveEntitlements, type Entitlements } from "../entitlements/plans";
import type { Env } from "../env";
import { assertRemoteLinksEnabled } from "../flags";
import { ApiError, notFound } from "../http/errors";
import type { NetworkView } from "../network/current";
import { assertNotRestricted } from "../policy/posting";
import { enforceRateLimit } from "../ratelimit/limits";
import { assertRemoteAllowed } from "../security/file-policy";
import { requireOwnShare } from "../shares/read";
import { isLinkId, linkSecretHmac, newLinkId, newLinkSecret, newShortCode, shareUrl, shortCodeHmacs } from "./secrets";

/**
 * Share links, creator side (DEC-013, DEC-033, 03 §4.1, §4.4): only a share's creator creates,
 * lists and revokes its links, from any network. A link targets that one share, never a network
 * feed (Q-028). The secret and the code are returned once and stored only as peppered HMACs.
 */

const MAX_LISTED = 50;
const INSERT_ATTEMPTS = 3; // a new random ID or code colliding is astronomically unlikely, but handled

function requirePeppers(env: Env, codes: boolean) {
  if (env.linkPeppers.length === 0) throw new IntegrationNotConfiguredError("Share links", ["LINK_PEPPER"]);
  if (codes && env.codePeppers.length === 0) throw new IntegrationNotConfiguredError("Short codes", ["CODE_PEPPER"]);
  return { link: env.linkPeppers[0]!, code: env.codePeppers[0] };
}

function allowedOption(options: readonly number[], value: number, what: string): number {
  if (!options.includes(value)) throw new ApiError(422, "EXPIRY_NOT_ALLOWED", `This ${what} is not available`, { allowed: options });
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

/** The code expiry: an allowed option (≤ 24 h on Free), never past the link. */
function codeSeconds(entitlements: Entitlements, expiresIn: number | undefined): number {
  const { shortCodeExpiryOptionsSeconds, shortCodeDefaultExpirySeconds, shortCodeMaxTtlSeconds } = entitlements.limits;
  const seconds = allowedOption(shortCodeExpiryOptionsSeconds, expiresIn ?? shortCodeDefaultExpirySeconds, "code expiry");
  return Math.min(seconds, shortCodeMaxTtlSeconds);
}

/** POST /shares/{shareId}/links */
export async function createLink(
  caller: Caller,
  network: NetworkView,
  shareId: string,
  body: z.infer<typeof createLinkBody>,
  env: Env,
): Promise<CreatedLinkDto> {
  const wantsCode = body.shortCode !== undefined;
  await assertRemoteLinksEnabled(env, { shortCodes: wantsCode });
  const peppers = requirePeppers(env, wantsCode);
  const share = await requireOwnShare(caller, network, shareId);
  await assertNotRestricted(caller);
  if (share.status !== "active") throw new ApiError(409, "UPLOAD_INCOMPLETE", "Links can be created once the upload has finished");

  const entitlements = resolveEntitlements(caller.principal);
  const linkSeconds =
    body.expiresIn === undefined ? null : allowedOption(entitlements.limits.linkExpiryOptionsSeconds, body.expiresIn, "link expiry");
  const shortCodeSeconds = wantsCode ? codeSeconds(entitlements, body.shortCode?.expiresIn) : null;

  // Executables, scripts, installers and disk images never leave the network on Free (T-035).
  const files = await getDb()
    .selectFrom("app.files")
    .select("risk_flags")
    .where("share_id", "=", share.id)
    .where("upload_status", "=", "verified")
    .execute();
  assertRemoteAllowed(files.map((f) => ({ riskFlags: f.risk_flags })), entitlements);

  await enforceRateLimit("createLink", caller.principal.userId);

  for (let attempt = 1; ; attempt++) {
    const id = newLinkId();
    const secret = newLinkSecret();
    const code = wantsCode ? newShortCode() : null;
    try {
      const row = await getDb().transaction().execute(async (trx) => {
        // FOR SHARE: end_share (FOR UPDATE) waits for this link and then revokes it with the rest.
        const live = await trx
          .selectFrom("app.shares")
          .select([
            sql<boolean>`status = 'active' and expires_at > now()`.as("live"),
            sql<boolean>`${linkSeconds ?? 0} = 0 or now() + make_interval(secs => ${linkSeconds ?? 0}) <= expires_at`.as("fits"),
          ])
          .where("id", "=", share.id)
          .forShare()
          .executeTakeFirstOrThrow();
        if (!live.live) throw notFound();
        // A link never outlives its share (07 §3); "until the share expires" is the default.
        if (!live.fits) {
          throw new ApiError(422, "EXPIRY_NOT_ALLOWED", "A link can't last longer than what it shares", { reason: "after_share_expiry" });
        }
        const expiresAt =
          linkSeconds === null
            ? sql<Date>`(select s.expires_at from app.shares s where s.id = ${share.id}::uuid)`
            : sql<Date>`now() + make_interval(secs => ${linkSeconds})`;
        const codeHmac = code && peppers.code ? shortCodeHmacs([peppers.code], code)[0]!.hmac : null;
        const inserted = await trx
          .insertInto("app.share_links")
          .values({
            id,
            share_id: share.id,
            secret_hmac: linkSecretHmac(peppers.link, id, secret),
            pepper_version: peppers.link.version,
            short_code_hmac: codeHmac,
            short_code_pepper_version: codeHmac ? peppers.code!.version : null,
            short_code_expires_at: codeHmac
              ? sql<Date>`least(now() + make_interval(secs => ${shortCodeSeconds}), ${expiresAt})`
              : null,
            created_by_user_id: caller.principal.userId,
            created_by_device_id: caller.device.id,
            expires_at: expiresAt,
            entitlement_snapshot: JSON.stringify(entitlements),
          })
          .returning(["created_at", "expires_at", "short_code_expires_at"])
          .executeTakeFirstOrThrow();
        await audit(trx, {
          action: "link.created",
          actorUserId: caller.principal.userId,
          actorDeviceId: caller.device.id,
          networkSpaceId: share.networkSpaceId,
          targetType: "link",
          targetId: id,
          metadata: { shareId: share.id, shortCode: code !== null },
        });
        return inserted;
      });
      return {
        id,
        url: shareUrl(env.appOrigin, id, secret),
        createdAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        shortCode: code && row.short_code_expires_at ? { code: formatShortCode(code), expiresAt: row.short_code_expires_at.toISOString() } : null,
      };
    } catch (error) {
      if (isUniqueViolation(error) && attempt < INSERT_ATTEMPTS) continue;
      throw error;
    }
  }
}

/** GET /shares/{shareId}/links: the creator's links for this share. Never their secrets or codes. */
export async function listLinks(caller: Caller, network: NetworkView, shareId: string): Promise<LinkSummaryDto[]> {
  const share = await requireOwnShare(caller, network, shareId);
  await enforceRateLimit("listLinks", caller.device.id);
  const rows = await getDb()
    .selectFrom("app.share_links")
    .select(["id", "created_at", "expires_at", "revoked_at", "short_code_expires_at", "unlock_count", sql<Date>`now()`.as("db_now")])
    .where("share_id", "=", share.id)
    .orderBy("created_at", "desc")
    .limit(MAX_LISTED)
    .execute();
  return rows.map((row) => {
    const now = row.db_now.getTime();
    const state = row.revoked_at ? "revoked" : row.expires_at.getTime() <= now ? "expired" : "active";
    const codeLive = state === "active" && row.short_code_expires_at !== null && row.short_code_expires_at.getTime() > now;
    return {
      id: row.id,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      state,
      shortCodeExpiresAt: codeLive ? row.short_code_expires_at!.toISOString() : null,
      unlockCount: row.unlock_count,
    };
  });
}

/** The link and its share, for creator-only actions: 404 unless visible, 403 for other people (T-011). */
async function requireOwnLink(caller: Caller, network: NetworkView, linkId: string) {
  if (!isLinkId(linkId)) throw notFound();
  const link = await getDb()
    .selectFrom("app.share_links")
    .select(["id", "share_id", "created_by_user_id"])
    .where("id", "=", linkId)
    .executeTakeFirst();
  if (!link) throw notFound();
  const share = await requireOwnShare(caller, network, link.share_id);
  if (link.created_by_user_id !== caller.principal.userId) {
    throw new ApiError(403, "NOT_CREATOR", "Only the person who created this link can change it");
  }
  return { link, share };
}

/** DELETE /links/{linkId}: revoked at once; grants stop working on their next request (T-031). */
export async function revokeLink(caller: Caller, network: NetworkView, linkId: string): Promise<void> {
  const { link, share } = await requireOwnLink(caller, network, linkId);
  await enforceRateLimit("revokeLink", caller.principal.userId);
  await getDb().transaction().execute(async (trx) => {
    const revoked = await trx
      .updateTable("app.share_links")
      .set({
        revoked_at: sql`now()`,
        revoke_reason: "creator",
        revoked_by_user_id: caller.principal.userId,
        short_code_hmac: null,
        short_code_pepper_version: null,
        short_code_expires_at: null,
      })
      .where("id", "=", link.id)
      .where("revoked_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!revoked) return; // already revoked: nothing to do
    await audit(trx, {
      action: "link.revoked",
      actorUserId: caller.principal.userId,
      actorDeviceId: caller.device.id,
      networkSpaceId: share.networkSpaceId,
      targetType: "link",
      targetId: link.id,
      metadata: { shareId: share.id },
    });
  });
}

/** POST /links/{linkId}/code: a new short code replaces the old one, which stops working (03 §4.4). */
export async function regenerateCode(
  caller: Caller,
  network: NetworkView,
  linkId: string,
  body: z.infer<typeof regenerateCodeBody>,
  env: Env,
): Promise<{ code: string; expiresAt: string }> {
  await assertRemoteLinksEnabled(env, { shortCodes: true });
  const peppers = requirePeppers(env, true);
  const { link, share } = await requireOwnLink(caller, network, linkId);
  const seconds = codeSeconds(resolveEntitlements(caller.principal), body.expiresIn);
  await enforceRateLimit("regenerateCode", caller.principal.userId);

  for (let attempt = 1; ; attempt++) {
    const code = newShortCode();
    const { hmac } = shortCodeHmacs([peppers.code!], code)[0]!;
    try {
      const row = await getDb().transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable("app.share_links")
          .set({
            short_code_hmac: hmac,
            short_code_pepper_version: peppers.code!.version,
            short_code_expires_at: sql<Date>`least(now() + make_interval(secs => ${seconds}), expires_at)`,
          })
          .where("id", "=", link.id)
          .where("revoked_at", "is", null)
          .where(sql<boolean>`expires_at > now()`)
          .returning("short_code_expires_at")
          .executeTakeFirst();
        if (!updated?.short_code_expires_at) {
          throw new ApiError(409, "LINK_NOT_ACTIVE", "This link has expired or was revoked");
        }
        await audit(trx, {
          action: "link.code_created",
          actorUserId: caller.principal.userId,
          actorDeviceId: caller.device.id,
          networkSpaceId: share.networkSpaceId,
          targetType: "link",
          targetId: link.id,
        });
        return updated;
      });
      return { code: formatShortCode(code), expiresAt: row.short_code_expires_at!.toISOString() };
    } catch (error) {
      if (isUniqueViolation(error) && attempt < INSERT_ATTEMPTS) continue;
      throw error;
    }
  }
}
