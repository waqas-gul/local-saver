import "server-only";
import { sql } from "kysely";
import { FREE_LIMITS } from "@/lib/shared/plans";
import type { ViewerContent } from "@/lib/shared/api/schemas";
import { getDb } from "../db/client";
import { userAgentFamily } from "../devices/labels";
import type { Env } from "../env";
import { ApiError, notFound } from "../http/errors";
import { enforceLinkDailyUrls, enforceRateLimit } from "../ratelimit/limits";
import { remoteFilePolicy } from "../security/file-policy";
import { isUuid } from "../shares/read";
import { DOWNLOAD_URL_TTL_SECONDS, PREVIEW_URL_TTL_SECONDS, presignGet } from "../storage/s3";
import { requireViewerAccess, type ViewerAccess } from "./grants";

/**
 * What a link viewer may see and fetch (03 §4.2, §6, G4): the link's one target share, as a
 * viewer DTO that never carries network or space IDs, presence, devices, the uploader or other
 * shares; and short-lived URLs for that share's files only, under the per-link daily cap.
 */

type Snapshot = { limits?: { linkDailyUrlIssuances?: number }; historyRetentionDays?: number; features?: object };

function earliest(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

export async function loadViewerContent(access: ViewerAccess): Promise<ViewerContent> {
  const db = getDb();
  const [files, text] = await Promise.all([
    db
      .selectFrom("app.files")
      .select(["id", "original_name", "size_bytes", "declared_mime", "detected_mime", "preview_kind", "risk_flags"])
      .where("share_id", "=", access.shareId)
      .where("upload_status", "=", "verified")
      .orderBy("position")
      .orderBy("id")
      .execute(),
    access.kind === "text"
      ? db.selectFrom("app.text_items").select("content").where("share_id", "=", access.shareId).executeTakeFirst()
      : Promise.resolve(undefined),
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
          previewable: f.preview_kind === "image" && size <= FREE_LIMITS.maxPreviewBytes,
          riskFlags: f.risk_flags,
        };
      }),
    },
  };
}

/** GET /links/{linkId}/content: polled every 30 s by the share page (no Realtime for viewers). */
export async function viewerContent(request: Request, env: Env, linkId: string): Promise<ViewerContent> {
  const access = await requireViewerAccess(request, env, linkId);
  await enforceRateLimit("viewerContent", access.sessionHash.toString("hex"));
  return loadViewerContent(access);
}

export type ViewerUrl = { url: string; expiresAt: string; fileName: string; sizeBytes: number; riskFlags: string[] };

/** POST /links/{linkId}/files/{fileId}/download-url or …/preview-url (03 §6, link-viewer path). */
export async function viewerFileUrl(
  request: Request,
  env: Env,
  linkId: string,
  fileId: string,
  kind: "download" | "preview",
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

  const snapshot = (access.entitlementSnapshot ?? {}) as Snapshot;
  // Link creation already refused these; checked again in case the policy tightened since.
  if (!remoteFilePolicy(file.risk_flags, snapshot).allowed) {
    throw new ApiError(422, "REMOTE_FILE_BLOCKED", "This file can't be downloaded through a link");
  }
  const size = Number(file.size_bytes);
  if (kind === "preview" && (file.preview_kind !== "image" || size > FREE_LIMITS.maxPreviewBytes)) {
    throw new ApiError(422, "PREVIEW_UNAVAILABLE", "No preview for this file");
  }

  await enforceRateLimit("viewerUrl", access.sessionHash.toString("hex"));
  await enforceLinkDailyUrls(access.linkId, snapshot.limits?.linkDailyUrlIssuances ?? FREE_LIMITS.linkDailyUrlIssuances);

  const ttl = kind === "preview" ? PREVIEW_URL_TTL_SECONDS : DOWNLOAD_URL_TTL_SECONDS;
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

  return {
    url,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    fileName: file.original_name,
    sizeBytes: size,
    riskFlags: file.risk_flags,
  };
}
