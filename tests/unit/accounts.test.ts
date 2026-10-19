import { describe, expect, it } from "vitest";
import { REAUTH_WINDOW_SECONDS, signedInRecently } from "@/lib/server/accounts/delete";
import { maskEmail } from "@/lib/server/accounts/profile";
import { isMergeSecret, mergeSecretHmacs, newMergeSecret, verifyMergeSecret } from "@/lib/server/accounts/secrets";
import { principalFromClaims } from "@/lib/server/auth/session";
import { cleanLabel } from "@/lib/server/devices/labels";

/** Phase 4A pure helpers: token claims, merge secrets, profile display (phase 4 §17.5). */

const USER = "4F1D7E2A-1B2C-4D3E-8F90-123456789ABC";
const SESSION = "c4000000-0000-4000-8000-0000000000a1";

describe("principalFromClaims (03 §8, C4-2)", () => {
  const base = { sub: USER, role: "authenticated", session_id: SESSION, aal: "aal1", is_anonymous: true, amr: [{ method: "anonymous", timestamp: 1 }] };

  it("reads the user, the session and the assurance level from a verified token", () => {
    expect(principalFromClaims(base)).toEqual({
      userId: USER.toLowerCase(),
      isAnonymous: true,
      sessionId: SESSION,
      aal: "aal1",
      amr: [{ method: "anonymous", timestamp: 1 }],
      email: null,
      providers: [],
    });
  });

  it("reads an account's email and sign-in providers", () => {
    const principal = principalFromClaims({
      ...base,
      is_anonymous: false,
      aal: "aal2",
      email: "Someone@Example.com",
      app_metadata: { provider: "email", providers: ["email", "google", 7] },
      amr: [{ method: "otp", timestamp: 2 }, { method: "totp", timestamp: 3 }],
    });
    expect(principal).toMatchObject({ isAnonymous: false, aal: "aal2", email: "Someone@Example.com", providers: ["email", "google"] });
  });

  it("refuses password sessions: the app offers no passwords (D4-2, P4-00 pre-hijack)", () => {
    expect(principalFromClaims({ ...base, is_anonymous: false, amr: [{ method: "otp", timestamp: 1 }, { method: "password", timestamp: 2 }] })).toBeNull();
  });

  it("requires a session ID: every device is bound to one (C4-2)", () => {
    expect(principalFromClaims({ ...base, session_id: undefined })).toBeNull();
    expect(principalFromClaims({ ...base, session_id: "not-a-uuid" })).toBeNull();
  });

  it("refuses anything that is not an authenticated user's token", () => {
    expect(principalFromClaims({ ...base, role: "anon" })).toBeNull();
    expect(principalFromClaims({ ...base, role: "service_role" })).toBeNull();
    expect(principalFromClaims({ ...base, sub: "nope" })).toBeNull();
    expect(principalFromClaims(null)).toBeNull();
  });

  it("treats an unknown or missing assurance level as aal1", () => {
    expect(principalFromClaims({ ...base, aal: undefined })?.aal).toBe("aal1");
    expect(principalFromClaims({ ...base, aal: "aal9" })?.aal).toBe("aal1");
  });
});

