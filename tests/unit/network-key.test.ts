import { describe, expect, it } from "vitest";
import { deriveNetworkKey } from "@/lib/server/network/key";
import { normalizeClientIp, type NormalizedIp } from "@/lib/server/network/normalize";

const SECRET = { version: 1, secret: "network-key-secret-for-unit-tests-000001" };

function ip(raw: string): NormalizedIp {
  const result = normalizeClientIp(raw, { allowDocumentationRanges: true });
  if (!result.ok) throw new Error(`fixture ${raw} did not normalize`);
  return result.value;
}

describe("deriveNetworkKey (DEC-032, T-006)", () => {
  it("is a 32-byte HMAC tagged with the secret version and address family", () => {
    const key = deriveNetworkKey(ip("203.0.113.10"), SECRET);
    expect(key.key).toBeInstanceOf(Buffer);
    expect(key.key.length).toBe(32);
    expect(key.version).toBe(1);
    expect(key.family).toBe(4);
  });

  it("gives IPv4-mapped and NAT64 forms the key of the plain IPv4 address", () => {
    const plain = deriveNetworkKey(ip("203.0.113.10"), SECRET).key;
    expect(deriveNetworkKey(ip("::ffff:203.0.113.10"), SECRET).key.equals(plain)).toBe(true);
    expect(deriveNetworkKey(ip("64:ff9b::cb00:710a"), SECRET).key.equals(plain)).toBe(true);
  });

  it("gives every address in one IPv6 /64 the same key, and other /64s a different one", () => {
    const a = deriveNetworkKey(ip("2001:db8:a:1::10"), SECRET).key;
    expect(deriveNetworkKey(ip("2001:db8:a:1::99"), SECRET).key.equals(a)).toBe(true);
    expect(deriveNetworkKey(ip("2001:db8:a:2::10"), SECRET).key.equals(a)).toBe(false);
  });

  it("depends on the secret, so keys can't be recomputed from an IP alone", () => {
    const a = deriveNetworkKey(ip("203.0.113.10"), SECRET).key;
    const b = deriveNetworkKey(ip("203.0.113.10"), { version: 2, secret: "another-secret-for-unit-tests-0000002" }).key;
    expect(a.equals(b)).toBe(false);
  });

  it("never returns the IP itself", () => {
    const key = deriveNetworkKey(ip("203.0.113.10"), SECRET);
    expect(JSON.stringify(key)).not.toContain("203.0.113.10");
  });
});
