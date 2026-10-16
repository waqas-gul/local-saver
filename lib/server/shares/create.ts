import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { z } from "zod";
import type { createFileShareBody, ShareDto, UploadTarget } from "@/lib/shared/api/schemas";
import { audit } from "../audit/log";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import { resolveEntitlements } from "../entitlements/plans";
import type { Env } from "../env";
import { ApiError } from "../http/errors";
import type { NetworkView } from "../network/current";
import { postingTarget } from "../policy/posting";
import { enforceDailyVolume, enforceRateLimit } from "../ratelimit/limits";
import { contentDisposition } from "../security/content-disposition";
import { assertRemoteAllowed } from "../security/file-policy";
import { riskFlags } from "../security/file-risk";
import { sanitizeFilename } from "../security/filenames";
import { objectKey, storedContentType } from "../storage/keys";
import { presignPut, UPLOAD_URL_TTL_SECONDS, type UploadHeaders } from "../storage/s3";
import { burnSnapshot } from "./burn";
import { loadShareDto } from "./dto";
import { resolveExpiry } from "./expiry";

/**
 * Upload init (04 §8.5, 02 §4.3): validate, reserve storage per file, insert the share as
 * pending_upload, and return one presigned PUT per file with the headers that are signed.
 * Single PUT only (≤ 100 MB, DEC-026). The destination is this network or Link only (DEC-033);
 * link-only files must pass the remote file policy, by name here and by content at completion.
 * burnAfterDownload is entitlement-gated (phase 3 §17.10, Q-008); the snapshot records the grant.
 */

const UPLOAD_DEADLINE = "2 hours"; // completion deadline (04 §7.2)
const RESERVATION_TTL = "3 hours"; // outlives the deadline; stale ones are released by a job
const IDEMPOTENCY_ENDPOINT = "POST /api/v1/shares";
const NO_CONTENT_SIGNALS = { executable: false, script: false, archive: false };

export type CreateFileShareResult = { share: ShareDto; uploads: UploadTarget[] };

export function uploadHeaders(name: string, declaredType: string): UploadHeaders {
  return {
    "content-type": storedContentType(declaredType),
    "content-disposition": contentDisposition(name),
    "cache-control": "private, no-cache",
    "if-none-match": "*",
  };
}

type IssuedUpload = {
  id: string;
  position: number;
  object_key: string;
  original_name: string;
  stored_content_type: string;
  declared_size_bytes: string;
  ttl_seconds: number;
  expires_at: Date;
};

/**
 * Presigned PUTs for the share's files that still await their bytes, in the order listed.
 * Each URL's expiry is recorded before it is handed out (storage deletion holds the key until
 * then, review M1), and no URL outlives the upload deadline or the share. The update and
 * end_share lock the same file rows, so a URL is never issued for a share that has ended.
 */
async function uploadTargets(env: Env, shareId: string): Promise<UploadTarget[]> {
  const { rows } = await sql<IssuedUpload>`
    with issue as (
      select f.id, least(now() + make_interval(secs => ${UPLOAD_URL_TTL_SECONDS}), f.upload_expires_at, s.expires_at) as expires_at
        from app.files f
        join app.shares s on s.id = f.share_id
       where f.share_id = ${shareId}::uuid
         and f.upload_status = 'pending'
         and s.status = 'pending_upload'
         and f.upload_expires_at > now() + interval '1 second'
         and s.expires_at > now() + interval '1 second'
    )
    update app.files f
       set upload_url_expires_at = greatest(f.upload_url_expires_at, issue.expires_at)
      from issue
     where f.id = issue.id and f.upload_status = 'pending'
    returning f.id, f.position, f.object_key, f.original_name, f.stored_content_type, f.declared_size_bytes,
              floor(extract(epoch from issue.expires_at - now()))::integer as ttl_seconds, issue.expires_at
  `.execute(getDb());
  rows.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));

  return Promise.all(
    rows.map(async (file) => {
      const headers = uploadHeaders(file.original_name, file.stored_content_type);
      const size = Number(file.declared_size_bytes);
      return {
        fileId: file.id,
        name: file.original_name,
        sizeBytes: size,
        url: await presignPut(env, file.object_key, headers, size, file.ttl_seconds),
        method: "PUT" as const,
        headers,
        expiresAt: new Date(file.expires_at).toISOString(),
      };
    }),
  );
}

