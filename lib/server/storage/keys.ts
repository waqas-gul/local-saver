import "server-only";

/**
 * Object keys and stored headers (DEC-010, 04 §8.3–§8.4).
 * Keys: {retentionClass}/{yyyy}/{mm}/{dd}/{fileId}. No filename, user or network in keys.
 */

export type RetentionClass = "d7" | "d30" | "d90";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OBJECT_KEY = /^(d7|d30|d90|ws)\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = 86_400;

/** Preview-safe raster types (03 §6): the only declared types an object keeps. */
const PREVIEW_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);

export function objectKey(retentionClass: RetentionClass, uploadedAt: Date, fileId: string): string {
  if (!UUID.test(fileId)) throw new Error("file IDs must be lowercase UUIDs");
  const yyyy = uploadedAt.getUTCFullYear().toString().padStart(4, "0");
  const mm = (uploadedAt.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = uploadedAt.getUTCDate().toString().padStart(2, "0");
  return `${retentionClass}/${yyyy}/${mm}/${dd}/${fileId}`;
}

export function isValidObjectKey(key: string): boolean {
  return OBJECT_KEY.test(key);
}

/** The smallest lifecycle class whose backstop outlives the share (04 §8.2). */
export function retentionClassFor(expiresInSeconds: number): RetentionClass {
  if (expiresInSeconds <= 7 * DAY) return "d7";
  if (expiresInSeconds <= 30 * DAY) return "d30";
  if (expiresInSeconds <= 90 * DAY) return "d90";
  throw new RangeError("expiry beyond 90 days needs the ws class");
}

export function isPreviewType(mime: string): boolean {
  return PREVIEW_TYPES.has(mime.trim().toLowerCase());
}

/** Content-Type stored on the object: the declared type for previewable images, else octet-stream. */
export function storedContentType(declaredMime: string): string {
  const mime = declaredMime.trim().toLowerCase();
  return PREVIEW_TYPES.has(mime) ? mime : "application/octet-stream";
}
