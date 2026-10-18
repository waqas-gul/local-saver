import "server-only";
import { sql } from "kysely";
import type { z } from "zod";
import type { createLinkBody, CreatedLinkDto, createRoomLinkBody, LinkSummaryDto, regenerateCodeBody, updateLinkBody } from "@/lib/shared/api/schemas";
import { formatShortCode } from "@/lib/shared/short-code";
import { audit } from "../audit/log";
import type { Caller } from "../auth/device";
import { IntegrationNotConfiguredError } from "../config/integrations";
import { getDb } from "../db/client";
import { assertFeature, assertNotDeletionPending, assertOption } from "../entitlements/enforce";
import { resolveEntitlements } from "../entitlements/resolve";
import { snapshotFor } from "../entitlements/snapshot";
import type { Entitlements } from "../entitlements/types";
import type { Env } from "../env";
import { assertRemoteLinksEnabled } from "../flags";
import { alreadyDownloaded, ApiError, notFound } from "../http/errors";
import type { NetworkView } from "../network/current";
import { assertNotRestricted } from "../policy/posting";
import { enforceRateLimit } from "../ratelimit/limits";
import { findRoom, requireRoom, type RoomAccess } from "../rooms/access";
import { assertRemoteAllowed } from "../security/file-policy";
import { requireOwnShare, type VisibleShare } from "../shares/read";
import { hashLinkPassword } from "./password";
import { isLinkId, linkSecretHmac, newLinkId, newLinkSecret, newShortCode, shareUrl, shortCodeHmacs } from "./secrets";

/**
 * Share links, creator side (DEC-013, DEC-033, 03 §4.1, §4.4): only a share's creator creates,
 * lists and revokes its links, from any network. A link targets that one share, never a network
 * feed (Q-028). The secret and the code are returned once and stored only as peppered HMACs.
 *
 * Phase 4 (§17.6.4, §17.16): the options are the caller's current plan's, for new links and for new
 * codes on existing links (E13, E14, D4-12); the link stores its own snapshot (E15, E16, E27). A
 * restricted account can't issue new codes (E29); an account in its deletion grace can't create
 * links (E30).
 *
 * Passwords (P4-16, §17.8.3): setting or changing one needs Pro (E11); removing one is always allowed
 * (D4-12), also after a downgrade. The password is hashed after every check and limit, outside the
 * transaction, and only its hash is stored; the database bumps the link's password version, which
 * invalidates every grant (grants.ts). Summaries say whether a link has a password, nothing more.
 *
 * Rooms (P4-17, §17.11.1): a link to a room share is its creator's to make while still in the room, and a member's
 * only while the room allows it (membersCanCreateLinks); the owner always may. After leaving, its creator still
 * lists, revokes and re-codes the links they made (D4-15). Deleting the room ends its shares, so their links.
 *
 * Room links (P4-19, §17.8.5): the room's owner makes read-only links to the whole room (roomLinks, E22; a password
 * needs linkPasswords, E11; D4-17's expiries), lists them, revokes them and sets or removes their password. Anyone
 * else, members included, gets the unknown link's 404 for a room link, as for invites. They have no short code (the
 * database refuses one). A downgraded owner's room links keep working until they expire (their snapshot, D4-16);
 * new ones are refused. Deleting the room revokes them (app.delete_room).
 */

const MAX_LISTED = 50;

/** Phase 4 (P4-17): the room's owner turned off links to its members' shares (membersCanCreateLinks). */
function roomLinksOff(): ApiError {
  return new ApiError(403, "ROOM_LINKS_DISABLED", "The room's owner has turned off links for this room");
}
const INSERT_ATTEMPTS = 3; // a new random ID or code colliding is astronomically unlikely, but handled

