import "server-only";
import { sql } from "kysely";
import type { Caller } from "../auth/device";
import { audit } from "../audit/log";
import { getDb } from "../db/client";
import { userAgentFamily } from "../devices/labels";
import type { Env } from "../env";
import { ApiError, notFound } from "../http/errors";
import type { NetworkView } from "../network/current";
import { enforceRateLimit } from "../ratelimit/limits";
import { FREE_LIMITS } from "@/lib/shared/plans";
import type { RevealResponse } from "@/lib/shared/api/schemas";
import { DOWNLOAD_URL_TTL_SECONDS, PREVIEW_URL_TTL_SECONDS, presignGet } from "../storage/s3";
import { BURN_MAX_ISSUANCES, claimOrRetry, confirmBurnReceived, requireConfirmation } from "./burn";
import { findVisibleShare, isUuid } from "./read";

/**
 * Download and preview URLs (03 §6): issued only after the visibility rule passes, for
 * verified files of active shares. Downloads live 60 s and are attachment-only (signed at
 * upload); previews live 300 s and only for verified raster images. Every issuance is logged.
 *
 * Burn after download (Phase 3, DEC-015): for anyone but the creator, the first download URL
 * claims the share and needs { confirm: true }; the claimant then gets at most 3 URLs per file
 * while the grace lasts, and everyone else 410 ALREADY_DOWNLOADED. Burn shares have no previews.
 * The creator may keep downloading until the share is consumed (D-7).
 */

export type BurnIssuanceDto = { availableUntil: string; left: number };
export type DownloadUrl = { url: string; expiresAt: string; fileName: string; sizeBytes: number; riskFlags: string[]; burn?: BurnIssuanceDto };
export type PreviewUrl = { url: string; expiresAt: string };

async function issue(
  caller: Caller,
  network: NetworkView,
  fileId: string,
  kind: "download" | "preview",
  request: Request,
  env: Env,
  confirm?: boolean,
) {
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
  // A claimed share is visible only to its creator and its claimant (lib/server/local/visibility.ts).
  if (file.upload_status !== "verified" || (share.status !== "active" && share.status !== "claimed")) throw notFound();
  const burnClaim = share.burnAfterDownload && !share.isCreator && kind === "download";
  if (burnClaim) requireConfirmation(confirm, "file");

  await enforceRateLimit("downloadUrl", caller.device.id);
  if (share.networkSpaceId && !share.isCreator) await enforceRateLimit("downloadUrlSpace", share.networkSpaceId);
  const size = Number(file.size_bytes);
  if (kind === "preview" && (share.burnAfterDownload || file.preview_kind !== "image" || size > FREE_LIMITS.maxPreviewBytes)) {
    throw new ApiError(422, "PREVIEW_UNAVAILABLE", "No preview for this file");
  }

  const ttl = kind === "preview" ? PREVIEW_URL_TTL_SECONDS : DOWNLOAD_URL_TTL_SECONDS;
  const ua = userAgentFamily(request.headers.get("user-agent"));
  if (burnClaim) {
    // Claim (or retry) and presign in one transaction: a failed presign rolls the claim back.
    return db.transaction().execute(async (trx) => {
      const issuance = await claimOrRetry(
        trx,
        share.id,
        { kind: "device", userId: caller.principal.userId, deviceId: caller.device.id },
        { kind: "file", fileId: file.id, urlTtlSeconds: ttl },
        ua,
        notFound,
      );
      const url = await presignGet(env, file.object_key, ttl);
      return {
        url,
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        file,
        size,
        burn: { availableUntil: issuance.availableUntil.toISOString(), left: issuance.left },
      };
    });
  }

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
      user_agent_family: ua,
      retention_until: sql<Date>`now() + make_interval(days => ${retentionDays})`,
    })
    .execute();

  return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), file, size, burn: undefined };
}

