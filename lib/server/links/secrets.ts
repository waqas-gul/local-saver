import "server-only";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { SHORT_CODE_ALPHABET, SHORT_CODE_LENGTH } from "@/lib/shared/short-code";
import type { VersionedSecret } from "../env";
import { hmacSha256, randomToken } from "../security/crypto";
import { randomId } from "../security/ids";

/**
 * Link identifiers, secrets and short codes (DEC-013, DEC-014, 03 §4.1, §4.4).
 *
 * URL: https://{domain}/s/{linkId}#k={secret}. The link ID (96 bits) may appear in logs and abuse
 * reports; the secret (256 bits) lives only in the fragment, which browsers never send, and is
 * stored only as HMAC-SHA256 under a versioned pepper, so a database leak can't be checked
 * offline. Codes are hashed the same way under their own pepper.
 */

const LINK_ID = /^[A-Za-z0-9_-]{16}$/;
const LINK_SECRET = /^[A-Za-z0-9_-]{43}$/;

export function isLinkId(value: string): boolean {
  return LINK_ID.test(value);
}

export function isLinkSecret(value: string): boolean {
  return LINK_SECRET.test(value) && Buffer.from(value, "base64url").length === 32;
}

export function newLinkId(): string {
  return randomId(12);
}

export function newLinkSecret(): string {
  return randomToken(32);
}

export function newShortCode(): string {
  let code = "";
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) code += SHORT_CODE_ALPHABET[randomInt(SHORT_CODE_ALPHABET.length)];
  return code;
}

export function shareUrl(appOrigin: string, linkId: string, secret: string): string {
  return `${appOrigin}/s/${linkId}#k=${secret}`;
}

/** Bound to the link ID, so a secret proves nothing for any other link. */
export function linkSecretHmac(pepper: VersionedSecret, linkId: string, secret: string): Buffer {
  return hmacSha256(pepper.secret, `link|${linkId}|${secret}`);
}

/** Compared against when there is no stored HMAC, so a missing link costs the same work (03 §4.9). */
const DUMMY_HMAC = randomBytes(32);

/**
 * Timing-safe check of a secret against the stored HMAC. The HMAC is always computed, even for a
 * link that doesn't exist or a pepper version that is no longer configured, and the comparison
 * always runs, so "unknown link" and "wrong secret" take the same path (T-030).
 */
export function verifyLinkSecret(
  peppers: VersionedSecret[],
  stored: { secretHmac: Buffer; pepperVersion: number } | null,
  linkId: string,
  secret: string,
): boolean {
  const pepper = stored ? peppers.find((p) => p.version === stored.pepperVersion) : undefined;
  const computed = linkSecretHmac(pepper ?? peppers[0] ?? { version: 0, secret: "unconfigured" }, linkId, secret);
  const expected = stored && pepper && stored.secretHmac.length === 32 ? stored.secretHmac : DUMMY_HMAC;
  const equal = timingSafeEqual(computed, expected);
  return equal && stored !== null && pepper !== undefined;
}

/** The code's HMAC under each configured pepper, current first (codes live ≤ 24 h across a rotation). */
export function shortCodeHmacs(peppers: VersionedSecret[], normalizedCode: string): { version: number; hmac: Buffer }[] {
  return peppers.map((pepper) => ({ version: pepper.version, hmac: hmacSha256(pepper.secret, `code|${normalizedCode}`) }));
}
