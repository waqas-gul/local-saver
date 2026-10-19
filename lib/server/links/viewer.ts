import "server-only";
import { sql } from "kysely";
import type { RevealResponse, ViewerContent, ViewerRoomContent, ViewerShareContent } from "@/lib/shared/api/schemas";
import { audit } from "../audit/log";
import { getDb } from "../db/client";
import { userAgentFamily } from "../devices/labels";
import { readSnapshot } from "../entitlements/snapshot";
import type { Env } from "../env";
import { ApiError, linkExpired, linkUnavailable, notFound } from "../http/errors";
import { enforceLinkDailyUrls, enforceRateLimit } from "../ratelimit/limits";
import { remoteFilePolicy } from "../security/file-policy";
import { claimOrRetry, confirmBurnReceived, issuancesUsed, left, requireConfirmation } from "../shares/burn";
import { encodeCursor, isUuid, pageParams } from "../shares/read";
import { DOWNLOAD_URL_TTL_SECONDS, PREVIEW_URL_TTL_SECONDS, presignGet } from "../storage/s3";
import {
  requireViewerAccess,
  roomShareAccess,
  shareTarget,
  type RoomViewerAccess,
  type ShareViewerAccess,
  type ViewerAccess,
} from "./grants";

/**
 * What a link viewer may see and fetch (03 §4.2, §6, G4): the link's one target share, as a
 * viewer DTO that never carries network or space IDs, presence, devices, the uploader or other
 * shares; and short-lived URLs for that share's files only, under the per-link daily cap.
 *
 * Burn after download (Phase 3): a viewer session can claim a burn share by its first download
 * (with confirm) or Reveal. Its text is never in the content; previews are never issued.
 *
 * Limits come from the link's snapshot (07 §2.3, §17.16): its daily URL cap (E15), preview size
 * (E27) and remote file policy (E16) stay what they were when the link was created.
 *
 * Room links (Phase 4, P4-19, §17.8.5): the content is the room's current active shares, newest first, by cursor;
 * each with the same viewer DTO a share link gives, plus its ID (the burn actions and reports name it). Never the
 * room's name, members, invites, settings, who posted, networks or presence. Files and burn actions resolve their
 * share inside the link's room (roomShareAccess, T4-R6). The link's snapshot sets the limits for every share; a file
 * the snapshot's remote file policy blocks is listed as blocked and never handed out (E16).
 */

