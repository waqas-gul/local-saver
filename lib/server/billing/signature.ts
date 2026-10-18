import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookSignatureError } from "./types";

/**
 * Webhook signature helpers for provider adapters (phase 4 §17.7.5 step 3, B1, B2): HMAC-SHA256
 * over the exact bytes, compared in constant time against every configured secret (current and
 * previous, for rotation) and every signature the provider sent (several during its own rotation),
 * and the signed timestamp's tolerance where the provider signs one.
 */

export const WEBHOOK_TOLERANCE_SECONDS = 300;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The base64 HMAC-SHA256 of `message` under `secret` (both UTF-8). */
export function hmacBase64(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message, "utf8").digest("base64");
}

/**
 * True when any candidate (a base64 HMAC-SHA256) matches `message` under any secret. Every pair is
 * compared, so the time taken doesn't reveal which secret or signature matched.
 */
export function matchesAnySignature(message: string, candidates: readonly string[], secrets: readonly string[]): boolean {
  let match = false;
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(message, "utf8").digest();
    for (const candidate of candidates) {
      if (!BASE64.test(candidate)) continue;
      const given = Buffer.from(candidate, "base64");
      if (given.length === expected.length && timingSafeEqual(given, expected)) match = true;
    }
  }
  return match;
}

/** A signed timestamp (Unix seconds, as sent) within the tolerance either side of `now`. */
export function assertFreshTimestamp(value: string, now: Date, toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS): void {
  if (!/^[0-9]{1,12}$/.test(value)) throw new WebhookSignatureError("bad_timestamp");
  const skew = Math.abs(now.getTime() / 1000 - Number(value));
  if (skew > toleranceSeconds) throw new WebhookSignatureError("timestamp_out_of_tolerance");
}
