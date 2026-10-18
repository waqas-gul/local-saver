import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import type { z } from "zod";
import type { createInviteBody, InviteKind, InvitePreviewResponse, InviteSummaryDto, RoomDto } from "@/lib/shared/api/schemas";
import { INVITE_LINK_EXPIRY_OPTIONS_SECONDS, PAIRING_INVITE_MAX_SECONDS } from "@/lib/shared/plans";
import { audit } from "../audit/log";
import type { Caller } from "../auth/device";
import { IntegrationNotConfiguredError } from "../config/integrations";
import { getDb } from "../db/client";
import { assertFeature, assertNotDeletionPending } from "../entitlements/enforce";
import { resolveEntitlements } from "../entitlements/resolve";
import type { Env, VersionedSecret } from "../env";
import { ApiError, inviteExpired, inviteUnavailable, notFound } from "../http/errors";
import { requesterKey } from "../network/requester";
import { assertNotRestricted } from "../policy/posting";
import { enforceRateLimit } from "../ratelimit/limits";
import { hmacSha256, randomToken } from "../security/crypto";
import { randomId } from "../security/ids";
import { requireRoom } from "./access";
import { getRoom } from "./rooms";

/**
 * Invites to a private room (phase 4 §17.8.4.1; T-034). Two kinds: invite links (P4-17; ≤ 7 days, optionally a number
 * of uses) and QR pairing codes (P4-18; one use, 10 minutes, shown as a QR code on the owner's screen). Both are the
 * same row, URL, secret and accept path; only how they are made, and how long and how often they work, differ.
 *
 * URL: https://{domain}/j/{inviteId}#k={secret}. The ID (96 bits) may appear in logs; the secret (256 bits) lives only
 * in the fragment, which browsers never send, and is stored only as HMAC-SHA256 under the versioned link pepper,
 * domain-separated and bound to the invite ("invite|{id}|{secret}"), as merge intents are (no new secret to
 * provision). It is returned once, at creation.
 *
 * Preview and accept prove the secret first, timing-safely, with a dummy comparison for unknown IDs: an unknown
 * invite, a wrong secret and a malformed one all answer the same 404 INVITE_UNAVAILABLE, so invites can't be
 * enumerated. Only then may the caller learn its state: 410 INVITE_EXPIRED (expired, used up, revoked, its room
 * deleted). app.accept_room_invite re-checks everything under the room and invite locks: a single-use invite joins
 * one person, and the member cap holds under concurrent accepts (E19). The invite names its own room: no room ID is
 * taken from the caller, so an invite for room A can only ever join room A.
 */

const INVITE_ID = /^[A-Za-z0-9_-]{16}$/;
const DUMMY_HMAC = randomBytes(32);

function isInviteId(value: string): boolean {
  return INVITE_ID.test(value);
}

function inviteSecretHmac(pepper: VersionedSecret, inviteId: string, secret: string): Buffer {
  return hmacSha256(pepper.secret, `invite|${inviteId}|${secret}`);
}

/** Under each configured pepper, current first (an invite lives ≤ 7 days across a rotation). */
function inviteSecretHmacs(peppers: VersionedSecret[], inviteId: string, secret: string): Buffer[] {
  return peppers.map((pepper) => inviteSecretHmac(pepper, inviteId, secret));
}

/** Always computed and compared, so an unknown invite and a wrong secret take the same path. */
function verifyInviteSecret(
  peppers: VersionedSecret[],
  stored: { secret_hmac: Buffer; pepper_version: number } | undefined,
  inviteId: string,
  secret: string,
): boolean {
  const pepper = stored ? peppers.find((p) => p.version === stored.pepper_version) : undefined;
  const computed = inviteSecretHmac(pepper ?? peppers[0] ?? { version: 0, secret: "unconfigured" }, inviteId, secret);
  const expected = stored && pepper && stored.secret_hmac.length === 32 ? stored.secret_hmac : DUMMY_HMAC;
  return timingSafeEqual(computed, expected) && stored !== undefined && pepper !== undefined;
}

function invitePeppers(env: Env): VersionedSecret[] {
  if (env.linkPeppers.length === 0) throw new IntegrationNotConfiguredError("Room invites", ["LINK_PEPPER"]);
  return env.linkPeppers;
}

export function inviteUrl(appOrigin: string, inviteId: string, secret: string): string {
  return `${appOrigin}/j/${inviteId}#k=${secret}`;
}

/**
 * POST /rooms/{roomId}/invites (the owner; members get 403 NOT_OWNER, everyone else the room's 404).
 * - invite_link (E21): multiUseInvites on the current plan, so a downgraded owner can't make new ones (D4-16). One of
 *   1 hour, 24 hours or 7 days, never past the plan's maximum; optionally a number of uses.
 * - pairing (E20, P4-18): one use, for the plan's pairingInviteSeconds (10 minutes). No plan feature: a downgraded owner
 *   may still pair people into the room they made (D4-16), up to the room's own member cap. Its own rate limit.
 * Both are refused for accounts being deleted (E30) and restricted accounts (E29).
 */