describe("merge secrets (D4-3, M2)", () => {
  const PEPPERS = [
    { version: 2, secret: "link-pepper-current-00000000000000000000" },
    { version: 1, secret: "link-pepper-previous-0000000000000000000" },
  ];
  const INTENT = "f4000000-0000-4000-8000-000000000003";

  it("secrets are 256 random bits (43 base64url characters)", () => {
    const secret = newMergeSecret();
    expect(isMergeSecret(secret)).toBe(true);
    expect(Buffer.from(secret, "base64url")).toHaveLength(32);
    expect(newMergeSecret()).not.toBe(secret);
    expect(isMergeSecret("x".repeat(42))).toBe(false);
  });

  it("hashes under every configured pepper, current first, bound to the intent", () => {
    const secret = newMergeSecret();
    const hmacs = mergeSecretHmacs(PEPPERS, INTENT, secret);
    expect(hmacs.map((h) => h.version)).toEqual([2, 1]);
    expect(hmacs[0]?.hmac).toHaveLength(32);
    expect(hmacs[0]?.hmac.equals(hmacs[1]!.hmac)).toBe(false);
    const other = mergeSecretHmacs(PEPPERS, "f4000000-0000-4000-8000-000000000004", secret);
    expect(other[0]?.hmac.equals(hmacs[0]!.hmac)).toBe(false);
  });

  it("is domain-separated from link secrets under the same pepper", async () => {
    const { linkSecretHmac } = await import("@/lib/server/links/secrets");
    const secret = newMergeSecret();
    expect(mergeSecretHmacs(PEPPERS, INTENT, secret)[0]?.hmac.equals(linkSecretHmac(PEPPERS[0]!, INTENT, secret))).toBe(false);
  });

  it("verifies timing-safely against the stored pepper version only", () => {
    const secret = newMergeSecret();
    const [current, previous] = mergeSecretHmacs(PEPPERS, INTENT, secret);
    expect(verifyMergeSecret(PEPPERS, { secretHmac: current!.hmac, pepperVersion: 2 }, INTENT, secret)).toBe(true);
    expect(verifyMergeSecret(PEPPERS, { secretHmac: previous!.hmac, pepperVersion: 1 }, INTENT, secret)).toBe(true);
    expect(verifyMergeSecret(PEPPERS, { secretHmac: current!.hmac, pepperVersion: 1 }, INTENT, secret)).toBe(false);
    expect(verifyMergeSecret(PEPPERS, { secretHmac: current!.hmac, pepperVersion: 2 }, INTENT, newMergeSecret())).toBe(false);
    expect(verifyMergeSecret(PEPPERS, { secretHmac: current!.hmac, pepperVersion: 9 }, INTENT, secret)).toBe(false);
    expect(verifyMergeSecret(PEPPERS, null, INTENT, secret)).toBe(false);
  });
});

describe("profile display (§17.5.5)", () => {
  it("masks the email's local part", () => {
    expect(maskEmail("someone@example.com")).toBe("s•••@example.com");
    expect(maskEmail("a@b.co")).toBe("a•••@b.co");
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail("no-at-sign")).toBeNull();
  });

  it("cleans display names like device labels, up to 60 characters", () => {
    expect(cleanLabel("  Ada‮  Lovelace ", 60)).toBe("Ada Lovelace");
    expect(cleanLabel("a".repeat(70), 60)).toHaveLength(60);
    expect(cleanLabel("a".repeat(70))).toHaveLength(40);
  });
});

describe("recent sign-in for account deletion (D4-30, P4-22)", () => {
  const now = 1_800_000_000;
  const at = (method: string, secondsAgo: number) => ({ amr: [{ method, timestamp: now - secondsAgo }] });

  it("counts a sign-in method Auth verified within the last 10 minutes, the window's edge included", () => {
    expect(REAUTH_WINDOW_SECONDS).toBe(600);
    expect(signedInRecently(at("otp", 0), now)).toBe(true);
    expect(signedInRecently(at("otp", 600), now)).toBe(true);
    expect(signedInRecently(at("otp", 601), now)).toBe(false);
    expect(signedInRecently(at("totp", 30), now)).toBe(true);
    // Any recent entry is enough: an old code sign-in stepped up by the authenticator a minute ago.
    expect(signedInRecently({ amr: [{ method: "otp", timestamp: now - 3600 }, { method: "totp", timestamp: now - 60 }] }, now)).toBe(true);
  });

  it("never counts an anonymous sign-in, a missing timestamp, no entries, or a time far ahead of the clock", () => {
    expect(signedInRecently(at("anonymous", 5), now)).toBe(false);
    expect(signedInRecently({ amr: [{ method: "otp", timestamp: 0 }] }, now)).toBe(false);
    expect(signedInRecently({ amr: [] }, now)).toBe(false);
    expect(signedInRecently(at("otp", -30), now)).toBe(true);
    expect(signedInRecently(at("otp", -120), now)).toBe(false);
  });
});
