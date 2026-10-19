import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { z } from "zod";
import type { createFileShareBody, PutUploadTarget, ShareDto, UploadTarget } from "@/lib/shared/api/schemas";
import { SINGLE_PUT_MAX_BYTES } from "@/lib/shared/plans";
import { audit } from "../audit/log";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import { assertFileCount, assertFileSizes, assertNotDeletionPending, quotaExceeded } from "../entitlements/enforce";
import { resolveEntitlements } from "../entitlements/resolve";
import type { Entitlements } from "../entitlements/types";
import type { Env } from "../env";
import { ApiError, notFound } from "../http/errors";
import type { NetworkView } from "../network/current";
import { assertMayWrite, postingTarget, requestedExpiry } from "../policy/posting";
import { chargeDailyVolume, enforceRateLimit } from "../ratelimit/limits";
import { lockRoomForPosting } from "../rooms/access";
import { contentDisposition } from "../security/content-disposition";
import { assertRemoteAllowed } from "../security/file-policy";
import { riskFlags } from "../security/file-risk";
import { sanitizeFilename } from "../security/filenames";
import { objectKey, storedContentType } from "../storage/keys";
import { createMultipartUpload, partPlan, type PartPlan } from "../storage/multipart";
import { presignPut, UPLOAD_URL_TTL_SECONDS, type UploadHeaders } from "../storage/s3";
import { burnSnapshot } from "./burn";
import { loadShareDto } from "./dto";
import { resolveExpiry } from "./expiry";
import { loadOwnFile, uploadRefusal } from "./uploads";

/**
 * Upload init (04 §8.5, 02 §4.3): validate, reserve storage per file, insert the share as
 * pending_upload, and return an upload target per file. The destination is this network or Link only
 * (DEC-033); link-only files must pass the remote file policy, by name here and by content at
 * completion. burnAfterDownload is entitlement-gated (phase 3 §17.10, Q-008); the snapshot records
 * the grant.
 *
 * Phase 4 (§17.6.4): every limit is the caller's current plan (E1, E2, E5, E7, E28). The daily
 * volume is charged inside the creation transaction, after the storage reservations succeeded, so
 * a refused attempt costs nothing (E8, C4-6); end_share refunds it if the share never becomes
 * active. Pro volume isn't counted per network (E9, D4-10).
 *
 * Phase 4 (P4-14, §17.8.1): a file of up to 100 MiB gets a presigned PUT, as before (DEC-026); a larger
 * one (only a plan allowing it gets this far, E1/E25) a multipart upload, started here, whose parts the
 * client asks for in batches. A share with a multipart file has a 24-hour deadline for all its files,
 * since it completes all or nothing (DV1-10), and a 26-hour reservation. Its single files ask for a
 * fresh PUT URL just before their turn (upload-url, C4-13), as any client may.
 *
 * Phase 4 (P4-17): the destination may be a private room the caller is a member of (E23): scope 'room', its room,
 * no network space, the uploader's plan and quota. The transaction re-checks the membership under row locks, and
 * without an expiry in the request the room's default applies when the poster's plan offers it.
 */

const UPLOAD_DEADLINE = "2 hours"; // completion deadline (04 §7.2)
const RESERVATION_TTL = "3 hours"; // outlives the deadline; stale ones are released by a job
const MULTIPART_UPLOAD_DEADLINE = "24 hours"; // inside R2's 1-day abort rule (§17.15)
const MULTIPART_RESERVATION_TTL = "26 hours";
const IDEMPOTENCY_ENDPOINT = "POST /api/v1/shares";
const NO_CONTENT_SIGNALS = { executable: false, script: false, archive: false };
/** CreateMultipartUpload calls in flight at once (a share has at most 100 files). */
const MULTIPART_START_CONCURRENCY = 8;

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

type PendingMultipart = {
  id: string;
  position: number;
  original_name: string;
  declared_size_bytes: string;
  part_size_bytes: string;
  part_count: number;
  upload_expires_at: Date;
};

/**
 * Presigned PUTs for the share's single-PUT files that still await their bytes (or just `fileId`).
 * Each URL's expiry is recorded before it is handed out (storage deletion holds the key until
 * then, review M1), and no URL outlives the upload deadline or the share. The update and
 * end_share lock the same file rows, so a URL is never issued for a share that has ended.
 * A multipart file never gets a PUT URL: only the server can complete its upload.
 */
