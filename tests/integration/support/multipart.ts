import { createHash } from "node:crypto";
import { GetObjectCommand, ListMultipartUploadsCommand, ListPartsCommand, S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { adminDb, type Device, stack } from "./api";

/**
 * Multipart fixtures (phase 4 §17.8.1, P4-14). Files just above one PUT's 100 MiB go up in 16 MiB parts:
 * 100 MiB + 1 byte is 7 parts, the last 4 MiB + 1 byte. Each part's bytes are a fixed fill, so a test can
 * check what storage assembled without keeping the whole file in memory.
 */

export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;
export const PART = 16 * MIB;
export const BIG = 100 * MIB + 1;
export const BIG_PARTS = 7;

export function partSize(partNumber: number, size = BIG): number {
  return Math.min(PART, size - (partNumber - 1) * PART);
}

/** Part `n`'s bytes: `n` repeated (or `fill`). */
export function partBytes(partNumber: number, size = BIG, fill = partNumber): Buffer<ArrayBuffer> {
  return Buffer.alloc(partSize(partNumber, size), fill % 256);
}

/** SHA-256 of the whole file partBytes describes. */
export function expectedSha256(size = BIG): string {
  const hash = createHash("sha256");
  for (let n = 1; (n - 1) * PART < size; n++) hash.update(partBytes(n, size));
  return hash.digest("hex");
}

export const all = (count = BIG_PARTS) => Array.from({ length: count }, (_, i) => i + 1);

export function filePath(shareId: string, fileId: string): string {
  return `/api/v1/shares/${shareId}/files/${fileId}`;
}

/** Init a share of one big file (and any extra small ones). */
export async function startBig(device: Device, size = BIG, extra: { files?: { name: string; size: number }[]; expiresIn?: number } = {}) {
  const init = await device.call("POST", "/api/v1/shares", {
    destination: "network",
    ...(extra.expiresIn ? { expiresIn: extra.expiresIn } : {}),
    files: [{ name: "big.bin", size, type: "application/octet-stream" }, ...(extra.files ?? []).map((f) => ({ ...f, type: "text/plain" }))],
  });
  const target = init.body?.uploads?.[0];
  return { init, shareId: init.body?.share?.id as string, fileId: target?.fileId as string, target };
}

export function partUrls(device: Device, shareId: string, fileId: string, partNumbers: number[]) {
  return device.call("POST", `${filePath(shareId, fileId)}/multipart/parts`, { partNumbers });
}

/** PUT bytes to a part URL as a browser would (fetch sets Content-Length from the body). */
export async function putPart(url: string, bytes: Uint8Array<ArrayBuffer>): Promise<{ status: number; code: string | null }> {
  const response = await fetch(url, { method: "PUT", body: bytes });
  const text = await response.text();
  return { status: response.status, code: /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? null };
}

/** Upload these parts through the API's URLs (20 per request), with partBytes' content. */
export async function uploadParts(device: Device, shareId: string, fileId: string, partNumbers: number[], size = BIG): Promise<void> {
  for (let i = 0; i < partNumbers.length; i += 20) {
    const batch = partNumbers.slice(i, i + 20);
    const response = await partUrls(device, shareId, fileId, batch);
    if (response.status !== 200) throw new Error(`part URLs: ${response.status} ${response.text}`);
    for (const part of response.body.parts as { partNumber: number; url: string }[]) {
      const put = await putPart(part.url, partBytes(part.partNumber, size));
      if (put.status !== 200) throw new Error(`part ${part.partNumber}: ${put.status} ${put.code}`);
    }
  }
}

export function complete(device: Device, shareId: string, fileId: string, body: unknown = {}) {
  return device.call("POST", `${filePath(shareId, fileId)}/complete`, body);
}

export function s3(): S3Client {
  const { endpoint, accessKeyId, secretAccessKey } = stack().storage;
  return new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

export async function fileRow(fileId: string) {
  const { rows } = await adminDb().query(
    `select object_key, upload_mode, multipart_upload_id, part_size_bytes::bigint as part_size, part_count, upload_status, rejection_reason,
            upload_expires_at, upload_url_expires_at, extract(epoch from upload_expires_at - now())::int as deadline_seconds
       from app.files where id = $1`,
    [fileId],
  );
  return rows[0] as {
    object_key: string;
    upload_mode: string;
    multipart_upload_id: string | null;
    part_size: string | null;
    part_count: number | null;
    upload_status: string;
    rejection_reason: string | null;
    upload_expires_at: Date;
    upload_url_expires_at: Date | null;
    deadline_seconds: number;
  };
}

/** The storage's own part list, or "gone" once the upload was completed or aborted. */
export async function storedParts(key: string, uploadId: string): Promise<{ partNumber: number; size: number }[] | "gone"> {
  try {
    const result = await s3().send(new ListPartsCommand({ Bucket: stack().storage.bucket, Key: key, UploadId: uploadId }));
    return (result.Parts ?? []).map((p) => ({ partNumber: p.PartNumber ?? 0, size: p.Size ?? 0 }));
  } catch (error) {
    if ((error as Error).name === "NoSuchUpload" || (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return "gone";
    throw error;
  }
}

export async function openUploads(): Promise<{ key: string; uploadId: string }[]> {
  const result = await s3().send(new ListMultipartUploadsCommand({ Bucket: stack().storage.bucket }));
  return (result.Uploads ?? []).map((u) => ({ key: u.Key ?? "", uploadId: u.UploadId ?? "" }));
}

/** A part written straight to storage, bypassing the signed size (as a lax storage might allow). */
export async function rawPart(key: string, uploadId: string, partNumber: number, bytes: Uint8Array): Promise<void> {
  await s3().send(new UploadPartCommand({ Bucket: stack().storage.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: bytes, ContentLength: bytes.length }));
}

export async function objectSha256(key: string): Promise<{ size: number; sha256: string }> {
  const object = await s3().send(new GetObjectCommand({ Bucket: stack().storage.bucket, Key: key }));
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: hash.digest("hex") };
}

export async function storageUsage(userId: string): Promise<{ committed: number; reserved: number; files: number }> {
  const { rows } = await adminDb().query(
    "select bytes_committed, bytes_reserved, files_committed from app.storage_usage where subject_type = 'user' and subject_id = $1",
    [userId],
  );
  return { committed: Number(rows[0]?.bytes_committed ?? 0), reserved: Number(rows[0]?.bytes_reserved ?? 0), files: Number(rows[0]?.files_committed ?? 0) };
}

export async function outbox(fileId: string) {
  const { rows } = await adminDb().query(
    "select reason, multipart_upload_id, completed_at from app.object_deletions where source_file_id = $1 order by id",
    [fileId],
  );
  return rows as { reason: string; multipart_upload_id: string | null; completed_at: Date | null }[];
}