function earliest(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

const viewerClaimant = (access: ShareViewerAccess) => ({ kind: "viewer" as const, sessionHash: access.sessionHash, linkId: access.linkId });

type FileRow = {
  id: string;
  share_id: string;
  original_name: string;
  size_bytes: string | number | bigint | null;
  declared_mime: string;
  detected_mime: string | null;
  preview_kind: string | null;
  risk_flags: string[];
};

type BurnState = { status: string; burnAfterDownload: boolean; isClaimant: boolean; claimGraceUntil: Date | null; kind: "files" | "text" };

/** A share's files as a viewer sees them; `room` adds the remote file policy's verdict per file (P4-19). */
function viewerFiles(files: FileRow[], burn: BurnState, used: Map<string, number> | undefined, snapshot: ReturnType<typeof readSnapshot>, room: boolean) {
  return files.map((f) => {
    const size = Number(f.size_bytes ?? 0);
    return {
      id: f.id,
      name: f.original_name,
      sizeBytes: size,
      type: f.detected_mime ?? f.declared_mime,
      previewable: !burn.burnAfterDownload && f.preview_kind === "image" && size <= snapshot.limits.maxPreviewBytes,
      riskFlags: f.risk_flags,
      ...(burn.isClaimant ? { downloadsLeft: left(used?.get(f.id)) } : {}),
      ...(room && !remoteFilePolicy(f.risk_flags, snapshot).allowed ? { blocked: true as const } : {}),
    };
  });
}

function burnDto(burn: BurnState, used: Map<string, number> | undefined) {
  return {
    claimed: burn.status === "claimed",
    byYou: burn.isClaimant,
    availableUntil: burn.isClaimant && burn.claimGraceUntil ? burn.claimGraceUntil.toISOString() : null,
    textHidden: burn.kind === "text",
    revealsLeft: burn.isClaimant && burn.kind === "text" ? left(used?.get("text")) : null,
  };
}

const FILE_COLUMNS = ["id", "share_id", "original_name", "size_bytes", "declared_mime", "detected_mime", "preview_kind", "risk_flags"] as const;

async function loadShareContent(access: ShareViewerAccess): Promise<ViewerShareContent> {
  const db = getDb();
  const burn = access.burnAfterDownload;
  const snapshot = readSnapshot(access.entitlementSnapshot);
  const [files, text, used] = await Promise.all([
    db
      .selectFrom("app.files")
      .select(FILE_COLUMNS)
      .where("share_id", "=", access.shareId)
      .where("upload_status", "=", "verified")
      .orderBy("position")
      .orderBy("id")
      .execute(),
    access.kind === "text" && !burn
      ? db.selectFrom("app.text_items").select("content").where("share_id", "=", access.shareId).executeTakeFirst()
      : Promise.resolve(undefined),
    access.isClaimant ? issuancesUsed(db, [access.shareId]).then((m) => m.get(access.shareId)) : Promise.resolve(undefined),
  ]);
  return {
    link: { id: access.linkId, expiresAt: earliest(access.linkExpiresAt, access.shareExpiresAt).toISOString() },
    access: { expiresAt: access.grantExpiresAt.toISOString() },
    share: {
      kind: access.kind,
      expiresAt: access.shareExpiresAt.toISOString(),
      text: text && text.content !== null ? { content: text.content } : null,
      files: viewerFiles(files as FileRow[], access, used, snapshot, false),
      ...(burn ? { burn: burnDto(access, used) } : {}),
    },
  };
}

type RoomShareRow = {
  id: string;
  kind: "files" | "text";
  created_at: Date;
  expires_at: Date;
  status: string;
  burn_after_download: boolean;
  claimed_link_session_hash: Buffer | null;
  claim_grace_until: Date | null;
};

/**
 * P4-19: a room link's page of the room's shares. Active and unexpired, plus a burn share this session claimed while
 * its grace lasts (one claimed by anyone else is gone for this viewer); pending uploads never show.
 */
async function loadRoomContent(access: RoomViewerAccess, url: URL | undefined): Promise<ViewerRoomContent> {
  const db = getDb();
  const { cursor, limit } = pageParams(url ?? new URL("http://local.invalid/"));
  const { rows } = await sql<RoomShareRow>`
    select s.id, s.kind, s.created_at, s.expires_at, s.status, s.burn_after_download, s.claimed_link_session_hash, s.claim_grace_until
      from app.shares s
     where s.scope = 'room' and s.room_id = ${access.roomId}::uuid and s.expires_at > now()
       and (s.status = 'active'
            or (s.status = 'claimed' and s.claimed_link_session_hash = ${access.sessionHash} and s.claim_grace_until > now()))
       ${cursor ? sql`and (s.created_at, s.id) < (${new Date(cursor.t)}, ${cursor.id}::uuid)` : sql``}
     order by s.created_at desc, s.id desc
     limit ${limit + 1}
  `.execute(db);
  const visible = rows.slice(0, limit);
  const ids = visible.map((s) => s.id);
  const claimed = visible.filter((s) => s.claimed_link_session_hash?.equals(access.sessionHash) === true).map((s) => s.id);
  const readableTexts = visible.filter((s) => s.kind === "text" && !s.burn_after_download).map((s) => s.id);
  const [files, texts, used] = await Promise.all([
    ids.length === 0
      ? Promise.resolve([] as FileRow[])
      : db
          .selectFrom("app.files")
          .select(FILE_COLUMNS)
          .where("share_id", "in", ids)
          .where("upload_status", "=", "verified")
          .orderBy("position")
          .orderBy("id")
          .execute(),
    readableTexts.length === 0
      ? Promise.resolve([] as { share_id: string; content: string | null }[])
      : db.selectFrom("app.text_items").select(["share_id", "content"]).where("share_id", "in", readableTexts).execute(),
    issuancesUsed(db, claimed),
  ]);
  const snapshot = readSnapshot(access.entitlementSnapshot);
  const textOf = new Map(texts.map((t) => [t.share_id, t.content]));
  const last = visible[visible.length - 1];
  return {
    link: { id: access.linkId, expiresAt: access.linkExpiresAt.toISOString() },
    access: { expiresAt: access.grantExpiresAt.toISOString() },
    room: {
      shares: visible.map((s) => {
        const burn: BurnState = {
          status: s.status,
          burnAfterDownload: s.burn_after_download,
          isClaimant: claimed.includes(s.id),
          claimGraceUntil: s.claim_grace_until,
          kind: s.kind,
        };
        const content = textOf.get(s.id);
        return {
          id: s.id,
          kind: s.kind,
          createdAt: s.created_at.toISOString(),
          expiresAt: s.expires_at.toISOString(),
          text: content !== undefined && content !== null ? { content } : null,
          files: viewerFiles((files as FileRow[]).filter((f) => f.share_id === s.id), burn, used.get(s.id), snapshot, true),
          ...(s.burn_after_download ? { burn: burnDto(burn, used.get(s.id)) } : {}),
        };
      }),
      nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
    },
  };
}

export async function loadViewerContent(access: ViewerAccess, url?: URL): Promise<ViewerContent> {
  return access.target === "room" ? loadRoomContent(access, url) : loadShareContent(access);
}

/** GET /links/{linkId}/content[?cursor&limit]: polled every 30 s by the share page (no Realtime for viewers). Never claims. */
export async function viewerContent(request: Request, env: Env, linkId: string): Promise<ViewerContent> {
  const access = await requireViewerAccess(request, env, linkId);
  await enforceRateLimit("viewerContent", access.sessionHash.toString("hex"));
  return loadViewerContent(access, new URL(request.url));
}

export type ViewerUrl = {
  url: string;
  expiresAt: string;
  fileName: string;
  sizeBytes: number;
  riskFlags: string[];
  burn?: { availableUntil: string; left: number };
};

/** P4-19: the share of a room link's room that holds this file, for this session; 404 for any other file (T4-R6). */
async function roomFileShare(access: RoomViewerAccess, fileId: string): Promise<ShareViewerAccess> {
  const file = await getDb()
    .selectFrom("app.files as f")
    .innerJoin("app.shares as s", "s.id", "f.share_id")
    .select("f.share_id")
    .where("f.id", "=", fileId)
    .where("s.scope", "=", "room")
    .where("s.room_id", "=", access.roomId)
    .executeTakeFirst();
  if (!file) throw notFound();
  return roomShareAccess(access, file.share_id);
}

/** POST /links/{linkId}/files/{fileId}/download-url or …/preview-url (03 §6, link-viewer path). */
export async function viewerFileUrl(
  request: Request,
  env: Env,
  linkId: string,
  fileId: string,
  kind: "download" | "preview",
  confirm?: boolean,
): Promise<ViewerUrl> {
  const link = await requireViewerAccess(request, env, linkId);
  if (!isUuid(fileId)) throw notFound();
  const access = link.target === "room" ? await roomFileShare(link, fileId) : link;
  const db = getDb();
  // Scope: only files of this link's share (IDOR, T-029).
  const file = await db
    .selectFrom("app.files")
    .select(["id", "object_key", "original_name", "size_bytes", "upload_status", "preview_kind", "risk_flags"])
    .where("id", "=", fileId)
    .where("share_id", "=", access.shareId)
    .executeTakeFirst();
  if (!file || file.upload_status !== "verified") throw notFound();
  const burnClaim = access.burnAfterDownload && kind === "download";
  if (burnClaim) requireConfirmation(confirm, "file");

  const snapshot = readSnapshot(access.entitlementSnapshot);
  // Link creation already refused these for share links; checked again in case the policy tightened since. A room
  // link (P4-19) covers shares posted after it: this is where its policy holds.
  if (!remoteFilePolicy(file.risk_flags, snapshot).allowed) {
    throw new ApiError(422, "REMOTE_FILE_BLOCKED", "This file can't be downloaded through a link");
  }
  const size = Number(file.size_bytes);
  if (kind === "preview" && (access.burnAfterDownload || file.preview_kind !== "image" || size > snapshot.limits.maxPreviewBytes)) {
    throw new ApiError(422, "PREVIEW_UNAVAILABLE", "No preview for this file");
  }

  await enforceRateLimit("viewerUrl", access.sessionHash.toString("hex"));
  await enforceLinkDailyUrls(access.linkId, snapshot.limits.linkDailyUrlIssuances);

  const ttl = kind === "preview" ? PREVIEW_URL_TTL_SECONDS : DOWNLOAD_URL_TTL_SECONDS;
  const result = { expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), fileName: file.original_name, sizeBytes: size, riskFlags: file.risk_flags };
  if (burnClaim) {
    // Claim (or retry) and presign in one transaction: a failed presign rolls the claim back.
    return db.transaction().execute(async (trx) => {
      const issuance = await claimOrRetry(
        trx,
        access.shareId,
        viewerClaimant(access),
        { kind: "file", fileId: file.id, urlTtlSeconds: ttl },
        userAgentFamily(request.headers.get("user-agent")),
        linkExpired,
      );
      const url = await presignGet(env, file.object_key, ttl);
      return { url, ...result, burn: { availableUntil: issuance.availableUntil.toISOString(), left: issuance.left } };
    });
  }

  const url = await presignGet(env, file.object_key, ttl);
  await db
    .insertInto("app.downloads")
    .values({
      share_id: access.shareId,
      file_id: file.id,
      network_space_id: access.networkSpaceId,
      room_id: access.roomId,
      actor_kind: "link_viewer",
      link_id: access.linkId,
      event: kind === "preview" ? "preview_issued" : "url_issued",
      url_expires_at: sql<Date>`now() + make_interval(secs => ${ttl})`,
      user_agent_family: userAgentFamily(request.headers.get("user-agent")),
      retention_until: sql<Date>`now() + make_interval(days => ${snapshot.historyRetentionDays})`,
    })
    .execute();

  return { url, ...result };
}