async function putTargets(env: Env, shareId: string, fileId: string | null = null): Promise<(PutUploadTarget & { position: number })[]> {
  const { rows } = await sql<IssuedUpload>`
    with issue as (
      select f.id, least(now() + make_interval(secs => ${UPLOAD_URL_TTL_SECONDS}), f.upload_expires_at, s.expires_at) as expires_at
        from app.files f
        join app.shares s on s.id = f.share_id
       where f.share_id = ${shareId}::uuid
         and (${fileId}::uuid is null or f.id = ${fileId}::uuid)
         and f.upload_status = 'pending'
         and f.upload_mode = 'single'
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

  return Promise.all(
    rows.map(async (file) => {
      const headers = uploadHeaders(file.original_name, file.stored_content_type);
      const size = Number(file.declared_size_bytes);
      return {
        position: file.position,
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

/** Upload targets for every file that still awaits its bytes, in the order listed. */
async function uploadTargets(env: Env, shareId: string): Promise<UploadTarget[]> {
  const multipart = await getDb()
    .selectFrom("app.files as f")
    .innerJoin("app.shares as s", "s.id", "f.share_id")
    .select(["f.id", "f.position", "f.original_name", "f.declared_size_bytes", "f.part_size_bytes", "f.part_count", "f.upload_expires_at"])
    .where("f.share_id", "=", shareId)
    .where("f.upload_status", "=", "pending")
    .where("f.upload_mode", "=", "multipart")
    .where("s.status", "=", "pending_upload")
    .where(sql<boolean>`f.upload_expires_at > now() + interval '1 second' and s.expires_at > now() + interval '1 second'`)
    .execute();
  const targets: (UploadTarget & { position: number })[] = [
    ...(await putTargets(env, shareId)),
    ...(multipart as PendingMultipart[]).map((file) => ({
      position: file.position,
      fileId: file.id,
      name: file.original_name,
      sizeBytes: Number(file.declared_size_bytes),
      method: "MULTIPART" as const,
      partSize: Number(file.part_size_bytes),
      partCount: file.part_count,
      expiresAt: new Date(file.upload_expires_at).toISOString(),
    })),
  ];
  targets.sort((a, b) => a.position - b.position || a.fileId.localeCompare(b.fileId));
  return targets.map(({ position: _position, ...target }) => target);
}

/**
 * POST …/files/{fileId}/upload-url (C4-13): a fresh PUT URL for one pending single-PUT file, just before
 * its turn, so a long batch never meets an expired URL. Posting must still be allowed (E29).
 */
export async function refreshUploadUrl(caller: Caller, network: NetworkView, shareId: string, fileId: string, env: Env): Promise<PutUploadTarget> {
  const { share, file } = await loadOwnFile(caller, network, shareId, fileId, { roomWrite: true });
  if (file.upload_mode !== "single") throw notFound();
  await enforceRateLimit("uploadUrl", caller.principal.userId);
  await assertMayWrite(caller, env, { files: true });
  const [target] = await putTargets(env, share.id, file.id);
  if (!target) throw await uploadRefusal(share.id, file.id);
  const { position: _position, ...upload } = target;
  return upload;
}

/**
 * Starts the multipart uploads of a share's large files, before the creation transaction: their upload
 * IDs belong in the file rows. Storage use is checked first, so the common refusal starts nothing; a
 * refusal by the transaction itself (a concurrent upload took the space, the daily volume) leaves empty
 * uploads behind (no parts, no stored bytes, IDs never handed out), which the janitor's reconciliation
 * and R2's 1-day rule abort. The web tier never aborts (D-1).
 */
async function startMultipartUploads(
  caller: Caller,
  entitlements: Entitlements,
  env: Env,
  files: { id: string; name: string; declaredType: string; key: string; multipart: PartPlan | null }[],
  totalBytes: number,
): Promise<Map<string, string>> {
  const usage = await getDb()
    .selectFrom("app.storage_usage")
    .select(sql<string>`bytes_committed + bytes_reserved`.as("used"))
    .where("subject_type", "=", "user")
    .where("subject_id", "=", caller.principal.userId)
    .executeTakeFirst();
  const used = Number(usage?.used ?? 0);
  if (used + totalBytes > entitlements.limits.activeStorageBytes) throw quotaExceeded(entitlements, used, totalBytes);

  const large = files.filter((f) => f.multipart !== null);
  const ids = new Map<string, string>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(MULTIPART_START_CONCURRENCY, large.length) }, async () => {
      while (next < large.length) {
        const file = large[next++] as (typeof large)[number];
        ids.set(file.id, await createMultipartUpload(env, file.key, uploadHeaders(file.name, storedContentType(file.declaredType))));
      }
    }),
  );
  return ids;
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
  const target = await postingTarget(caller, network, request, env, { files: true, destination: body.destination });
  const { spaceId, roomId, networkLimitKey } = target;
  const entitlements = await resolveEntitlements(caller.principal);
  // An account in its deletion grace is read-only (E30), replays included.
  assertNotDeletionPending(entitlements);
  const keyHash = idempotencyKey ? idempotencyHash(idempotencyKey) : null;
  if (keyHash) {
    const previous = await replay(caller, env, keyHash);
    if (previous) return previous;
  }

  const snapshot = await burnSnapshot(entitlements, env, body.burnAfterDownload);
  const burn = body.burnAfterDownload === true;
  const { limits } = entitlements;
  assertFileCount(entitlements, body.files.length);
  assertFileSizes(entitlements, body.files.map((f) => f.size));
  const expiry = resolveExpiry(entitlements, requestedExpiry(entitlements, target, body.expiresIn));
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
      // E25: above one PUT's size (and within the plan, E1 above), the file goes up in parts.
      multipart: f.size > SINGLE_PUT_MAX_BYTES ? partPlan(f.size) : null,
    };
  });
  // A link-only share exists to be sent by link: refuse what a link may not carry (T-035).
  if (target.scope === "link_only") assertRemoteAllowed(files.map((f) => ({ riskFlags: f.flags })), entitlements);
  const multipartCount = files.filter((f) => f.multipart !== null).length;
  const deadline = multipartCount > 0 ? MULTIPART_UPLOAD_DEADLINE : UPLOAD_DEADLINE;
  const reservationTtl = multipartCount > 0 ? MULTIPART_RESERVATION_TTL : RESERVATION_TTL;

  await enforceRateLimit("createShare", caller.principal.userId, limits.rateLimits.createShare);
  const uploadIds = multipartCount > 0 ? await startMultipartUploads(caller, entitlements, env, files, totalBytes) : new Map<string, string>();

  let shareId: string;
  try {
    shareId = await getDb().transaction().execute(async (trx) => {
      if (roomId) await lockRoomForPosting(trx, roomId, caller.principal.userId);
      const share = await trx
        .insertInto("app.shares")
        .values({
          scope: target.scope,
          network_space_id: spaceId,
          room_id: roomId,
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

      let reserved = 0;
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
            upload_expires_at: sql<Date>`now() + ${deadline}::interval`,
            risk_flags: file.flags,
            ...(file.multipart
              ? {
                  upload_mode: "multipart",
                  multipart_upload_id: uploadIds.get(file.id) ?? null,
                  part_size_bytes: file.multipart.partSize,
                  part_count: file.multipart.partCount,
                }
              : {}),
          })
          .execute();
        const { rows } = await sql<{ id: string | null }>`
          select app.reserve_storage('user', ${caller.principal.userId}::uuid, ${file.id}::uuid,
                                     ${file.size}::bigint, ${limits.activeStorageBytes}::bigint,
                                     ${reservationTtl}::interval) as id
        `.execute(trx);
        if (!rows[0]?.id) {
          const usage = await trx
            .selectFrom("app.storage_usage")
            .select(sql<string>`bytes_committed + bytes_reserved`.as("used"))
            .where("subject_type", "=", "user")
            .where("subject_id", "=", caller.principal.userId)
            .executeTakeFirst();
          // What was in use before this share (its own earlier files roll back with it).
          throw quotaExceeded(entitlements, Number(usage?.used ?? 0) - reserved, totalBytes);
        }
        reserved += file.size;
      }

      // Only now, with the storage reserved, is the day's volume charged; a 429 rolls it all back.
      await chargeDailyVolume(trx, {
        shareId: share.id,
        userId: caller.principal.userId,
        networkKey: limits.dailyUploadBytesPerNetwork === null ? null : networkLimitKey,
        bytes: totalBytes,
        userLimitBytes: limits.dailyUploadBytes,
        networkLimitBytes: limits.dailyUploadBytesPerNetwork,
      });

      await audit(trx, {
        action: "share.created",
        actorUserId: caller.principal.userId,
        actorDeviceId: caller.device.id,
        networkSpaceId: spaceId,
        targetType: "share",
        targetId: share.id,
        metadata: {
          kind: "files",
          scope: target.scope,
          ...(roomId ? { roomId } : {}),
          fileCount: files.length,
          totalBytes,
          ...(burn ? { burn } : {}),
          ...(multipartCount > 0 ? { multipartFiles: multipartCount } : {}),
        },
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
