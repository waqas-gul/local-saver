import "server-only";
import ipaddr from "ipaddr.js";

/**
 * Client IP normalization (03 §3.2, tests T-006 / T-007).
 *
 * - IPv4 → /32. IPv4-mapped IPv6 and NAT64 (64:ff9b::/96) → the embedded IPv4 address.
 * - IPv6 → its /64 prefix (configurable).
 * - Only globally routable unicast addresses are accepted. Anything else from the
 *   trusted proxy means a misconfiguration, so the caller treats it as "unavailable".
 */

export type NormalizedIp = {
  family: 4 | 6;
  /** Canonical form of the full address. */
  address: string;
  /** What the network key is derived from: the IPv4 address, or the IPv6 prefix with its length. */
  networkPrefix: string;
};

export type NormalizeResult =
  | { ok: true; value: NormalizedIp }
  | { ok: false; reason: "invalid" | "non_global" };

export type NormalizeOptions = {
  ipv6PrefixLength?: number;
  /**
   * Accept RFC 5737 / RFC 3849 documentation addresses (192.0.2.0/24, 198.51.100.0/24,
   * 203.0.113.0/24, 2001:db8::/32). Test fixtures use them; a real proxy never sends them.
   */
  allowDocumentationRanges?: boolean;
};

const DOCUMENTATION_RANGES = ["192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "2001:db8::/32"].map((cidr) =>
  ipaddr.parseCIDR(cidr),
);
const NAT64 = ipaddr.parseCIDR("64:ff9b::/96");
const IP_CHARS = /^[0-9a-fA-F:.]+$/;

function isDocumentation(addr: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  return DOCUMENTATION_RANGES.some(([range, bits]) => addr.kind() === range.kind() && addr.match(range, bits));
}

function isGlobal(addr: ipaddr.IPv4 | ipaddr.IPv6, allowDocs: boolean): boolean {
  if (allowDocs && isDocumentation(addr)) return true;
  return addr.range() === "unicast";
}

export function normalizeClientIp(raw: string, options: NormalizeOptions = {}): NormalizeResult {
  const prefixLength = options.ipv6PrefixLength ?? 64;
  if (!Number.isInteger(prefixLength) || prefixLength < 32 || prefixLength > 128) {
    throw new RangeError("ipv6PrefixLength must be an integer between 32 and 128");
  }

  const text = raw.trim();
  // Reject zone IDs, brackets, ports, lists and the non-standard IPv4 forms ipaddr.js tolerates.
  if (!IP_CHARS.test(text)) return { ok: false, reason: "invalid" };

  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  if (ipaddr.IPv4.isValidFourPartDecimal(text)) {
    addr = ipaddr.IPv4.parse(text);
  } else if (text.includes(":") && ipaddr.IPv6.isValid(text)) {
    addr = ipaddr.IPv6.parse(text);
  } else {
    return { ok: false, reason: "invalid" };
  }

  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      addr = v6.toIPv4Address();
    } else if (v6.match(NAT64)) {
      const bytes = v6.toByteArray().slice(12);
      addr = ipaddr.fromByteArray(bytes) as ipaddr.IPv4;
    }
  }

  const allowDocs = options.allowDocumentationRanges ?? false;
  if (!isGlobal(addr, allowDocs)) return { ok: false, reason: "non_global" };

  if (addr.kind() === "ipv4") {
    const address = addr.toString();
    return { ok: true, value: { family: 4, address, networkPrefix: address } };
  }

  const network = ipaddr.IPv6.networkAddressFromCIDR(`${addr.toString()}/${prefixLength}`);
  return {
    ok: true,
    value: { family: 6, address: addr.toString(), networkPrefix: `${network.toString()}/${prefixLength}` },
  };
}
