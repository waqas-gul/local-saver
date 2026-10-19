import "server-only";
import { sql, type Transaction } from "kysely";
import { getDb } from "../db/client";
import type { DB } from "../db/types.gen";
import type { Env } from "../env";
import { assertRemoteLinksEnabled } from "../flags";
import { alreadyDownloaded, linkExpired, linkUnavailable, notFound, passwordRequired } from "../http/errors";
import { isUuid } from "../shares/read";
import { hashSessionToken, readLinkSessionToken } from "./cookies";
import { isLinkId } from "./secrets";

/**
 * Link grants (03 §4.2, 04 §7.5): what a viewer session may open. One grant per (session,
 * link), at most 12 hours and never past the link or the share. Every viewer request goes
 * through requireViewerAccess, which re-checks the grant, the link and the share each time, so
 * a revoked or expired link, or an ended share, stops working on the next request (T-031).
 *
 * Burn after download (Phase 3, phase 3 §17.8.4): a viewer session can claim a burn share. Its
 * state is checked before the link's: consuming a share revokes its links, and the claimant
 * should still learn "you have it" rather than "link expired". While the share is claimed, only
 * the claimant session gets through (and only while its grace, grant and link last); everyone
 * else who holds a grant gets 410 ALREADY_DOWNLOADED.
 *
 * Password links (Phase 4, P4-16, C4-8): a grant records the link's password version when it is made,
 * unverified. It opens the link only while that version is still the link's (every set, change or removal
 * bumps it, so they invalidate every grant) and, on a password link, once this grant has proved the
 * password (password.ts). The check is here, in accessFor, so it holds on every viewer route whether the
 * grant came from the secret or from a code. Link state is revealed first, as before: an ended link gets
 * 410 whatever the password.
 *
 * Room links (Phase 4, P4-19, §17.8.5): a link may target a private room instead of one share. Its grant opens the
 * room's current and future active shares while the link lasts and the room is open (410 once revoked, expired or
 * the room is deleted); each share a request names is then checked against the room (roomShareAccess): it must be
 * one of that room's shares, live, and not claimed by someone else. A grant never reaches beyond its own link.
 */

export const GRANT_MAX_SECONDS = 12 * 60 * 60;

/**
 * A new or refreshed grant: always unverified, at the link's current password version. A new unlock or code
 * restarts the proof, so a password proof lasts at most one grant (12 hours); the database refuses a
 * refresh that keeps an older proof (link_grants_password_verified).
 */
export async function grantAccess(trx: Transaction<DB>, sessionHash: Buffer, linkId: string, via: "secret" | "code"): Promise<void> {
  // A room link has no share: its grant lasts as long as the link (≤ 12 h).
  const { numAffectedRows } = await sql`
    insert into app.link_grants (session_id_hash, link_id, granted_via, granted_at, expires_at, password_version, password_verified_at)
    select ${sessionHash}, l.id, ${via}, now(),
           least(now() + make_interval(secs => ${GRANT_MAX_SECONDS}), l.expires_at, coalesce(s.expires_at, l.expires_at)),
           l.password_version, null
      from app.share_links l
      left join app.shares s on s.id = l.share_id
     where l.id = ${linkId}
    on conflict (session_id_hash, link_id) do update
       set granted_via = excluded.granted_via, granted_at = excluded.granted_at, expires_at = excluded.expires_at,
           password_version = excluded.password_version, password_verified_at = null
  `.execute(trx);
  // A grant that silently wasn't made would only surface later as "link unavailable": fail here instead.
  if (Number(numAffectedRows ?? 0) < 1) throw new Error("link grant was not created");
}

/** What every viewer request knows about the link and the grant (both targets). */
type LinkAccessBase = {
  linkId: string;
  sessionHash: Buffer;
  linkExpiresAt: Date;
  grantExpiresAt: Date;
  /** The link's entitlement snapshot (limits applied when it was created, 07 §2.3). */
  entitlementSnapshot: unknown;
};

/** A share link's grant, or (P4-19) one share of a room link's room, checked for this session. */
export type ShareViewerAccess = LinkAccessBase & {
  target: "share";
  shareId: string;
  kind: "files" | "text";
  /** The share's network, kept only for download logs and abuse reports; never sent to viewers. */
  networkSpaceId: string | null;
  /** P4-19: the room, when the share was reached through a room link (download logs); null for share links. */
  roomId: string | null;
  shareExpiresAt: Date;
  /** Phase 3: "active" or, for its claimant, "claimed". */
  status: "active" | "claimed";
  burnAfterDownload: boolean;
  /** This session claimed the (burn) share. */
  isClaimant: boolean;
  claimGraceUntil: Date | null;
};

