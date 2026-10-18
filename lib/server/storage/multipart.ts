import "server-only";
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListPartsCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { MULTIPART_MAX_PARTS, partRange } from "@/lib/shared/multipart";
import { SINGLE_PUT_MAX_BYTES } from "@/lib/shared/plans";
import type { Env } from "../env";
import { assertKey, storage, type UploadHeaders } from "./s3";

/**
 * Multipart uploads to R2 over the S3 API (phase 4 §17.8.1, DEC-026), for files above one PUT's 100 MiB.
 * The server fixes the part size and count at init and signs each part's exact Content-Length, so
 * storage refuses a part of any other size (RustFS and R2: SignatureDoesNotMatch, P4-00). Completion
 * uses the storage's own ListParts after checking every part (checkParts): the client never names
 * parts or ETags. R2 also needs all parts but the last to be equal; RustFS doesn't check that, so the
 * server does.
 *
 * The web tier never aborts an upload: aborting is destructive, so it goes through the outbox and the
 * storage janitor (D-1). Upload IDs are never logged; part URLs never leave the response that issues them.
 */

const MiB = 1024 * 1024;
/** The smallest part the server plans (04 §8.5); R2's own minimum is 5 MiB. */
export const MULTIPART_MIN_PART_BYTES = 16 * MiB;
/** Leaves room under R2's 10,000 parts. */
const TARGET_MAX_PARTS = 9000;
/** Part URLs live an hour, capped by the upload deadline and the share's expiry. */
export const PART_URL_TTL_SECONDS = 3600;
/** Part URLs per request (a 5 GiB file has 320 parts: 16 requests). */
export const PARTS_PER_REQUEST = 20;
const LIST_PAGE = 1000;

export type PartPlan = { partSize: number; partCount: number };

/** `max(16 MiB, ceil(size / 9,000))` rounded up to a whole MiB, and as many parts as that takes. */
export function partPlan(size: number): PartPlan {
  if (!Number.isSafeInteger(size) || size <= SINGLE_PUT_MAX_BYTES) throw new RangeError("not a multipart size");
  const partSize = Math.ceil(Math.max(MULTIPART_MIN_PART_BYTES, Math.ceil(size / TARGET_MAX_PARTS)) / MiB) * MiB;
  const partCount = Math.ceil(size / partSize);
  if (partCount > MULTIPART_MAX_PARTS) throw new RangeError("too many parts");
  return { partSize, partCount };
}

export type ListedPart = { partNumber: number; size: number; etag: string };

export type PartCheck =
  | { ok: true; parts: { partNumber: number; etag: string }[] }
  /** Parts not uploaded yet: the client can still send them. */
  | { ok: false; missing: number[] }
  /** Something no honest client can produce through its URLs: the file is rejected. */
  | { ok: false; invalid: "extra_part" | "duplicate_part" | "part_size" };

/**
 * The storage's part list against the plan: every number 1…N exactly once, each exactly its planned size
 * (so the sum is the declared size). Invalid beats missing: a lying client can't make a refusal look like
 * an upload still in progress.
 */
export function checkParts(listed: readonly ListedPart[], plan: PartPlan, size: number): PartCheck {
  const seen = new Set<number>();
  for (const part of listed) {
    if (!Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > plan.partCount) return { ok: false, invalid: "extra_part" };
    if (seen.has(part.partNumber)) return { ok: false, invalid: "duplicate_part" };
    seen.add(part.partNumber);
    if (part.size !== partRange(part.partNumber, plan.partSize, size).size) return { ok: false, invalid: "part_size" };
  }
  const missing: number[] = [];
  for (let n = 1; n <= plan.partCount; n++) if (!seen.has(n)) missing.push(n);
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    parts: [...listed].sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
  };
}

function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}

/** The upload doesn't exist (any more): completed, or aborted by the janitor or the lifecycle rule. */
function isNoSuchUpload(error: unknown): boolean {
  return (error as Error).name === "NoSuchUpload" || statusOf(error) === 404;
}

/**
 * CreateMultipartUpload with the headers a single PUT signs (04 §8.4): storage keeps them on the object,
 * and completion checks them as for a single PUT. If-None-Match has no place here: no one but the server
 * can complete the upload, and the key is new.
 */
export async function createMultipartUpload(env: Env, key: string, headers: UploadHeaders): Promise<string> {
  assertKey(key);
  const { s3, config } = storage(env);
  const result = await s3.send(
    new CreateMultipartUploadCommand({
      Bucket: config.bucket,
      Key: key,
      ContentType: headers["content-type"],
      ContentDisposition: headers["content-disposition"],
      CacheControl: headers["cache-control"],
    }),
  );
  if (!result.UploadId) throw new Error("storage returned no upload ID");
  return result.UploadId;
}

/** A presigned UploadPart for one part, with its exact Content-Length signed. */
export async function presignUploadPart(
  env: Env,
  key: string,
  uploadId: string,
  partNumber: number,
  contentLength: number,
  ttlSeconds: number,
): Promise<string> {
  assertKey(key);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > PART_URL_TTL_SECONDS) throw new RangeError("invalid part URL lifetime");
  const { s3, config } = storage(env);
  return getSignedUrl(
    s3,
    new UploadPartCommand({ Bucket: config.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, ContentLength: contentLength }),
    { expiresIn: ttlSeconds, signableHeaders: new Set(["content-length"]) },
  );
}

/** Every uploaded part (ListParts, paginated), or null when the upload no longer exists. */
export async function listParts(env: Env, key: string, uploadId: string): Promise<ListedPart[] | null> {
  assertKey(key);
  const { s3, config } = storage(env);
  const parts: ListedPart[] = [];
  let marker: string | undefined;
  // 10,000 parts at 1,000 a page, plus one page for an extra part a lying client might have added.
  for (let page = 0; page <= MULTIPART_MAX_PARTS / LIST_PAGE; page++) {
    let result;
    try {
      result = await s3.send(
        new ListPartsCommand({ Bucket: config.bucket, Key: key, UploadId: uploadId, MaxParts: LIST_PAGE, PartNumberMarker: marker }),
      );
    } catch (error) {
      if (isNoSuchUpload(error)) return null;
      throw error;
    }
    for (const part of result.Parts ?? []) {
      parts.push({ partNumber: part.PartNumber ?? 0, size: part.Size ?? -1, etag: part.ETag ?? "" });
    }
    if (!result.IsTruncated || !result.NextPartNumberMarker) return parts;
    marker = result.NextPartNumberMarker;
  }
  return parts;
}

/**
 * CompleteMultipartUpload with the parts checkParts returned. "gone": the upload no longer exists (a
 * concurrent completion finished it, or it was aborted); HeadObject decides. "changed": a part was
 * replaced since it was listed (another tab re-sent it); list and try again.
 */
export async function completeMultipartUpload(
  env: Env,
  key: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[],
): Promise<"completed" | "gone" | "changed"> {
  assertKey(key);
  const { s3, config } = storage(env);
  try {
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: config.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
    return "completed";
  } catch (error) {
    if (isNoSuchUpload(error)) return "gone";
    if ((error as Error).name === "InvalidPart") return "changed";
    throw error;
  }
}
