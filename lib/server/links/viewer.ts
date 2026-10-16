import "server-only";
import { sql } from "kysely";
import { FREE_LIMITS } from "@/lib/shared/plans";
import type { RevealResponse, ViewerContent } from "@/lib/shared/api/schemas";
import { audit } from "../audit/log";
import { getDb } from "../db/client";
import { userAgentFamily } from "../devices/labels";
import type { Env } from "../env";
import { ApiError, linkExpired, linkUnavailable, notFound } from "../http/errors";
import { enforceLinkDailyUrls, enforceRateLimit } from "../ratelimit/limits";
import { remoteFilePolicy } from "../security/file-policy";
import { claimOrRetry, confirmBurnReceived, issuancesUsed, left, requireConfirmation } from "../shares/burn";
import { isUuid } from "../shares/read";
import { DOWNLOAD_URL_TTL_SECONDS, PREVIEW_URL_TTL_SECONDS, presignGet } from "../storage/s3";
import { requireViewerAccess, type ViewerAccess } from "./grants";

/**
 * What a link viewer may see and fetch (03 §4.2, §6, G4): the link's one target share, as a
 * viewer DTO that never carries network or space IDs, presence, devices, the uploader or other
 * shares; and short-lived URLs for that share's files only, under the per-link daily cap.
 *
 * Burn after download (Phase 3): a viewer session can claim a burn share by its first download
 * (with confirm) or Reveal. Its text is never in the content; previews are never issued.
 */

type Snapshot = { limits?: { linkDailyUrlIssuances?: number }; historyRetentionDays?: number; features?: object };

function earliest(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

const viewerClaimant = (access: ViewerAccess) => ({ kind: "viewer" as const, sessionHash: access.sessionHash, linkId: access.linkId });

export async function loadViewerContent(access: ViewerAccess): Promise<ViewerContent> {
  const db = getDb();
  const burn = access.burnAfterDownload;
  const [files, text, used] = await Promise.all([
    db
      .selectFrom("app.files")
      .select(["id", "original_name", "size_bytes", "declared_mime", "detected_mime", "preview_kind", "risk_flags"])
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
      files: files.map((f) => {
        const size = Number(f.size_bytes ?? 0);
        return {
          id: f.id,
          name: f.original_name,
          sizeBytes: size,
          type: f.detected_mime ?? f.declared_mime,
          previewable: !burn && f.preview_kind === "image" && size <= FREE_LIMITS.maxPreviewBytes,
          riskFlags: f.risk_flags,
          ...(access.isClaimant ? { downloadsLeft: left(used?.get(f.id)) } : {}),
        };
      }),
      ...(burn
        ? {
            burn: {
              claimed: access.status === "claimed",
              byYou: access.isClaimant,
              availableUntil: access.isClaimant && access.claimGraceUntil ? access.claimGraceUntil.toISOString() : null,
              textHidden: access.kind === "text",
              revealsLeft: access.isClaimant && access.kind === "text" ? left(used?.get("text")) : null,
            },
          }
        : {}),
    },
  };
}

/** GET /links/{linkId}/content: polled every 30 s by the share page (no Realtime for viewers). Never claims. */
export async function viewerContent(request: Request, env: Env, linkId: string): Promise<ViewerContent> {
  const access = await requireViewerAccess(request, env, linkId);
  await enforceRateLimit("viewerContent", access.sessionHash.toString("hex"));
  return loadViewerContent(access);
}

export type ViewerUrl = {
  url: string;
  expiresAt: string;
  fileName: string;
  sizeBytes: number;
  riskFlags: string[];
  burn?: { availableUntil: string; left: number };
};

/** POST /links/{linkId}/files/{fileId}/download-url or …/preview-url (03 §6, link-viewer path). */
export async function viewerFileUrl(
  request: Request,
  env: Env,
  linkId: string,
  fileId: string,
  kind: "download" | "preview",
  confirm?: boolean,
): Promise<ViewerUrl> {
  const access = await requireViewerAccess(request, env, linkId);
  if (!isUuid(fileId)) throw notFound();
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

  const snapshot = (access.entitlementSnapshot ?? {}) as Snapshot;
  // Link creation already refused these; checked again in case the policy tightened since.
  if (!remoteFilePolicy(file.risk_flags, snapshot).allowed) {
    throw new ApiError(422, "REMOTE_FILE_BLOCKED", "This file can't be downloaded through a link");
  }
  const size = Number(file.size_bytes);
  if (kind === "preview" && (access.burnAfterDownload || file.preview_kind !== "image" || size > FREE_LIMITS.maxPreviewBytes)) {
    throw new ApiError(422, "PREVIEW_UNAVAILABLE", "No preview for this file");
  }

  await enforceRateLimit("viewerUrl", access.sessionHash.toString("hex"));
  await enforceLinkDailyUrls(access.linkId, snapshot.limits?.linkDailyUrlIssuances ?? FREE_LIMITS.linkDailyUrlIssuances);

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
      actor_kind: "link_viewer",
      link_id: access.linkId,
      event: kind === "preview" ? "preview_issued" : "url_issued",
      url_expires_at: sql<Date>`now() + make_interval(secs => ${ttl})`,
      user_agent_family: userAgentFamily(request.headers.get("user-agent")),
      retention_until: sql<Date>`now() + make_interval(days => ${snapshot.historyRetentionDays ?? 30})`,
    })
    .execute();

  return { url, ...result };
}

/** POST /links/{linkId}/reveal (C-7): a burn text, revealed by this deliberate POST only. Never logged. */
export async function viewerReveal(request: Request, env: Env, linkId: string, confirm?: boolean): Promise<RevealResponse> {
  const access = await requireViewerAccess(request, env, linkId);
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

/** POST /links/{linkId}/confirm-received: the viewer claimant ends the share now. Idempotent (204). */
export async function viewerConfirmReceived(request: Request, env: Env, linkId: string): Promise<void> {
  let access: ViewerAccess;
  try {
    access = await requireViewerAccess(request, env, linkId);
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