export async function createInvite(caller: Caller, roomId: string, body: z.infer<typeof createInviteBody>, env: Env) {
  const room = await requireRoom(caller, roomId, { owner: true });
  const [pepper] = invitePeppers(env);
  const entitlements = await resolveEntitlements(caller.principal);
  let expiresIn: number;
  let maxUses: number | null;
  if (body.kind === "pairing") {
    assertNotDeletionPending(entitlements);
    await assertNotRestricted(caller);
    expiresIn = Math.min(entitlements.limits.pairingInviteSeconds, PAIRING_INVITE_MAX_SECONDS);
    maxUses = 1;
    await enforceRateLimit("createPairing", caller.principal.userId);
  } else {
    assertFeature(entitlements, "multiUseInvites", "Invite links are not in your plan");
    assertNotDeletionPending(entitlements);
    await assertNotRestricted(caller);
    const allowed = INVITE_LINK_EXPIRY_OPTIONS_SECONDS.filter((seconds) => seconds <= entitlements.limits.inviteLinkMaxSeconds);
    if (!allowed.includes(body.expiresIn)) throw new ApiError(422, "EXPIRY_NOT_ALLOWED", "This invite expiry is not available", { allowed });
    expiresIn = body.expiresIn;
    maxUses = body.maxUses ?? null;
    await enforceRateLimit("createInvite", caller.principal.userId);
  }

  const inviteId = randomId(12);
  const secret = randomToken(32);
  const created = await getDb()
    .transaction()
    .execute(async (trx) => {
      // The room must still be open: a deletion in progress (room FOR UPDATE) finishes first.
      const open = await trx.selectFrom("app.rooms").select("id").where("id", "=", room.id).where("deleted_at", "is", null).forKeyShare().executeTakeFirst();
      if (!open) throw notFound();
      const row = await trx
        .insertInto("app.room_invites")
        .values({
          id: inviteId,
          room_id: room.id,
          kind: body.kind,
          secret_hmac: inviteSecretHmac(pepper!, inviteId, secret),
          pepper_version: pepper!.version,
          created_by_user_id: caller.principal.userId,
          expires_at: sql<Date>`now() + make_interval(secs => ${expiresIn})`,
          max_uses: maxUses,
        })
        .returning(["expires_at", "max_uses"])
        .executeTakeFirstOrThrow();
      await audit(trx, {
        action: "invite.created",
        actorUserId: caller.principal.userId,
        actorDeviceId: caller.device.id,
        networkSpaceId: null,
        targetType: "invite",
        targetId: inviteId,
        metadata: { roomId: room.id, kind: body.kind, expiresIn, maxUses },
      });
      return row;
    });
  return {
    inviteId,
    kind: body.kind,
    url: inviteUrl(env.appOrigin, inviteId, secret),
    expiresAt: new Date(created.expires_at).toISOString(),
    maxUses: created.max_uses,
  };
}

/**
 * GET /rooms/{roomId}/invites (the owner): the open invites, links and pairing codes, never their secrets or URLs. A
 * pairing code leaves the list once used, revoked or expired: the owner's QR dialog learns from that that it was used.
 */
export async function listInvites(caller: Caller, roomId: string): Promise<InviteSummaryDto[]> {
  const room = await requireRoom(caller, roomId, { owner: true });
  const rows = await getDb()
    .selectFrom("app.room_invites")
    .select(["id", "kind", "created_at", "expires_at", "use_count", "max_uses"])
    .where("room_id", "=", room.id)
    .where("revoked_at", "is", null)
    .where(sql<boolean>`expires_at > now() and (max_uses is null or use_count < max_uses)`)
    .orderBy("created_at", "desc")
    .limit(50)
    .execute();
  return rows.map((row) => ({
    inviteId: row.id,
    kind: row.kind as InviteKind,
    createdAt: row.created_at.toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    useCount: row.use_count,
    maxUses: row.max_uses,
  }));
}

/**
 * DELETE /invites/{inviteId}: the owner of the invite's room, found through the caller's ownership. Anyone else,
 * members included, gets 404, as for an invite that doesn't exist. Revoking twice is fine.
 */