function requirePeppers(env: Env, codes: boolean) {
  if (env.linkPeppers.length === 0) throw new IntegrationNotConfiguredError("Share links", ["LINK_PEPPER"]);
  if (codes && env.codePeppers.length === 0) throw new IntegrationNotConfiguredError("Short codes", ["CODE_PEPPER"]);
  return { link: env.linkPeppers[0]!, code: env.codePeppers[0] };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

/** The code expiry: an allowed option (≤ 24 h on Free, ≤ 7 days on Pro), never past the link. */
function codeSeconds(entitlements: Entitlements, expiresIn: number | undefined): number {
  const { shortCodeDefaultExpirySeconds, shortCodeMaxTtlSeconds } = entitlements.limits;
  const seconds = assertOption(entitlements, "shortCodeExpiryOptionsSeconds", expiresIn ?? shortCodeDefaultExpirySeconds);
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
  const share = await requireOwnShare(caller, network, shareId, { roomWrite: true });
  // A room share leaves the room by link only if its owner allows it, or the owner posted it (§17.11.1, 03 §9).
  if (share.room && share.room.role !== "owner" && !share.room.membersCanCreateLinks) throw roomLinksOff();
  await assertNotRestricted(caller);
  // A claimed burn share is already gone for everyone else (phase 3 §17.8).
  if (share.status === "claimed") throw alreadyDownloaded(false);
  if (share.status !== "active") throw new ApiError(409, "UPLOAD_INCOMPLETE", "Links can be created once the upload has finished");

  const entitlements = await resolveEntitlements(caller.principal);
  assertNotDeletionPending(entitlements);
  if (body.password !== undefined) assertFeature(entitlements, "linkPasswords", PASSWORDS_NOT_IN_PLAN);
  const linkSeconds = body.expiresIn === undefined ? null : assertOption(entitlements, "linkExpiryOptionsSeconds", body.expiresIn);
  const shortCodeSeconds = wantsCode ? codeSeconds(entitlements, body.shortCode?.expiresIn) : null;

  // Executables, scripts, installers and disk images never leave the network on Free (T-035).
  const files = await getDb()
    .selectFrom("app.files")
    .select("risk_flags")
    .where("share_id", "=", share.id)
    .where("upload_status", "=", "verified")
    .execute();
  assertRemoteAllowed(files.map((f) => ({ riskFlags: f.risk_flags })), entitlements);

  await enforceRateLimit("createLink", caller.principal.userId, entitlements.limits.rateLimits.createLink);
  const passwordHash = body.password === undefined ? null : await hashLinkPassword(body.password);

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
            // "Until the share expires": the link moves when the share is extended (P4-15, D4-13).
            follows_share_expiry: linkSeconds === null,
            password_hash: passwordHash,
            entitlement_snapshot: JSON.stringify(snapshotFor(entitlements)),
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
          metadata: { shareId: share.id, shortCode: code !== null, password: passwordHash !== null },
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

const PASSWORDS_NOT_IN_PLAN = "Passwords on links aren't available on your plan";

/** What a summary shows of a link: its state and times, and whether it has a password (never the hash). */
const SUMMARY_COLUMNS = [
  "id",
  "created_at",
  "expires_at",
  "revoked_at",
  "short_code_expires_at",
  "unlock_count",
  "follows_share_expiry",
  sql<boolean>`password_hash is not null`.as("has_password"),
  sql<Date>`now()`.as("db_now"),
] as const;

type SummaryRow = {
  id: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  short_code_expires_at: Date | null;
  unlock_count: number;
  follows_share_expiry: boolean;
  has_password: boolean;
  db_now: Date;
};

function summaryOf(row: SummaryRow): LinkSummaryDto {
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
    followsShareExpiry: row.follows_share_expiry,
    hasPassword: row.has_password,
  };
}

/** GET /shares/{shareId}/links: the creator's links for this share. Never their secrets or codes. */
export async function listLinks(caller: Caller, network: NetworkView, shareId: string): Promise<LinkSummaryDto[]> {
  const share = await requireOwnShare(caller, network, shareId);
  await enforceRateLimit("listLinks", caller.device.id);
  const rows = await getDb()
    .selectFrom("app.share_links")
    .select(SUMMARY_COLUMNS)
    .where("share_id", "=", share.id)
    .orderBy("created_at", "desc")
    .limit(MAX_LISTED)
    .execute();
  return rows.map(summaryOf);
}

type OwnLink =
  | { link: { id: string; created_by_user_id: string | null }; share: VisibleShare; room: null }
  | { link: { id: string; created_by_user_id: string | null }; share: null; room: RoomAccess };

/**
 * The link and its target, for creator-only actions. A share link: 404 unless its share is visible, 403 for other
 * people (T-011). A room link (P4-19): its room's owner only, who made it (rooms have no transfer, D4-18); anyone
 * else, members included, gets 404, as for a link that doesn't exist.
 */
async function requireOwnLink(caller: Caller, network: NetworkView, linkId: string): Promise<OwnLink> {
  if (!isLinkId(linkId)) throw notFound();
  const link = await getDb()
    .selectFrom("app.share_links")
    .select(["id", "target_type", "share_id", "room_id", "created_by_user_id"])
    .where("id", "=", linkId)
    .executeTakeFirst();
  if (!link) throw notFound();
  if (link.target_type === "room") {
    const room = link.room_id ? await findRoom(caller.principal.userId, link.room_id) : null;
    if (!room || room.role !== "owner" || link.created_by_user_id !== caller.principal.userId) throw notFound();
    return { link, share: null, room };
  }
  const share = await requireOwnShare(caller, network, link.share_id!);
  if (link.created_by_user_id !== caller.principal.userId) {
    throw new ApiError(403, "NOT_CREATOR", "Only the person who created this link can change it");
  }
  return { link, share, room: null };
}

/** Audit context for a link action: the share's network, or the room (P4-19). */
function linkTarget(own: OwnLink): { networkSpaceId: string | null; metadata: { shareId: string } | { roomId: string } } {
  return own.share ? { networkSpaceId: own.share.networkSpaceId, metadata: { shareId: own.share.id } } : { networkSpaceId: null, metadata: { roomId: own.room.id } };
}

/** DELETE /links/{linkId}: revoked at once; grants stop working on their next request (T-031). */
export async function revokeLink(caller: Caller, network: NetworkView, linkId: string): Promise<void> {
  const own = await requireOwnLink(caller, network, linkId);
  const { link } = own;
  const target = linkTarget(own);
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
      networkSpaceId: target.networkSpaceId,
      targetType: "link",
      targetId: link.id,
      metadata: target.metadata,
    });
  });
}

