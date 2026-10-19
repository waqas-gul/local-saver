import "server-only";
import { sql } from "kysely";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import { ApiError, notFound } from "../http/errors";
import type { NetworkView } from "../network/current";
import { isUuid, requireOwnShare, type VisibleShare } from "./read";

/**
 * The creator's view of one file of their share while it uploads (complete, upload-url and the multipart
 * routes, phase 4 §17.8.1). Another user's share is 404 or 403 NOT_CREATOR (requireOwnShare); a file
 * of another share is 404, the same as one that doesn't exist. Phase 4 (P4-17): `roomWrite` (finishing the upload,
 * new URLs) also needs a room share's creator still in its room; status and cancelling don't.
 */

export async function loadOwnFile(caller: Caller, network: NetworkView, shareId: string, fileId: string, options: { roomWrite?: boolean } = {}) {
  if (!isUuid(fileId)) throw notFound();
  const share: VisibleShare = await requireOwnShare(caller, network, shareId, options);
  const file = await getDb()
    .selectFrom("app.files")
    .select([
      "id", "object_key", "original_name", "extension", "declared_size_bytes", "stored_content_type", "upload_status",
      "rejection_reason", "upload_mode", "multipart_upload_id", "part_size_bytes", "part_count", "upload_expires_at",
      sql<boolean>`upload_expires_at > now()`.as("in_time"),
    ])
    .where("id", "=", fileId)
    .where("share_id", "=", share.id)
    .executeTakeFirst();
  if (!file) throw notFound();
  return { share, file };
}

export type OwnFile = Awaited<ReturnType<typeof loadOwnFile>>["file"];

/** Why no upload URL can be issued for this file now (read after the issuing update matched nothing). */
export async function uploadRefusal(shareId: string, fileId: string): Promise<ApiError> {
  const row = await getDb()
    .selectFrom("app.files as f")
    .innerJoin("app.shares as s", "s.id", "f.share_id")
    .select([
      "f.upload_status", "f.rejection_reason", "s.status",
      sql<boolean>`s.expires_at > now() + interval '1 second'`.as("live"),
    ])
    .where("f.id", "=", fileId)
    .where("f.share_id", "=", shareId)
    .executeTakeFirst();
  if (!row) return notFound();
  if (row.upload_status === "verified") return uploadComplete();
  if (row.upload_status !== "pending" || row.status !== "pending_upload" || !row.live) {
    return new ApiError(422, "UPLOAD_REJECTED", "The upload was rejected", { reason: row.rejection_reason ?? "share_ended" });
  }
  return new ApiError(409, "UPLOAD_EXPIRED", "The upload took too long; start again");
}

export function uploadComplete(): ApiError {
  return new ApiError(409, "UPLOAD_COMPLETE", "This file has already been uploaded");
}
