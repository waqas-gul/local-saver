/**
 * Short share codes (DEC-014, 03 §4.4): ten Crockford Base32 characters (50 bits), shown as
 * 7KQ4M-X9D2P. Isomorphic: the code page tidies what people type, and the server normalizes again
 * before hashing, so the two always agree.
 */

/** Crockford Base32: digits and letters without I, L, O and U. */
export const SHORT_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const SHORT_CODE_LENGTH = 10;

// Spaces of any kind and the dashes phone keyboards substitute for a hyphen.
const SEPARATORS = /[\s ‐-―−-]/g;
const VALID = new RegExp(`^[${SHORT_CODE_ALPHABET}]{${SHORT_CODE_LENGTH}}$`);

/** Uppercase, drop separators, read O as 0 and I or L as 1. Null unless ten valid characters remain. */
export function normalizeShortCode(input: string): string | null {
  const code = input.replace(SEPARATORS, "").toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
  return VALID.test(code) ? code : null;
}

export function formatShortCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}
