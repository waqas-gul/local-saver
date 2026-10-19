import "server-only";
import ipaddr from "ipaddr.js";
import type { NormalizedIp } from "./normalize";

/**
 * The relay and Tor egress lists (03 §3.5 (a)) are what switch local mode off for shared exit
 * addresses. If they were never loaded, or are stale, staging and production fail closed
 * (P3): local sharing is off everywhere until scripts/load-egress-ranges.cjs runs again.
 *
 * The lookup never sends the client address to the database (review L5): it asks for the
 * ranges overlapping the address's IPv4 /24 or IPv6 /48 (the usual anonymization granularity)
 * and checks exact containment here.
 */

export const EGRESS_LIST_MAX_AGE_DAYS = 14;
export const EGRESS_LOOKUP_PREFIX = { 4: 24, 6: 48 } as const;
const SOURCES = new Set(["private_relay", "tor", "vpn", "hosting"]);

export type EgressRange = { cidr: string; source: string };

export function egressLookupPrefix(ip: NormalizedIp): string {
  const bits = EGRESS_LOOKUP_PREFIX[ip.family];
  const network =
    ip.family === 4
      ? ipaddr.IPv4.networkAddressFromCIDR(`${ip.address}/${bits}`)
      : ipaddr.IPv6.networkAddressFromCIDR(`${ip.address}/${bits}`);
  return `${network.toString()}/${bits}`;
}

/** The list the exact address is on, if any. */
export function matchEgress(ip: NormalizedIp, ranges: EgressRange[]): string | null {
  const address = ipaddr.parse(ip.address);
  for (const range of ranges) {
    if (!SOURCES.has(range.source)) continue;
    const [network, bits] = ipaddr.parseCIDR(range.cidr);
    if (network.kind() === address.kind() && address.match(network, bits)) return range.source;
  }
  return null;
}

export function egressListUsable(flagValue: unknown, now: Date, deployed: boolean): boolean {
  if (!deployed) return true;
  const loadedAt = (flagValue as { loadedAt?: unknown } | null)?.loadedAt;
  if (typeof loadedAt !== "string") return false;
  const time = Date.parse(loadedAt);
  if (Number.isNaN(time)) return false;
  return now.getTime() - time <= EGRESS_LIST_MAX_AGE_DAYS * 86_400_000;
}
