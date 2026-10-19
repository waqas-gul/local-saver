import "server-only";
import { sql } from "kysely";
import type { ShareDto } from "@/lib/shared/api/schemas";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import type { Env } from "../env";
import { ApiError } from "../http/errors";
import type { NetworkView } from "../network/current";
import { readSnapshot } from "../entitlements/snapshot";
import { assertMayWrite } from "../policy/posting";
import { enforceRateLimit } from "../ratelimit/limits";
import { remoteFilePolicy } from "../security/file-policy";
import { riskFlags } from "../security/file-risk";
import { isPreviewType } from "../storage/keys";
import { checkParts, completeMultipartUpload, listParts } from "../storage/multipart";
import { headObject, readObjectHead } from "../storage/s3";
import { uploadHeaders } from "./create";
import { SNIFF_BYTES, sniff } from "../storage/sniff";
import { loadShareDto } from "./dto";
import { loadOwnFile, type OwnFile } from "./uploads";

/**
 * Upload completion (04 §8.5, 03 §7.3): HeadObject must show exactly the declared size,
 * then the first 4,100 bytes are sniffed. Anything else rejects the file, queues the object
 * for deletion, releases the reservation and fails the share (all-or-nothing, DV1-10). The
 * storage janitor deletes the queued objects (phase 3, D-1).
 *
 * Phase 4: completion publishes the file, so the posting kill switches and the caller's upload
 * restriction apply (E29, C4-15). The share's own snapshot decides its remote file policy (E16), and
 * an upload in progress at a downgrade may finish: its size was allowed when the share was created
 * (D4-27, multipart uploads included).
 *
 * Phase 4 (P4-14, §17.8.1): a multipart file is first assembled from the storage's own part list, after
 * every part is checked against the plan the server made at init (the client names no parts or ETags,
 * and its body stays empty). Parts still missing answer 409 MULTIPART_INCOMPLETE and the upload goes on;
 * anything an honest client can't produce through its signed URLs (an extra part, a part of the wrong
 * size) rejects the file with 422 MULTIPART_INVALID, and the outbox row carries the upload ID for the
 * janitor to abort. Then the same checks as a single PUT. Two tabs completing at once both end here:
 * storage completes an upload once, and the file row lock lets one completion publish it.
 */

async function rejectUpload(shareId: string, fileId: string, reason: string, code = "UPLOAD_REJECTED"): Promise<never> {
  await getDb().transaction().execute(async (trx) => {
    // Lock order everywhere: share, then file, then the storage ledger (no deadlocks with end_share).
    await trx.selectFrom("app.shares").select("id").where("id", "=", shareId).forUpdate().execute();
    const file = await trx
      .updateTable("app.files")
      .set({ upload_status: "rejected", rejection_reason: reason })
      .where("id", "=", fileId)
      .where("upload_status", "=", "pending")
      .returning(["object_key"])
      .executeTakeFirst();
    if (!file) return;
    await sql`select app.release_reservation(r.id) from app.storage_reservations r where r.file_id = ${fileId}::uuid and r.status = 'active'`.execute(trx);
    await sql`
      insert into app.object_deletions (object_key, reason, source_file_id)
      values (${file.object_key}, 'upload_rejected', ${fileId}::uuid)
      on conflict (object_key) where completed_at is null do nothing
    `.execute(trx);
    await sql`select app.end_share(${shareId}::uuid, 'upload_failed')`.execute(trx);
  });
  throw new ApiError(422, code, "The upload was rejected", { reason });
}

function incomplete(missingParts: number): ApiError {
  return new ApiError(409, "MULTIPART_INCOMPLETE", "Some parts haven't been uploaded yet", { missingParts });
}

/**
 * Assembles a multipart upload from the storage's own part list (T4-M3, M5, M7, M12). Returns when the
 * object should exist; HeadObject below has the last word.
 */
async function assembleMultipart(env: Env, shareId: string, file: OwnFile, declared: number): Promise<void> {
  if (!file.multipart_upload_id || file.part_size_bytes === null || file.part_count === null) throw new Error("multipart file without its plan");
  const plan = { partSize: Number(file.part_size_bytes), partCount: file.part_count };
  const listed = await listParts(env, file.object_key, file.multipart_upload_id);
  // The upload no longer exists: a concurrent completion assembled it, or it was aborted.
  if (listed === null) return;
  const check = checkParts(listed, plan, declared);
  if (!check.ok) {
    if ("invalid" in check) return rejectUpload(shareId, file.id, "multipart_invalid", "MULTIPART_INVALID");
    throw incomplete(check.missing.length);
  }
  const outcome = await completeMultipartUpload(env, file.object_key, file.multipart_upload_id, check.parts);
  // A part was sent again between the listing and now (another tab): list again on the next try.
  if (outcome === "changed") throw incomplete(0);
}