function idempotencyHash(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

export function readIdempotencyKey(request: Request): string | null {
  const key = request.headers.get("idempotency-key");
  if (key === null) return null;
  if (key.length < 1 || key.length > 200) throw new ApiError(400, "INVALID_IDEMPOTENCY_KEY", "Invalid Idempotency-Key");
  return key;
}

async function replay(caller: Caller, env: Env, keyHash: Buffer): Promise<CreateFileShareResult | null> {
  const stored = await getDb()
    .selectFrom("app.idempotency_keys")
    .select("response")
    .where("user_id", "=", caller.principal.userId)
    .where("endpoint", "=", IDEMPOTENCY_ENDPOINT)
    .where("key_hash", "=", keyHash)
    .where(sql<boolean>`expires_at > now()`)
    .executeTakeFirst();
  const shareId = (stored?.response as { shareId?: string } | undefined)?.shareId;
  if (!shareId) return null;
  // Presigned URLs are never stored; a replay gets fresh ones for files still pending.
  return { share: await loadShareDto(getDb(), shareId, caller.principal.userId, caller.device.id), uploads: await uploadTargets(env, shareId) };
}

export async function createFileShare(
  caller: Caller,
  network: NetworkView,
  body: z.infer<typeof createFileShareBody>,
  env: Env,
  idempotencyKey: string | null,
  request: Request,
): Promise<CreateFileShareResult> {
  // Posting rules first: a replay must not hand out upload URLs once posting is refused.
  const { spaceId, networkLimitKey } = await postingTarget(caller, network, request, env, {
    files: true,
    destination: body.destination,
  });
  const keyHash = idempotencyKey ? idempotencyHash(idempotencyKey) : null;
  if (keyHash) {
    const previous = await replay(caller, env, keyHash);
    if (previous) return previous;
  }

  const entitlements = resolveEntitlements(caller.principal);
  const snapshot = await burnSnapshot(entitlements, env, body.burnAfterDownload);
  const burn = body.burnAfterDownload === true;
  const { limits } = entitlements;
  if (body.files.length > limits.maxFilesPerShare) {
    throw new ApiError(413, "TOO_MANY_FILES", "Too many files in one share", { maxFiles: limits.maxFilesPerShare });
  }
  if (body.files.some((f) => f.size > limits.maxFileBytes)) {
    throw new ApiError(413, "FILE_TOO_LARGE", "A file is larger than the limit", { maxFileBytes: limits.maxFileBytes });
  }
  const expiry = resolveExpiry(entitlements, body.expiresIn);
  const totalBytes = body.files.reduce((sum, f) => sum + f.size, 0);

  const now = new Date();
  const files = body.files.map((f) => {
    const id = randomUUID();
    const { name, extension } = sanitizeFilename(f.name);
    return {
      id,
      name,
      extension,
      size: f.size,
      declaredType: f.type.trim().toLowerCase() || "application/octet-stream",
      key: objectKey(expiry.retentionClass, now, id),
      flags: riskFlags({ name, extension }, NO_CONTENT_SIGNALS),
    };
  });
  // A link-only share exists to be sent by link: refuse what a link may not carry (T-035).
  if (body.destination === "link_only") assertRemoteAllowed(files.map((f) => ({ riskFlags: f.flags })), entitlements);

  await enforceRateLimit("createShare", caller.principal.userId);
  await enforceDailyVolume(`user:${caller.principal.userId}`, totalBytes, limits.dailyUploadBytes);
  await enforceDailyVolume(`net:${networkLimitKey}`, totalBytes, limits.dailyUploadBytesPerNetwork);

  let shareId: string;
  try {
    shareId = await getDb().transaction().execute(async (trx) => {
      const share = await trx
        .insertInto("app.shares")
        .values({
          scope: body.destination,
          network_space_id: spaceId,
          kind: "files",
          created_by_user_id: caller.principal.userId,
          created_by_device_id: caller.device.id,
          billing_subject_type: "user",
          billing_subject_id: caller.principal.userId,
          status: "pending_upload",
          retention_class: expiry.retentionClass,
          expires_at: sql<Date>`now() + make_interval(secs => ${expiry.seconds})`,
          file_count: files.length,
          total_bytes: String(totalBytes),
          burn_after_download: burn,
          entitlement_snapshot: JSON.stringify(snapshot),
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      for (const [position, file] of files.entries()) {
        await trx
          .insertInto("app.files")
          .values({
            id: file.id,
            share_id: share.id,
            position,
            network_space_id: spaceId,
            object_key: file.key,
            original_name: file.name,
            extension: file.extension,
            declared_mime: file.declaredType,
            stored_content_type: storedContentType(file.declaredType),
            declared_size_bytes: String(file.size),
            upload_expires_at: sql<Date>`now() + ${UPLOAD_DEADLINE}::interval`,
            risk_flags: file.flags,
          })
          .execute();
        const { rows } = await sql<{ id: string | null }>`
          select app.reserve_storage('user', ${caller.principal.userId}::uuid, ${file.id}::uuid,
                                     ${file.size}::bigint, ${limits.activeStorageBytes}::bigint,
                                     ${RESERVATION_TTL}::interval) as id
        `.execute(trx);
        if (!rows[0]?.id) {
          const usage = await trx
            .selectFrom("app.storage_usage")
            .select(sql<string>`bytes_committed + bytes_reserved`.as("used"))
            .where("subject_type", "=", "user")
            .where("subject_id", "=", caller.principal.userId)
            .executeTakeFirst();
          throw new ApiError(409, "STORAGE_QUOTA_EXCEEDED", "Not enough storage left", {
            usedBytes: Number(usage?.used ?? 0),
            quotaBytes: limits.activeStorageBytes,
          });
        }
      }

      await audit(trx, {
        action: "share.created",
        actorUserId: caller.principal.userId,
        actorDeviceId: caller.device.id,
        networkSpaceId: spaceId,
        targetType: "share",
        targetId: share.id,
        metadata: { kind: "files", scope: body.destination, fileCount: files.length, totalBytes, ...(burn ? { burn } : {}) },
      });
      if (keyHash) {
        await trx
          .insertInto("app.idempotency_keys")
          .values({
            user_id: caller.principal.userId,
            endpoint: IDEMPOTENCY_ENDPOINT,
            key_hash: keyHash,
            response: JSON.stringify({ shareId: share.id }),
          })
          .execute();
      }
      return share.id;
    });
  } catch (error) {
    // A concurrent request with the same Idempotency-Key won the race: return its share.
    if (keyHash && (error as { code?: string }).code === "23505") {
      const previous = await replay(caller, env, keyHash);
      if (previous) return previous;
    }
    throw error;
  }

  return {
    share: await loadShareDto(getDb(), shareId, caller.principal.userId, caller.device.id),
    uploads: await uploadTargets(env, shareId),
  };
}
