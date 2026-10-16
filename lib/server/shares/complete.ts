import "server-only";
import { sql } from "kysely";
import type { ShareDto } from "@/lib/shared/api/schemas";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import type { Env } from "../env";
import { ApiError, notFound } from "../http/errors";
import type { NetworkView } from "../network/current";
import type { Entitlements } from "../entitlements/plans";
import { enforceRateLimit } from "../ratelimit/limits";
import { remoteFilePolicy } from "../security/file-policy";
import { riskFlags } from "../security/file-risk";
import { isPreviewType } from "../storage/keys";
import { headObject, readObjectHead } from "../storage/s3";
import { uploadHeaders } from "./create";
import { SNIFF_BYTES, sniff } from "../storage/sniff";
import { loadShareDto } from "./dto";
import { isUuid, requireOwnShare } from "./read";

/**
 * Upload completion (04 §8.5, 03 §7.3): HeadObject must show exactly the declared size,
 * then the first 4,100 bytes are sniffed. Anything else rejects the file, queues the object
 * for deletion, releases the reservation and fails the share (all-or-nothing, DV1-10). The
 * storage janitor deletes the queued objects (phase 3, D-1).
 */

async function rejectUpload(shareId: string, fileId: string, reason: string): Promise<never> {
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
  throw new ApiError(422, "UPLOAD_REJECTED", "The upload was rejected", { reason });
}

export async function completeFile(
  caller: Caller,
  network: NetworkView,
  shareId: string,
  fileId: string,
  env: Env,
): Promise<ShareDto> {
  if (!isUuid(fileId)) throw notFound();
  const share = await requireOwnShare(caller, network, shareId);
  const db = getDb();
  const file = await db
    .selectFrom("app.files")
    .select(["id", "object_key", "original_name", "extension", "declared_size_bytes", "stored_content_type", "upload_status", "rejection_reason"])
    .where("id", "=", fileId)
    .where("share_id", "=", share.id)
    .executeTakeFirst();
  if (!file) throw notFound();
  await enforceRateLimit("completeUpload", caller.principal.userId);

  if (file.upload_status === "verified") return loadShareDto(db, share.id, caller.principal.userId, caller.device.id);
  if (file.upload_status !== "pending" || share.status !== "pending_upload") {
    throw new ApiError(422, "UPLOAD_REJECTED", "The upload was rejected", { reason: file.rejection_reason ?? "share_ended" });
  }

  const declared = Number(file.declared_size_bytes);
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
  if (share.scope === "link_only" && !remoteFilePolicy(flags, share.entitlementSnapshot as Partial<Entitlements>).allowed) {
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
