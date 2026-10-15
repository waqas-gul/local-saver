import "server-only";
import { sql } from "kysely";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import { userAgentFamily } from "../devices/labels";
import type { Env } from "../env";
import { ApiError, notFound } from "../http/errors";
import type { NetworkView } from "../network/current";
import { enforceRateLimit } from "../ratelimit/limits";
import { FREE_LIMITS } from "@/lib/shared/plans";
import { DOWNLOAD_URL_TTL_SECONDS, PREVIEW_URL_TTL_SECONDS, presignGet } from "../storage/s3";
import { findVisibleShare, isUuid } from "./read";

/**
 * Download and preview URLs (03 §6): issued only after the visibility rule passes, for
 * verified files of active shares. Downloads live 60 s and are attachment-only (signed at
 * upload); previews live 300 s and only for verified raster images. Every issuance is logged.
 */

export type DownloadUrl = { url: string; expiresAt: string; fileName: string; sizeBytes: number; riskFlags: string[] };
export type PreviewUrl = { url: string; expiresAt: string };

async function issue(caller: Caller, network: NetworkView, fileId: string, kind: "download" | "preview", request: Request, env: Env) {
  if (!isUuid(fileId)) throw notFound();
  const db = getDb();
  const file = await db
    .selectFrom("app.files")
    .select(["id", "share_id", "object_key", "original_name", "size_bytes", "upload_status", "preview_kind", "risk_flags"])
    .where("id", "=", fileId)
    .executeTakeFirst();
  if (!file) throw notFound();
  const share = await findVisibleShare(caller, network, file.share_id);
  if (!share) throw notFound();
  if (file.upload_status === "pending") throw new ApiError(409, "UPLOAD_INCOMPLETE", "The file has not been uploaded yet");
  if (file.upload_status !== "verified" || share.status !== "active") throw notFound();

  await enforceRateLimit("downloadUrl", caller.device.id);
  if (share.networkSpaceId && !share.isCreator) await enforceRateLimit("downloadUrlSpace", share.networkSpaceId);
  const size = Number(file.size_bytes);
  if (kind === "preview" && (file.preview_kind !== "image" || size > FREE_LIMITS.maxPreviewBytes)) {
    throw new ApiError(422, "PREVIEW_UNAVAILABLE", "No preview for this file");
  }

  const ttl = kind === "preview" ? PREVIEW_URL_TTL_SECONDS : DOWNLOAD_URL_TTL_SECONDS;
  const url = await presignGet(env, file.object_key, ttl);
  const retentionDays = (share.entitlementSnapshot as { historyRetentionDays?: number }).historyRetentionDays ?? 30;
  await db
    .insertInto("app.downloads")
    .values({
      share_id: share.id,
      file_id: file.id,
      network_space_id: share.networkSpaceId,
      actor_kind: share.isCreator ? "creator" : "network_device",
      user_id: caller.principal.userId,
      device_id: caller.device.id,
      event: kind === "preview" ? "preview_issued" : "url_issued",
      url_expires_at: sql<Date>`now() + make_interval(secs => ${ttl})`,
      user_agent_family: userAgentFamily(request.headers.get("user-agent")),
      retention_until: sql<Date>`now() + make_interval(days => ${retentionDays})`,
    })
    .execute();

  return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), file, size };
}

export async function issueDownloadUrl(caller: Caller, network: NetworkView, fileId: string, request: Request, env: Env): Promise<DownloadUrl> {
  const { url, expiresAt, file, size } = await issue(caller, network, fileId, "download", request, env);
  return { url, expiresAt, fileName: file.original_name, sizeBytes: size, riskFlags: file.risk_flags };
}

export async function issuePreviewUrl(caller: Caller, network: NetworkView, fileId: string, request: Request, env: Env): Promise<PreviewUrl> {
  const { url, expiresAt } = await issue(caller, network, fileId, "preview", request, env);
  return { url, expiresAt };
}