export async function issueDownloadUrl(
  caller: Caller,
  network: NetworkView,
  fileId: string,
  request: Request,
  env: Env,
  confirm?: boolean,
): Promise<DownloadUrl> {
  const { url, expiresAt, file, size, burn } = await issue(caller, network, fileId, "download", request, env, confirm);
  return { url, expiresAt, fileName: file.original_name, sizeBytes: size, riskFlags: file.risk_flags, ...(burn ? { burn } : {}) };
}

export async function issuePreviewUrl(caller: Caller, network: NetworkView, fileId: string, request: Request, env: Env): Promise<PreviewUrl> {
  const { url, expiresAt } = await issue(caller, network, fileId, "preview", request, env);
  return { url, expiresAt };
}

/**
 * POST /shares/{shareId}/reveal (C-7): a burn text is revealed only by this deliberate POST, which
 * claims it (or uses a retry). Its creator gets it without claiming. Never logged.
 */
export async function revealText(
  caller: Caller,
  network: NetworkView,
  shareId: string,
  request: Request,
  confirm?: boolean,
): Promise<RevealResponse> {
  const share = await findVisibleShare(caller, network, shareId);
  if (!share || share.kind !== "text" || !share.burnAfterDownload) throw notFound();
  if (!share.isCreator) requireConfirmation(confirm, "text");
  await enforceRateLimit("downloadUrl", caller.device.id);
  if (share.networkSpaceId && !share.isCreator) await enforceRateLimit("downloadUrlSpace", share.networkSpaceId);

  const db = getDb();
  if (share.isCreator) {
    const text = await db.selectFrom("app.text_items").select("content").where("share_id", "=", share.id).executeTakeFirst();
    if (!text?.content) throw notFound();
    return {
      text: { content: text.content },
      burn: { availableUntil: (share.claimGraceUntil ?? share.expiresAt).toISOString(), left: BURN_MAX_ISSUANCES },
    };
  }
  return db.transaction().execute(async (trx) => {
    const issuance = await claimOrRetry(
      trx,
      share.id,
      { kind: "device", userId: caller.principal.userId, deviceId: caller.device.id },
      { kind: "text" },
      userAgentFamily(request.headers.get("user-agent")),
      notFound,
    );
    // Read under the claim's row lock: the text is erased only when the share ends.
    const text = await trx.selectFrom("app.text_items").select("content").where("share_id", "=", share.id).executeTakeFirst();
    if (!text?.content) throw notFound();
    return { text: { content: text.content }, burn: { availableUntil: issuance.availableUntil.toISOString(), left: issuance.left } };
  });
}

/**
 * POST /shares/{shareId}/confirm-received: the device claimant ends the share now ("I've got it").
 * Repeating it answers 204 again; anyone else gets 404 (phase 3 §17.12).
 */
export async function confirmReceived(caller: Caller, network: NetworkView, shareId: string): Promise<void> {
  let share;
  try {
    share = await findVisibleShare(caller, network, shareId);
  } catch (error) {
    // Already consumed (or past grace) by this very claimant: nothing left to do.
    if (error instanceof ApiError && error.code === "ALREADY_DOWNLOADED" && (error.details as { byYou?: boolean }).byYou) return;
    if (error instanceof ApiError && error.code === "ALREADY_DOWNLOADED") throw notFound();
    throw error;
  }
  if (!share || !share.burnAfterDownload || share.status !== "claimed" || !share.isClaimant) throw notFound();
  await enforceRateLimit("confirmReceived", caller.device.id);
  const result = await confirmBurnReceived(
    getDb(),
    share.id,
    { kind: "device", userId: caller.principal.userId, deviceId: caller.device.id },
    notFound,
  );
  if (result === "consumed") {
    await audit(getDb(), {
      action: "burn.confirmed",
      actorUserId: caller.principal.userId,
      actorDeviceId: caller.device.id,
      networkSpaceId: share.networkSpaceId,
      targetType: "share",
      targetId: share.id,
    });
  }
}