export async function revokeInvite(caller: Caller, inviteId: string): Promise<void> {
  await enforceRateLimit("revokeInvite", caller.principal.userId);
  if (!isInviteId(inviteId)) throw notFound();
  const db = getDb();
  const invite = await db
    .selectFrom("app.room_invites as i")
    .innerJoin("app.rooms as r", "r.id", "i.room_id")
    .innerJoin("app.room_members as m", (join) => join.onRef("m.room_id", "=", "i.room_id").on("m.user_id", "=", caller.principal.userId))
    .select(["i.id", "i.room_id", "i.revoked_at"])
    .where("i.id", "=", inviteId)
    .where("m.role", "=", "owner")
    .where("m.removed_at", "is", null)
    .where("r.deleted_at", "is", null)
    .executeTakeFirst();
  if (!invite) throw notFound();
  if (invite.revoked_at) return;
  await db.transaction().execute(async (trx) => {
    const revoked = await trx
      .updateTable("app.room_invites")
      .set({ revoked_at: sql`now()` })
      .where("id", "=", invite.id)
      .where("revoked_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!revoked) return;
    await audit(trx, {
      action: "invite.revoked",
      actorUserId: caller.principal.userId,
      actorDeviceId: caller.device.id,
      networkSpaceId: null,
      targetType: "invite",
      targetId: invite.id,
      metadata: { roomId: invite.room_id },
    });
  });
}

/** Per invite and per network key, before any lookup: the same limits for every outcome (03 §10). */
async function limitInviteAttempt(kind: "preview" | "accept", inviteId: string, request: Request, env: Env): Promise<void> {
  if (!isInviteId(inviteId)) throw inviteUnavailable();
  await enforceRateLimit(kind === "preview" ? "invitePreview" : "inviteAccept", inviteId);
  await enforceRateLimit(kind === "preview" ? "invitePreviewNetwork" : "inviteAcceptNetwork", requesterKey(request, env));
}

/**
 * POST /invites/{inviteId}/preview { secret }: the room's name and size before joining, only after the secret is
 * proven (D4-15). Nothing about who is in it.
 */
export async function previewInvite(caller: Caller, inviteId: string, secret: string, request: Request, env: Env): Promise<InvitePreviewResponse> {
  const peppers = invitePeppers(env);
  await limitInviteAttempt("preview", inviteId, request, env);
  const row = await getDb()
    .selectFrom("app.room_invites as i")
    .innerJoin("app.rooms as r", "r.id", "i.room_id")
    .select([
      "i.room_id", "i.kind", "i.secret_hmac", "i.pepper_version", "i.expires_at", "r.label",
      sql<boolean>`i.revoked_at is null and i.expires_at > now() and (i.max_uses is null or i.use_count < i.max_uses) and r.deleted_at is null`.as("open"),
    ])
    .where("i.id", "=", inviteId)
    .executeTakeFirst();
  if (!verifyInviteSecret(peppers, row, inviteId, secret) || !row) throw inviteUnavailable();
  if (!row.open) throw inviteExpired();
  const count = await getDb()
    .selectFrom("app.room_members")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("room_id", "=", row.room_id)
    .where("removed_at", "is", null)
    .executeTakeFirstOrThrow();
  return { roomLabel: row.label, memberCount: count.n, kind: row.kind as InviteKind, expiresAt: new Date(row.expires_at).toISOString() };
}

/**
 * POST /invites/{inviteId}/accept { secret } (any signed-in browser, anonymous included, D4-19). Joins the invite's
 * room, or rejoins it after a removal; an active member gets the room again without using the invite (idempotent).
 */
export async function acceptInvite(caller: Caller, inviteId: string, secret: string, request: Request, env: Env): Promise<RoomDto> {
  const peppers = invitePeppers(env);
  await limitInviteAttempt("accept", inviteId, request, env);
  const db = getDb();
  const stored = await db.selectFrom("app.room_invites").select(["kind", "secret_hmac", "pepper_version"]).where("id", "=", inviteId).executeTakeFirst();
  if (!verifyInviteSecret(peppers, stored, inviteId, secret) || !stored) throw inviteUnavailable();
  const via = stored.kind as InviteKind;

  const roomId = await db.transaction().execute(async (trx) => {
    const { rows } = await sql<{ outcome: string; room_id: string | null }>`
      select outcome, room_id
        from app.accept_room_invite(${inviteId}, ${inviteSecretHmacs(peppers, inviteId, secret)}::bytea[],
                                    ${caller.principal.userId}::uuid, ${caller.device.id}::uuid)
    `.execute(trx);
    const row = rows[0];
    switch (row?.outcome) {
      case "joined":
      case "already_member":
        break;
      case "expired":
        throw inviteExpired();
      case "member_limit":
        throw new ApiError(409, "ROOM_MEMBER_LIMIT", "This room is full");
      default:
        throw inviteUnavailable();
    }
    if (row.outcome === "joined") {
      for (const action of ["member.joined", "invite.accepted"] as const) {
        await audit(trx, {
          action,
          actorUserId: caller.principal.userId,
          actorDeviceId: caller.device.id,
          networkSpaceId: null,
          targetType: action === "member.joined" ? "room" : "invite",
          targetId: action === "member.joined" ? (row.room_id as string) : inviteId,
          metadata: action === "member.joined" ? { via, inviteId } : { roomId: row.room_id as string },
        });
      }
    }
    return row.room_id as string;
  });
  return getRoom(caller, roomId);
}