/** P4-19: a room link's grant: the room, whose shares each request then checks (roomShareAccess). */
export type RoomViewerAccess = LinkAccessBase & { target: "room"; roomId: string };

export type ViewerAccess = ShareViewerAccess | RoomViewerAccess;

type AccessRow = {
  link_id: string;
  target_type: "share" | "room";
  share_id: string | null;
  room_id: string | null;
  link_expires_at: Date;
  revoked_at: Date | null;
  entitlement_snapshot: unknown;
  kind: "files" | "text" | null;
  status: string | null;
  share_expires_at: Date | null;
  network_space_id: string | null;
  room_open: boolean;
  grant_expires_at: Date;
  burn_after_download: boolean | null;
  claimed_link_session_hash: Buffer | null;
  claim_grace_until: Date | null;
  has_password: boolean;
  password_version: number;
  grant_password_version: number;
  password_verified: boolean;
  db_now: Date;
};

/**
 * The grant a session hash holds for a link, checked against the link and its target right now: 404 without a
 * live grant, 410 once the link or share has ended (or the burn share went to someone else), or, for a room link,
 * once the link has ended or the room was deleted. The password isn't checked here; accessFor and the password
 * route (password.ts) do that.
 */
async function openGrant(sessionHash: Buffer, linkId: string): Promise<{ row: AccessRow; isClaimant: boolean }> {
  const { rows } = await sql<AccessRow>`
    select l.id as link_id, l.target_type, l.share_id, l.room_id, l.expires_at as link_expires_at, l.revoked_at, l.entitlement_snapshot,
           s.kind, s.status, s.expires_at as share_expires_at, s.network_space_id,
           s.burn_after_download, s.claimed_link_session_hash, s.claim_grace_until,
           coalesce(r.deleted_at is null, false) as room_open,
           g.expires_at as grant_expires_at,
           l.password_hash is not null as has_password, l.password_version,
           g.password_version as grant_password_version, g.password_verified_at is not null as password_verified,
           now() as db_now
      from app.link_grants g
      join app.link_sessions ss on ss.id_hash = g.session_id_hash
      join app.share_links l on l.id = g.link_id
      left join app.shares s on s.id = l.share_id
      left join app.rooms r on r.id = l.room_id
     where g.session_id_hash = ${sessionHash} and g.link_id = ${linkId} and ss.expires_at > now()
  `.execute(getDb());
  const row = rows[0];
  if (!row) throw linkUnavailable();
  const now = row.db_now.getTime();
  if (row.target_type === "room") {
    // This session proved the secret (or code) before, so it may learn that the link has ended.
    if (row.revoked_at || row.link_expires_at.getTime() <= now || !row.room_open) throw linkExpired();
    if (row.grant_expires_at.getTime() <= now) throw linkUnavailable();
    return { row, isClaimant: false };
  }
  const shareExpiresAt = row.share_expires_at!.getTime();
  const isClaimant = row.claimed_link_session_hash !== null && row.claimed_link_session_hash.equals(sessionHash);
  if (row.burn_after_download && (row.status === "claimed" || row.status === "consumed") && shareExpiresAt > now) {
    const inGrace = row.status === "claimed" && row.claim_grace_until !== null && row.claim_grace_until.getTime() > now;
    if (!isClaimant || !inGrace) throw alreadyDownloaded(isClaimant);
  }
  // This session proved the secret (or code) before, so it may learn that the link has ended.
  const open = row.status === "active" || (row.status === "claimed" && isClaimant);
  if (row.revoked_at || row.link_expires_at.getTime() <= now || !open || shareExpiresAt <= now) {
    throw linkExpired();
  }
  // The link still works, but this browser's 12 hours are up: it needs the link again.
  if (row.grant_expires_at.getTime() <= now) throw linkUnavailable();
  return { row, isClaimant };
}

/** What the password route needs to know about a session's live grant (404 / 410 as for any viewer request). */
export type OpenGrant = { linkId: string; sessionHash: Buffer; hasPassword: boolean; current: boolean };

export async function requireOpenGrant(request: Request, env: Env, linkId: string): Promise<OpenGrant> {
  await assertRemoteLinksEnabled(env);
  const token = readLinkSessionToken(request, env);
  if (!token || !isLinkId(linkId)) throw linkUnavailable();
  const sessionHash = hashSessionToken(token);
  const { row } = await openGrant(sessionHash, linkId);
  return { linkId: row.link_id, sessionHash, hasPassword: row.has_password, current: row.grant_password_version === row.password_version };
}

