import { describe, expect, it } from "vitest";
import { hmacSha256, randomToken, timingSafeEqualString } from "@/lib/server/security/crypto";
import { isRequestId, newRequestId, randomId } from "@/lib/server/security/ids";

describe("crypto helpers", () => {
  it("computes HMAC-SHA256 deterministically (RFC 4231 test case 2)", () => {
    const digest = hmacSha256("Jefe", "what do ya want for nothing?");
    expect(digest.toString("hex")).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  it("compares strings in constant time and handles unequal lengths", () => {
    expect(timingSafeEqualString("abc", "abc")).toBe(true);
    expect(timingSafeEqualString("abc", "abd")).toBe(false);
    expect(timingSafeEqualString("abc", "abcd")).toBe(false);
    expect(timingSafeEqualString("", "")).toBe(false);
  });

  it("generates url-safe random tokens of the requested entropy", () => {
    const token = randomToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(32)).not.toBe(token);
  });
});

describe("id helpers", () => {
  it("creates UUID request IDs and validates them", () => {
    const id = newRequestId();
    expect(isRequestId(id)).toBe(true);
    expect(isRequestId("not-an-id")).toBe(false);
    expect(isRequestId(`${id}\r\nx-injected: 1`)).toBe(false);
  });

  it("creates random base64url IDs (96-bit by default)", () => {
    expect(randomId()).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });
});