/**
 * PATCH /links/{linkId} { password } (P4-16): set, change or remove (null) the link's password. Only the
 * link's creator. Setting or changing: remote links on, not restricted or in deletion grace, Pro (E11), the
 * link still active (409 LINK_NOT_ACTIVE). Removing: always (D4-12); removing an absent password changes
 * nothing. Every change invalidates the link's grants (the version, bumped by the database).
 */
export async function updateLink(
  caller: Caller,
  network: NetworkView,
  linkId: string,
  body: z.infer<typeof updateLinkBody>,
  env: Env,
): Promise<LinkSummaryDto> {
  const own = await requireOwnLink(caller, network, linkId);
  const { link } = own;
  const target = linkTarget(own);
  const password = body.password;
  if (password !== null) {
    await assertRemoteLinksEnabled(env);
    await assertNotRestricted(caller);
    const entitlements = await resolveEntitlements(caller.principal);
    assertNotDeletionPending(entitlements);
    assertFeature(entitlements, "linkPasswords", PASSWORDS_NOT_IN_PLAN);
  }
  await enforceRateLimit("updateLink", caller.principal.userId);
  const passwordHash = password === null ? null : await hashLinkPassword(password);

  return getDb().transaction().execute(async (trx) => {
    // A share link lives while its share does; a room link (P4-19) while its room is open. Only the link row is locked.
    const before = await trx
      .selectFrom("app.share_links as l")
      .leftJoin("app.shares as s", "s.id", "l.share_id")
      .leftJoin("app.rooms as r", "r.id", "l.room_id")
      .select([
        sql<boolean>`l.revoked_at is null and l.expires_at > now()
                     and case when l.target_type = 'room' then r.deleted_at is null else s.status = 'active' and s.expires_at > now() end`.as("live"),
        sql<boolean>`l.password_hash is not null`.as("has_password"),
      ])
      .where("l.id", "=", link.id)
      .forUpdate("l")
      .executeTakeFirstOrThrow();
    if (passwordHash !== null && !before.live) throw new ApiError(409, "LINK_NOT_ACTIVE", "This link has expired or was revoked");
    if (passwordHash !== null || before.has_password) {
      await trx.updateTable("app.share_links").set({ password_hash: passwordHash }).where("id", "=", link.id).execute();
      await audit(trx, {
        action: passwordHash === null ? "link.password_removed" : "link.password_set",
        actorUserId: caller.principal.userId,
        actorDeviceId: caller.device.id,
        networkSpaceId: target.networkSpaceId,
        targetType: "link",
        targetId: link.id,
        metadata: passwordHash === null ? target.metadata : { ...target.metadata, changed: before.has_password },
      });
    }
    return summaryOf(await trx.selectFrom("app.share_links").select(SUMMARY_COLUMNS).where("id", "=", link.id).executeTakeFirstOrThrow());
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
  const own = await requireOwnLink(caller, network, linkId);
  // Room links (P4-19) take no short code: a code would open a whole room (DV4-108). The route doesn't exist for them.
  if (!own.share) throw notFound();
  const { link, share } = own;
  await assertNotRestricted(caller);
  const seconds = codeSeconds(await resolveEntitlements(caller.principal), body.expiresIn);
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

// ------------------------------------------------------------------ room links (P4-19)

/**
 * POST /rooms/{roomId}/links: a read-only link to the whole room (§17.8.5). The owner only (members 403 NOT_OWNER,
 * everyone else the room's 404); not restricted (E29) or in deletion grace (E30); Pro (roomLinks, E22); one of the
 * plan's room-link expiries (D4-17); a password needs linkPasswords (E11). The link stores the owner's snapshot (its
 * daily URL cap, preview size and remote file policy, E15, E16, E27). The URL with its secret is returned once.
 */
export async function createRoomLink(caller: Caller, roomId: string, body: z.infer<typeof createRoomLinkBody>, env: Env): Promise<CreatedLinkDto> {
  await assertRemoteLinksEnabled(env);
  const peppers = requirePeppers(env, false);
  const room = await requireRoom(caller, roomId, { owner: true });
  await assertNotRestricted(caller);
  const entitlements = await resolveEntitlements(caller.principal);
  assertNotDeletionPending(entitlements);
  assertFeature(entitlements, "roomLinks", "Room links aren't available on your plan");
  if (body.password !== undefined) assertFeature(entitlements, "linkPasswords", PASSWORDS_NOT_IN_PLAN);
  const seconds = assertOption(entitlements, "roomLinkExpiryOptionsSeconds", body.expiresIn);
  await enforceRateLimit("createRoomLink", caller.principal.userId, entitlements.limits.rateLimits.createLink);
  const passwordHash = body.password === undefined ? null : await hashLinkPassword(body.password);

  for (let attempt = 1; ; attempt++) {
    const id = newLinkId();
    const secret = newLinkSecret();
    try {
      const row = await getDb().transaction().execute(async (trx) => {
        // FOR KEY SHARE: a deletion in progress (room FOR UPDATE) finishes first, and then this sees it; one that
        // starts after waits for this link and revokes it with the rest (app.delete_room).
        const open = await trx.selectFrom("app.rooms").select("id").where("id", "=", room.id).where("deleted_at", "is", null).forKeyShare().executeTakeFirst();
        if (!open) throw notFound();
        const inserted = await trx
          .insertInto("app.share_links")
          .values({
            id,
            target_type: "room",
            room_id: room.id,
            secret_hmac: linkSecretHmac(peppers.link, id, secret),
            pepper_version: peppers.link.version,
            created_by_user_id: caller.principal.userId,
            created_by_device_id: caller.device.id,
            expires_at: sql<Date>`now() + make_interval(secs => ${seconds})`,
            password_hash: passwordHash,
            entitlement_snapshot: JSON.stringify(snapshotFor(entitlements)),
          })
          .returning(["created_at", "expires_at"])
          .executeTakeFirstOrThrow();
        await audit(trx, {
          action: "link.created",
          actorUserId: caller.principal.userId,
          actorDeviceId: caller.device.id,
          networkSpaceId: null,
          targetType: "link",
          targetId: id,
          metadata: { roomId: room.id, password: passwordHash !== null },
        });
        return inserted;
      });
      return { id, url: shareUrl(env.appOrigin, id, secret), createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), shortCode: null };
    } catch (error) {
      if (isUniqueViolation(error) && attempt < INSERT_ATTEMPTS) continue;
      throw error;
    }
  }
}

/** GET /rooms/{roomId}/links: the owner's room links, newest first; never a secret or URL. */
export async function listRoomLinks(caller: Caller, roomId: string): Promise<LinkSummaryDto[]> {
  const room = await requireRoom(caller, roomId, { owner: true });
  await enforceRateLimit("listRoomLinks", caller.device.id);
  const rows = await getDb()
    .selectFrom("app.share_links")
    .select(SUMMARY_COLUMNS)
    .where("room_id", "=", room.id)
    .where("target_type", "=", "room")
    .orderBy("created_at", "desc")
    .limit(MAX_LISTED)
    .execute();
  return rows.map(summaryOf);
}
