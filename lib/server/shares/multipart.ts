import "server-only";
import { sql } from "kysely";
import type { MultipartStatusResponse, PartUrlsResponse } from "@/lib/shared/api/schemas";
import { partRange } from "@/lib/shared/multipart";
import { audit } from "../audit/log";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import type { Env } from "../env";
import { ApiError, notFound } from "../http/errors";
import type { NetworkView } from "../network/current";
import { assertMayWrite } from "../policy/posting";
import { enforceRateLimit } from "../ratelimit/limits";
import { listParts, PART_URL_TTL_SECONDS, presignUploadPart } from "../storage/multipart";
import { headObject } from "../storage/s3";
import { loadOwnFile, type OwnFile, uploadComplete, uploadRefusal } from "./uploads";

/**
 * The multipart routes (phase 4 §17.8.1, P4-14), all for the share's creator and a pending multipart file
 * only (any other file: 404, E25):
 *   parts    presigned UploadPart URLs for up to 20 part numbers within the plan, each signing its part's
 *            exact size, for an hour at most (capped by the upload deadline and the share's expiry);
 *   status   what storage holds (ListParts, the truth for a resume after a reload, D4-25);
 *   abort    the creator cancels: the file is rejected and the share fails (all or nothing, DV1-10), which
 *            releases its reservations and refunds its daily volume; the outbox row carries the upload ID,
 *            and the storage janitor aborts the upload (D-1: the web tier never deletes or aborts).
 * Completion is the existing complete route (complete.ts).
 */

function multipartOnly(file: OwnFile): { uploadId: string; partSize: number; partCount: number; size: number } {
  if (file.upload_mode !== "multipart" || !file.multipart_upload_id || file.part_size_bytes === null || file.part_count === null) throw notFound();
  return {
    uploadId: file.multipart_upload_id,
    partSize: Number(file.part_size_bytes),
    partCount: file.part_count,
    size: Number(file.declared_size_bytes),
  };
}

export async function issuePartUrls(
  caller: Caller,
  network: NetworkView,
  shareId: string,
  fileId: string,
  partNumbers: number[],
  env: Env,
): Promise<PartUrlsResponse> {
  const { share, file } = await loadOwnFile(caller, network, shareId, fileId, { roomWrite: true });
  const plan = multipartOnly(file);
  await enforceRateLimit("multipartParts", caller.principal.userId);
  // No URL for a part the plan doesn't have (T4-M4).
  if (partNumbers.some((n) => n > plan.partCount)) {
    throw new ApiError(422, "MULTIPART_INVALID", "This part isn't part of the upload", { partCount: plan.partCount });
  }
  await assertMayWrite(caller, env, { files: true });

  // The URLs' expiry is recorded before they are handed out, as for single PUTs, and only while the
  // upload may still finish; end_share locks the same row, so no URL is issued for an ended share.
  const { rows } = await sql<{ ttl_seconds: number; expires_at: Date }>`
    with issue as (
      select f.id, least(now() + make_interval(secs => ${PART_URL_TTL_SECONDS}), f.upload_expires_at, s.expires_at) as expires_at
        from app.files f
        join app.shares s on s.id = f.share_id
       where f.id = ${file.id}::uuid
         and f.upload_status = 'pending'
         and f.upload_mode = 'multipart'
         and s.status = 'pending_upload'
         and f.upload_expires_at > now() + interval '1 second'
         and s.expires_at > now() + interval '1 second'
    )
    update app.files f
       set upload_url_expires_at = greatest(f.upload_url_expires_at, issue.expires_at)
      from issue
     where f.id = issue.id and f.upload_status = 'pending'
    returning floor(extract(epoch from issue.expires_at - now()))::integer as ttl_seconds, issue.expires_at
  `.execute(getDb());
  const issued = rows[0];
  if (!issued || issued.ttl_seconds < 1) throw await uploadRefusal(share.id, file.id);

  const expiresAt = new Date(issued.expires_at).toISOString();
  return {
    parts: await Promise.all(
      partNumbers.map(async (partNumber) => {
        const { size } = partRange(partNumber, plan.partSize, plan.size);
        return {
          partNumber,
          url: await presignUploadPart(env, file.object_key, plan.uploadId, partNumber, size, issued.ttl_seconds),
          size,
          expiresAt,
        };
      }),
    ),
  };
}