export async function completeFile(
  caller: Caller,
  network: NetworkView,
  shareId: string,
  fileId: string,
  env: Env,
): Promise<ShareDto> {
  const { share, file } = await loadOwnFile(caller, network, shareId, fileId, { roomWrite: true });
  const db = getDb();
  await enforceRateLimit("completeUpload", caller.principal.userId);

  if (file.upload_status === "verified") return loadShareDto(db, share.id, caller.principal.userId, caller.device.id);
  if (file.upload_status !== "pending" || share.status !== "pending_upload") {
    throw new ApiError(422, "UPLOAD_REJECTED", "The upload was rejected", { reason: file.rejection_reason ?? "share_ended" });
  }
  await assertMayWrite(caller, env, { files: true });

  const declared = Number(file.declared_size_bytes);
  if (file.upload_mode === "multipart") await assembleMultipart(env, share.id, file, declared);
  const stored = await headObject(env, file.object_key);
  if (stored === null) throw new ApiError(409, "UPLOAD_INCOMPLETE", "The file has not been uploaded yet");
  const size = stored.size;
  if (size !== declared) await rejectUpload(share.id, file.id, "size_mismatch");
  // Storage keeps headers the signature didn't cover (for example Content-Encoding: gzip,
  // which browsers would undo on download). Only the signed set is acceptable.
  const expected = uploadHeaders(file.original_name, file.stored_content_type);
  if (
    stored.contentType !== expected["content-type"] ||
    stored.contentDisposition !== expected["content-disposition"] ||
    stored.cacheControl !== expected["cache-control"] ||
    (stored.contentEncoding !== null && stored.contentEncoding !== "")
  ) {
    await rejectUpload(share.id, file.id, "metadata_mismatch");
  }

  const sniffed = sniff(await readObjectHead(env, file.object_key, SNIFF_BYTES));
  const flags = riskFlags({ name: file.original_name, extension: file.extension }, sniffed);
  // A link-only share must stay shareable by link: content that a link may not carry (an
  // executable under a harmless name, for example) fails the upload (T-035).
  if (share.scope === "link_only" && !remoteFilePolicy(flags, readSnapshot(share.entitlementSnapshot)).allowed) {
    await rejectUpload(share.id, file.id, "remote_file_blocked");
  }
  // Previews only when the stored type is a raster image and the bytes really are one (03 §6);
  // never for burn-after-download shares (phase 3 §17.8.8).
  const previewable = !share.burnAfterDownload && sniffed.rasterImage && isPreviewType(file.stored_content_type);

  await db.transaction().execute(async (trx) => {
    // Lock order everywhere: share, then file, then the storage ledger (no deadlocks with end_share).
    const lockedShare = await trx
      .selectFrom("app.shares")
      .select(["status", sql<boolean>`expires_at > now()`.as("live")])
      .where("id", "=", share.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const locked = await trx
      .selectFrom("app.files")
      .select(["upload_status", sql<boolean>`upload_expires_at > now()`.as("in_time")])
      .where("id", "=", file.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (locked.upload_status !== "pending") return; // a concurrent completion finished first
    // Deleted, failed or expired shares never come back, even before the jobs have run.
    if (lockedShare.status !== "pending_upload" || !lockedShare.live) {
      throw new ApiError(422, "UPLOAD_REJECTED", "The upload was rejected", { reason: "share_ended" });
    }
    if (!locked.in_time) throw new ApiError(409, "UPLOAD_EXPIRED", "The upload took too long; start again");

    const reservation = await trx
      .selectFrom("app.storage_reservations")
      .select("id")
      .where("file_id", "=", file.id)
      .where("status", "=", "active")
      .executeTakeFirst();
    const committed = reservation
      ? (await sql<{ ok: boolean }>`select app.commit_reservation(${reservation.id}::uuid, ${size}::bigint) as ok`.execute(trx)).rows[0]?.ok
      : false;
    if (!committed) throw new ApiError(409, "UPLOAD_EXPIRED", "The upload took too long; start again");

    await trx
      .updateTable("app.files")
      .set({
        upload_status: "verified",
        size_bytes: String(size),
        detected_mime: sniffed.mime,
        preview_kind: previewable ? "image" : "none",
        risk_flags: flags,
        verified_at: sql`now()`,
      })
      .where("id", "=", file.id)
      .execute();

    const pending = await trx
      .selectFrom("app.files")
      .select(sql<number>`count(*)::int`.as("n"))
      .where("share_id", "=", share.id)
      .where("upload_status", "=", "pending")
      .executeTakeFirstOrThrow();
    if (pending.n === 0) {
      await trx
        .updateTable("app.shares")
        .set({ status: "active", updated_at: sql`now()` })
        .where("id", "=", share.id)
        .where("status", "=", "pending_upload")
        .execute();
      if (share.networkSpaceId) {
        await trx.updateTable("app.network_spaces").set({ last_share_at: sql`now()` }).where("id", "=", share.networkSpaceId).execute();
      }
    }
  });

  return loadShareDto(db, share.id, caller.principal.userId, caller.device.id);
}
