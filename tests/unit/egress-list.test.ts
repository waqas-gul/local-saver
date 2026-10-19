import { describe, expect, it } from "vitest";
import { EGRESS_LIST_MAX_AGE_DAYS, egressListUsable, egressLookupPrefix, matchEgress } from "@/lib/server/network/egress";
import { normalizeClientIp, type NormalizedIp } from "@/lib/server/network/normalize";

function ip(raw: string): NormalizedIp {
  const result = normalizeClientIp(raw, { allowDocumentationRanges: true });
  if (!result.ok) throw new Error(`bad fixture ${raw}`);
  return result.value;
}

/** Review L5: the database gets only a coarse prefix; the exact address is matched here. */
describe("egressLookupPrefix", () => {
  it("sends an IPv4 /24 and an IPv6 /48, never the address or the /64", () => {
    expect(egressLookupPrefix(ip("203.0.113.77"))).toBe("203.0.113.0/24");
    expect(egressLookupPrefix(ip("2001:db8:5e1a:12:a:b:c:d"))).toBe("2001:db8:5e1a::/48");
    expect(egressLookupPrefix(ip("::ffff:198.51.100.9"))).toBe("198.51.100.0/24");
  });
});

describe("matchEgress", () => {
  const ranges = [
    { cidr: "192.0.2.0/27", source: "private_relay" },
    { cidr: "198.51.100.77/32", source: "tor" },
    { cidr: "2001:db8:5e00::/40", source: "private_relay" },
  ];

  it("matches only ranges that contain the exact address", () => {
    expect(matchEgress(ip("192.0.2.7"), ranges)).toBe("private_relay");
    expect(matchEgress(ip("192.0.2.77"), ranges)).toBeNull(); // same /24, outside the /27
    expect(matchEgress(ip("198.51.100.77"), ranges)).toBe("tor");
    expect(matchEgress(ip("198.51.100.78"), ranges)).toBeNull();
    expect(matchEgress(ip("2001:db8:5e1a::1"), ranges)).toBe("private_relay");
    expect(matchEgress(ip("2001:db8:5f00::1"), ranges)).toBeNull();
  });

  it("ignores ranges of the other family and unknown sources", () => {
    expect(matchEgress(ip("2001:db8::1"), [{ cidr: "192.0.2.0/24", source: "tor" }])).toBeNull();
    expect(matchEgress(ip("192.0.2.1"), [{ cidr: "192.0.2.0/24", source: "somewhere" }])).toBeNull();
  });
});

/** Fail closed when the relay/Tor lists are missing or stale in deployed environments (review M2). */
const NOW = new Date("2026-10-15T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe("egressListUsable", () => {
  it("allows at most 14 days between list loads", () => {
    expect(EGRESS_LIST_MAX_AGE_DAYS).toBe(14);
  });

  it("requires a recent load in staging and production", () => {
    expect(egressListUsable({ loadedAt: daysAgo(1) }, NOW, true)).toBe(true);
    expect(egressListUsable({ loadedAt: daysAgo(15) }, NOW, true)).toBe(false);
    expect(egressListUsable({}, NOW, true)).toBe(false);
    expect(egressListUsable(null, NOW, true)).toBe(false);
    expect(egressListUsable({ loadedAt: "not a date" }, NOW, true)).toBe(false);
    expect(egressListUsable({ loadedAt: daysAgo(-1) }, NOW, true)).toBe(true);
  });

  it("does not require the lists locally or in tests", () => {
    expect(egressListUsable(null, NOW, false)).toBe(true);
  });
});