/**
 * POST /links/{linkId}/reveal { confirm, shareId? } (C-7): a burn text, revealed by this deliberate POST only. Never
 * logged. Through a room link (P4-19) the request names the share.
 */
export async function viewerReveal(request: Request, env: Env, linkId: string, confirm?: boolean, shareId?: string): Promise<RevealResponse> {
  const access = await shareTarget(await requireViewerAccess(request, env, linkId), shareId);
  if (access.kind !== "text" || !access.burnAfterDownload) throw notFound();
  requireConfirmation(confirm, "text");
  await enforceRateLimit("viewerUrl", access.sessionHash.toString("hex"));
  return getDb().transaction().execute(async (trx) => {
    const issuance = await claimOrRetry(
      trx,
      access.shareId,
      viewerClaimant(access),
      { kind: "text" },
      userAgentFamily(request.headers.get("user-agent")),
      linkExpired,
    );
    const text = await trx.selectFrom("app.text_items").select("content").where("share_id", "=", access.shareId).executeTakeFirst();
    if (!text?.content) throw linkExpired();
    return { text: { content: text.content }, burn: { availableUntil: issuance.availableUntil.toISOString(), left: issuance.left } };
  });
}

/**
 * POST /links/{linkId}/confirm-received { shareId? }: the viewer claimant ends the share now. Idempotent (204).
 * Through a room link (P4-19) the request names the share.
 */
export async function viewerConfirmReceived(request: Request, env: Env, linkId: string, shareId?: string): Promise<void> {
  let access: ShareViewerAccess;
  try {
    access = await shareTarget(await requireViewerAccess(request, env, linkId), shareId);
  } catch (error) {
    if (error instanceof ApiError && error.code === "ALREADY_DOWNLOADED" && (error.details as { byYou?: boolean }).byYou) return;
    if (error instanceof ApiError && error.code === "ALREADY_DOWNLOADED") throw linkUnavailable();
    throw error;
  }
  if (!access.burnAfterDownload || access.status !== "claimed" || !access.isClaimant) throw linkUnavailable();
  await enforceRateLimit("confirmReceived", access.sessionHash.toString("hex"));
  const result = await confirmBurnReceived(getDb(), access.shareId, viewerClaimant(access), linkUnavailable);
  if (result === "consumed") {
    await audit(getDb(), {
      action: "burn.confirmed",
      actorKind: "link_viewer",
      networkSpaceId: access.networkSpaceId,
      targetType: "share",
      targetId: access.shareId,
      metadata: { linkId: access.linkId },
    });
  }
}
