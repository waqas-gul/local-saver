import "server-only";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getR2Config, type R2Config } from "../config/integrations";
import type { Env } from "../env";
import { isValidObjectKey } from "./keys";

/**
 * Cloudflare R2 over the S3 API (DEC-009). Locally and in CI the same code talks to RustFS
 * (DV1-4). Presigning is a local SigV4 computation; HEAD and ranged GET are real calls. The web
 * tier never deletes or overwrites objects: the storage janitor does (phase 3, D-1).
 */

export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 60;
export const PREVIEW_URL_TTL_SECONDS = 300;

/**
 * Headers fixed at upload and part of the PUT signature (04 §8.4). `if-none-match: *` makes
 * the object write-once: once verified, it can't be replaced through its upload URL.
 */
export type UploadHeaders = {
  "content-type": string;
  "content-disposition": string;
  "cache-control": string;
  "if-none-match": "*";
};

/** What storage reports about an object; compared with the signed headers at completion. */
export type StoredObject = {
  size: number;
  contentType: string | null;
  contentDisposition: string | null;
  cacheControl: string | null;
  contentEncoding: string | null;
};

let client: { s3: S3Client; config: R2Config } | undefined;

/** The one S3 client and its bucket (the multipart calls in multipart.ts share it). */
export function storage(env: Env): { s3: S3Client; config: R2Config } {
  if (!client) {
    const config = getR2Config(env);
    client = {
      config,
      s3: new S3Client({
        region: "auto",
        endpoint: config.endpoint,
        forcePathStyle: true,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        // Default request checksums add headers a presigned PUT can't carry (R2 and RustFS).
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      }),
    };
  }
  return client;
}

export function assertKey(key: string): void {
  if (!isValidObjectKey(key)) throw new Error("invalid object key");
}

/**
 * Presigned PUT with the headers in `headers` and the exact Content-Length signed: storage
 * refuses a body of any other size (RISK-010). Browsers set Content-Length themselves, so it
 * is signed but not part of the headers the client is told to send. Completion still checks
 * the size, in case a storage provider ignores the signed length (SP-02). The caller records
 * the URL's expiry first; `ttlSeconds` is at most UPLOAD_URL_TTL_SECONDS.
 */
export async function presignPut(
  env: Env,
  key: string,
  headers: UploadHeaders,
  contentLength: number,
  ttlSeconds: number,
): Promise<string> {
  assertKey(key);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > UPLOAD_URL_TTL_SECONDS) {
    throw new RangeError("invalid upload URL lifetime");
  }
  const { s3, config } = storage(env);
  return getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      ContentType: headers["content-type"],
      ContentDisposition: headers["content-disposition"],
      CacheControl: headers["cache-control"],
      IfNoneMatch: headers["if-none-match"],
      ContentLength: contentLength,
    }),
    { expiresIn: ttlSeconds, signableHeaders: new Set([...Object.keys(headers), "content-length"]) },
  );
}

export async function presignGet(env: Env, key: string, ttlSeconds: number): Promise<string> {
  assertKey(key);
  const { s3, config } = storage(env);
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: config.bucket, Key: key }), { expiresIn: ttlSeconds });
}

/** Size and stored headers, or null when the object does not exist (yet). */
export async function headObject(env: Env, key: string): Promise<StoredObject | null> {
  assertKey(key);
  const { s3, config } = storage(env);
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    if (head.ContentLength === undefined) return null;
    return {
      size: head.ContentLength,
      contentType: head.ContentType ?? null,
      contentDisposition: head.ContentDisposition ?? null,
      cacheControl: head.CacheControl ?? null,
      contentEncoding: head.ContentEncoding ?? null,
    };
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (error as Error).name === "NotFound") return null;
    throw error;
  }
}

/** The first `bytes` bytes of an object (ranged GET) for magic-byte detection. */
export async function readObjectHead(env: Env, key: string, bytes: number): Promise<Uint8Array> {
  assertKey(key);
  const { s3, config } = storage(env);
  const object = await s3.send(
    new GetObjectCommand({ Bucket: config.bucket, Key: key, Range: `bytes=0-${Math.max(0, bytes - 1)}` }),
  );
  return object.Body ? await object.Body.transformToByteArray() : new Uint8Array();
}
