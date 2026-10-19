import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { VersionedSecret } from "../env";
import { hmacSha256, randomToken } from "../security/crypto";

/**
 * Merge-intent secrets (§17.5.4, D4-3; threats M1, M2). 256 random bits, returned once to the
 * anonymous browser and stored only as HMAC-SHA256 under the versioned link pepper. The message is
 * domain-separated ("merge|…") and bound to the intent ID, so it proves nothing for a link or for
 * any other intent, and a database leak can't be checked offline. No new secret to provision.
 */

const MERGE_SECRET = /^[A-Za-z0-9_-]{43}$/;

export function newMergeSecret(): string {
  return randomToken(32);
}

export function isMergeSecret(value: string): boolean {
  return MERGE_SECRET.test(value) && Buffer.from(value, "base64url").length === 32;
}

function mergeSecretHmac(pepper: VersionedSecret, intentId: string, secret: string): Buffer {
  return hmacSha256(pepper.secret, `merge|${intentId}|${secret}`);
}

/** The secret's HMAC under each configured pepper, current first (an intent lives ≤ 24 h across a rotation). */
export function mergeSecretHmacs(peppers: VersionedSecret[], intentId: string, secret: string): { version: number; hmac: Buffer }[] {
  return peppers.map((pepper) => ({ version: pepper.version, hmac: mergeSecretHmac(pepper, intentId, secret) }));
}

const DUMMY_HMAC = randomBytes(32);

/**
 * Timing-safe check against the stored HMAC, always computed and compared, so an unknown intent and
 * a wrong secret take the same path (the API answers the same 404 for both).
 */
export function verifyMergeSecret(
  peppers: VersionedSecret[],
  stored: { secretHmac: Buffer; pepperVersion: number } | null,
  intentId: string,
  secret: string,
): boolean {
  const pepper = stored ? peppers.find((p) => p.version === stored.pepperVersion) : undefined;
  const computed = mergeSecretHmac(pepper ?? peppers[0] ?? { version: 0, secret: "unconfigured" }, intentId, secret);
  const expected = stored && pepper && stored.secretHmac.length === 32 ? stored.secretHmac : DUMMY_HMAC;
  const equal = timingSafeEqual(computed, expected);
  return equal && stored !== null && pepper !== undefined;
}