export async function multipartStatus(
  caller: Caller,
  network: NetworkView,
  shareId: string,
  fileId: string,
  env: Env,
): Promise<MultipartStatusResponse> {
  const { share, file } = await loadOwnFile(caller, network, shareId, fileId);
  const plan = multipartOnly(file);
  await enforceRateLimit("multipartStatus", caller.principal.userId);
  const base = { partSize: plan.partSize, partCount: plan.partCount, expiresAt: new Date(file.upload_expires_at).toISOString() };
  // Everything is in storage: the client finds nothing missing and completes (idempotent).
  const everything = () => ({
    ...base,
    uploaded: Array.from({ length: plan.partCount }, (_, i) => ({ partNumber: i + 1, size: partRange(i + 1, plan.partSize, plan.size).size })),
  });

  if (file.upload_status === "verified") return everything();
  if (file.upload_status !== "pending" || share.status !== "pending_upload" || !file.in_time) throw await uploadRefusal(share.id, file.id);
  const listed = await listParts(env, file.object_key, plan.uploadId);
  if (listed === null) {
    // The upload no longer exists: a completion has just assembled it, or it was aborted.
    if (await headObject(env, file.object_key)) return everything();
    throw new ApiError(409, "UPLOAD_EXPIRED", "The upload took too long; start again");
  }
  return {
    ...base,
    uploaded: listed.map((p) => ({ partNumber: p.partNumber, size: Math.max(0, p.size) })).sort((a, b) => a.partNumber - b.partNumber),
  };
}

export async function abortMultipart(caller: Caller, network: NetworkView, shareId: string, fileId: string): Promise<void> {
  const { share, file } = await loadOwnFile(caller, network, shareId, fileId);
  const plan = multipartOnly(file);
  await enforceRateLimit("multipartAbort", caller.principal.userId);

  const outcome = await getDb().transaction().execute(async (trx) => {
    // Lock order everywhere: share, then file, then the storage ledger (no deadlocks with end_share).
    const lockedShare = await trx.selectFrom("app.shares").select("status").where("id", "=", share.id).forUpdate().executeTakeFirstOrThrow();
    const locked = await trx.selectFrom("app.files").select("upload_status").where("id", "=", file.id).forUpdate().executeTakeFirstOrThrow();
    if (locked.upload_status === "verified") return "complete";
    if (locked.upload_status !== "pending" || lockedShare.status !== "pending_upload") return "over";

    await trx.updateTable("app.files").set({ upload_status: "rejected", rejection_reason: "cancelled" }).where("id", "=", file.id).execute();
    await sql`select app.release_reservation(r.id) from app.storage_reservations r where r.file_id = ${file.id}::uuid and r.status = 'active'`.execute(trx);
    await sql`
      insert into app.object_deletions (object_key, reason, source_file_id, multipart_upload_id)
      values (${file.object_key}, 'multipart_abort', ${file.id}::uuid, ${plan.uploadId})
      on conflict (object_key) where completed_at is null do nothing
    `.execute(trx);
    // The rest of the share goes with it, and its daily volume comes back (C4-6).
    await sql`select app.end_share(${share.id}::uuid, 'upload_failed')`.execute(trx);
    await audit(trx, {
      action: "share.upload_cancelled",
      actorUserId: caller.principal.userId,
      actorDeviceId: caller.device.id,
      networkSpaceId: share.networkSpaceId,
      targetType: "share",
      targetId: share.id,
    });
    return "aborted";
  });
  if (outcome === "complete") throw uploadComplete();
}
