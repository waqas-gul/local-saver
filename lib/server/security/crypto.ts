import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** HMAC-SHA256 of a UTF-8 message. Used for network keys, link secrets and codes (DEC-013, DEC-032). */
export function hmacSha256(key: string | Buffer, message: string): Buffer {
  return createHmac("sha256", key).update(message, "utf8").digest();
}

/**
 * Constant-time string comparison. Both sides are hashed first so that the
 * comparison takes the same time whatever the lengths. Empty strings never match.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db) && a.length === b.length;
}

/** Cryptographically random, URL-safe token (base64url, no padding). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