/** The access a session hash holds for a link, checked against the link and its target right now. */
export async function accessFor(sessionHash: Buffer, linkId: string): Promise<ViewerAccess> {
  const { row, isClaimant } = await openGrant(sessionHash, linkId);
  // Phase 4 (C4-8): made before the password was last set, changed or removed, the grant opens nothing. A
  // password link asks for the (new) password; a link whose password was removed needs the link again.
  if (row.grant_password_version !== row.password_version) {
    throw row.has_password ? passwordRequired(row.link_id) : linkUnavailable();
  }
  if (row.has_password && !row.password_verified) throw passwordRequired(row.link_id);
  const base = {
    linkId: row.link_id,
    sessionHash,
    linkExpiresAt: row.link_expires_at,
    grantExpiresAt: row.grant_expires_at,
    entitlementSnapshot: row.entitlement_snapshot,
  };
  if (row.target_type === "room") return { ...base, target: "room", roomId: row.room_id! };
  return {
    ...base,
    target: "share",
    shareId: row.share_id!,
    kind: row.kind!,
    networkSpaceId: row.network_space_id,
    roomId: null,
    shareExpiresAt: row.share_expires_at!,
    status: row.status as "active" | "claimed",
    burnAfterDownload: row.burn_after_download!,
    isClaimant,
    claimGraceUntil: row.claim_grace_until,
  };
}

/** Every viewer endpoint: remote links on, a live session cookie, and a live grant for this link. */
export async function requireViewerAccess(request: Request, env: Env, linkId: string): Promise<ViewerAccess> {
  await assertRemoteLinksEnabled(env);
  const token = readLinkSessionToken(request, env);
  if (!token || !isLinkId(linkId)) throw linkUnavailable();
  return accessFor(hashSessionToken(token), linkId);
}

type RoomShareRow = {
  id: string;
  kind: "files" | "text";
  status: string;
  expires_at: Date;
  burn_after_download: boolean;
  claimed_link_session_hash: Buffer | null;
  claim_grace_until: Date | null;
  db_now: Date;
};

/**
 * P4-19: one share of a room link's room, for this session (T4-R6). Only a share of that very room; a share that has
 * ended, or hasn't finished uploading, is 404 (the link itself still works); a burn share claimed by someone else
 * is 410 ALREADY_DOWNLOADED; claimed by this session, it stays open while its grace lasts, as through a share link.
 */
export async function roomShareAccess(access: RoomViewerAccess, shareId: string): Promise<ShareViewerAccess> {
  if (!isUuid(shareId)) throw notFound();
  const { rows } = await sql<RoomShareRow>`
    select s.id, s.kind, s.status, s.expires_at, s.burn_after_download, s.claimed_link_session_hash, s.claim_grace_until, now() as db_now
      from app.shares s
     where s.id = ${shareId}::uuid and s.scope = 'room' and s.room_id = ${access.roomId}::uuid
  `.execute(getDb());
  const share = rows[0];
  if (!share) throw notFound();
  const now = share.db_now.getTime();
  const live = share.expires_at.getTime() > now;
  const isClaimant = share.claimed_link_session_hash !== null && share.claimed_link_session_hash.equals(access.sessionHash);
  if (share.burn_after_download && (share.status === "claimed" || share.status === "consumed") && live) {
    const inGrace = share.status === "claimed" && share.claim_grace_until !== null && share.claim_grace_until.getTime() > now;
    if (!isClaimant || !inGrace) throw alreadyDownloaded(isClaimant);
  }
  const open = share.status === "active" || (share.status === "claimed" && isClaimant);
  if (!open || !live) throw notFound();
  return {
    target: "share",
    linkId: access.linkId,
    sessionHash: access.sessionHash,
    linkExpiresAt: access.linkExpiresAt,
    grantExpiresAt: access.grantExpiresAt,
    entitlementSnapshot: access.entitlementSnapshot,
    shareId: share.id,
    kind: share.kind,
    networkSpaceId: null,
    roomId: access.roomId,
    shareExpiresAt: share.expires_at,
    status: share.status as "active" | "claimed",
    burnAfterDownload: share.burn_after_download,
    isClaimant,
    claimGraceUntil: share.claim_grace_until,
  };
}

/**
 * The share a viewer action is about. A share link: its own share (another ID is 404). A room link (P4-19): the share
 * the request names, checked against the room; without one, 404.
 */
export async function shareTarget(access: ViewerAccess, shareId: string | undefined): Promise<ShareViewerAccess> {
  if (access.target === "share") {
    if (shareId !== undefined && shareId !== access.shareId) throw notFound();
    return access;
  }
  if (shareId === undefined) throw notFound();
  return roomShareAccess(access, shareId);
}
