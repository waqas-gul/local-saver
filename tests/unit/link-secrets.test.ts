import { describe, expect, it } from "vitest";
import {
  isLinkId,
  isLinkSecret,
  linkSecretHmac,
  newLinkId,
  newLinkSecret,
  newShortCode,
  shareUrl,
  shortCodeHmacs,
  verifyLinkSecret,
} from "@/lib/server/links/secrets";
import { normalizeShortCode } from "@/lib/shared/short-code";

/** Link IDs, secrets and codes (DEC-013, DEC-014, 03 §4.1, §4.4). */

const PEPPERS = [
  { version: 2, secret: "link-pepper-current-00000000000000000000" },
  { version: 1, secret: "link-pepper-previous-0000000000000000000" },
];

describe("link identifiers and secrets", () => {
  it("link IDs are 96 random bits (16 base64url characters)", () => {
    const ids = new Set(Array.from({ length: 200 }, newLinkId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(isLinkId(id)).toBe(true);
  });

  it("secrets are 256 random bits (43 base64url characters)", () => {
    const secret = newLinkSecret();
    expect(isLinkSecret(secret)).toBe(true);
    expect(Buffer.from(secret, "base64url")).toHaveLength(32);
    expect(newLinkSecret()).not.toBe(secret);
  });

  it("rejects malformed IDs and secrets", () => {
    expect(isLinkId("short")).toBe(false);
    expect(isLinkId("AAAAAAAAAAAAAAA/")).toBe(false);
    expect(isLinkSecret("x".repeat(42))).toBe(false);
    expect(isLinkSecret("x".repeat(43) + "=")).toBe(false);
  });

  it("puts the secret only in the fragment of the share URL", () => {
    const url = new URL(shareUrl("https://app.example.com", "AbCdEfGhIjKlMnOp", "s".repeat(43)));
    expect(url.pathname).toBe("/s/AbCdEfGhIjKlMnOp");
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#k=${"s".repeat(43)}`);
  });
});

describe("secret verification", () => {
  const id = newLinkId();
  const secret = newLinkSecret();
  const stored = { secretHmac: linkSecretHmac(PEPPERS[0]!, id, secret), pepperVersion: 2 };

  it("accepts the right secret under the stored pepper version", () => {
    expect(verifyLinkSecret(PEPPERS, stored, id, secret)).toBe(true);
    const old = { secretHmac: linkSecretHmac(PEPPERS[1]!, id, secret), pepperVersion: 1 };
    expect(verifyLinkSecret(PEPPERS, old, id, secret)).toBe(true);
  });

  it("refuses a wrong secret, another link's ID, an unknown link or a retired pepper", () => {
    expect(verifyLinkSecret(PEPPERS, stored, id, newLinkSecret())).toBe(false);
    expect(verifyLinkSecret(PEPPERS, stored, newLinkId(), secret)).toBe(false);
    expect(verifyLinkSecret(PEPPERS, null, id, secret)).toBe(false);
    expect(verifyLinkSecret(PEPPERS, { ...stored, pepperVersion: 9 }, id, secret)).toBe(false);
    expect(verifyLinkSecret([], stored, id, secret)).toBe(false);
  });

  it("HMACs are 32 bytes and depend on the pepper", () => {
    const a = linkSecretHmac(PEPPERS[0]!, id, secret);
    expect(a).toHaveLength(32);
    expect(a.equals(linkSecretHmac(PEPPERS[1]!, id, secret))).toBe(false);
  });
});

describe("short code generation and hashing", () => {
  it("generates normalized ten-character codes", () => {
    const codes = new Set(Array.from({ length: 500 }, newShortCode));
    expect(codes.size).toBe(500);
    for (const code of codes) expect(normalizeShortCode(code)).toBe(code);
  });

  it("hashes a code under every configured pepper, current first", () => {
    const hashes = shortCodeHmacs(PEPPERS, "7KQ4MX9D2P");
    expect(hashes.map((h) => h.version)).toEqual([2, 1]);
    expect(hashes[0]!.hmac).toHaveLength(32);
    expect(hashes[0]!.hmac.equals(hashes[1]!.hmac)).toBe(false);
  });
});
