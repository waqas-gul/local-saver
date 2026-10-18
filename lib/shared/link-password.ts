/**
 * Link password rules (phase 4 §17.8.3), isomorphic: the server enforces them (lib/server/links/password.ts)
 * and the share-link dialog applies the same ones as the password is typed.
 *
 * Length: 8–128 characters after NFC normalization, counted as characters (code points), not UTF-16 units.
 *
 * Common passwords: a short bundled list. The creator gets a warning, never a refusal. Compared lowercase,
 * without surrounding spaces. It isn't meant to be complete: the length rule and the attempt limits do the
 * real work.
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export function passwordLengthOk(password: string): boolean {
  const length = [...password.normalize("NFC")].length;
  return length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH;
}

const COMMON = new Set([
  "password", "password1", "password12", "password123", "password!", "passw0rd", "p@ssw0rd", "p@ssword",
  "12345678", "123456789", "1234567890", "0123456789", "87654321", "11111111", "00000000", "12341234",
  "123123123", "1q2w3e4r", "1qaz2wsx", "qwertyui", "qwertyuiop", "qwerty123", "qwerty12", "asdfghjk",
  "asdfasdf", "zxcvbnm1", "abcd1234", "abc12345", "abcdefgh", "iloveyou", "iloveyou1", "sunshine",
  "princess", "football", "baseball", "superman", "starwars", "whatever", "trustno1", "letmein1",
  "welcome1", "welcome123", "admin123", "administrator", "changeme", "computer", "internet", "michelle",
  "jennifer", "dragon12", "monkey12", "shadow12", "master12", "freedom1", "loveyou1", "mustang1",
  "secret123", "access14", "11223344", "aa123456", "qwer1234", "1234qwer", "a1b2c3d4", "1password",
]);

export function isCommonPassword(password: string): boolean {
  return COMMON.has(password.trim().toLowerCase());
}
