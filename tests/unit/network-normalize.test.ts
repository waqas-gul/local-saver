import { describe, expect, it } from "vitest";
import { normalizeClientIp } from "@/lib/server/network/normalize";

function ok(raw: string, options?: Parameters<typeof normalizeClientIp>[1]) {
  const result = normalizeClientIp(raw, options);
  if (!result.ok) throw new Error(`expected ok for ${raw}, got ${result.reason}`);
  return result.value;
}

const docs = { allowDocumentationRanges: true };

describe("normalizeClientIp (T-006)", () => {
  it("keeps IPv4 addresses as /32", () => {
    expect(ok("1.1.1.1")).toEqual({ family: 4, address: "1.1.1.1", networkPrefix: "1.1.1.1" });
  });

  it("maps IPv4-mapped IPv6 to the embedded IPv4 address", () => {
    expect(ok("::ffff:203.0.113.10", docs)).toMatchObject({ family: 4, networkPrefix: "203.0.113.10" });
    expect(ok("::ffff:1.1.1.1")).toMatchObject({ family: 4, networkPrefix: "1.1.1.1" });
  });

  it("maps NAT64 well-known prefix addresses to the embedded IPv4 address", () => {
    expect(ok("64:ff9b::cb00:710a", docs)).toMatchObject({ family: 4, networkPrefix: "203.0.113.10" });
  });

  it("groups IPv6 addresses by /64", () => {
    const a = ok("2001:db8:a:1::10", docs);
    const b = ok("2001:db8:a:1:ffff::99", docs);
    const other = ok("2001:db8:a:2::10", docs);
    expect(a.family).toBe(6);
    expect(a.networkPrefix).toBe("2001:db8:a:1::/64");
    expect(b.networkPrefix).toBe(a.networkPrefix);
    expect(other.networkPrefix).not.toBe(a.networkPrefix);
  });

  it("normalizes textual variants of the same IPv6 address", () => {
    expect(ok("2606:4700:4700:0000:0000:0000:0000:1111").networkPrefix).toBe(ok("2606:4700:4700::1111").networkPrefix);
    expect(ok("2606:4700:4700::1111").networkPrefix).toBe("2606:4700:4700::/64");
  });

  it("supports a configurable IPv6 prefix length", () => {
    expect(ok("2606:4700:4700:12::1111", { ipv6PrefixLength: 56 }).networkPrefix).toBe("2606:4700:4700::/56");
  });

  it("trims surrounding whitespace", () => {
    expect(ok(" 1.1.1.1 ").address).toBe("1.1.1.1");
  });
});

describe("normalizeClientIp rejections (T-007)", () => {
  it.each([
    "192.168.1.5",
    "10.0.0.1",
    "172.16.0.1",
    "127.0.0.1",
    "100.64.1.1",
    "169.254.1.1",
    "0.0.0.0",
    "255.255.255.255",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:192.168.1.5",
    "64:ff9b::c0a8:0105",
  ])("treats %s as non-global", (raw) => {
    expect(normalizeClientIp(raw)).toEqual({ ok: false, reason: "non_global" });
  });

  it("rejects documentation ranges unless explicitly allowed (tests only)", () => {
    for (const raw of ["192.0.2.1", "198.51.100.20", "203.0.113.10", "2001:db8::1"]) {
      expect(normalizeClientIp(raw)).toEqual({ ok: false, reason: "non_global" });
      expect(normalizeClientIp(raw, docs).ok).toBe(true);
    }
  });

  it.each(["", "garbage", "1.1.1", "1.1.1.1.1", "999.1.1.1", "1.1.1.1, 8.8.8.8", "[2606:4700::1]", "fe80::1%eth0"])(
    "treats %j as invalid",
    (raw) => {
      expect(normalizeClientIp(raw)).toEqual({ ok: false, reason: "invalid" });
    },
  );
});
