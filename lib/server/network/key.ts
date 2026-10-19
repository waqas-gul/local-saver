import "server-only";
import { hmacSha256 } from "../security/crypto";
import type { NormalizedIp } from "./normalize";

/**
 * Network key derivation (DEC-032, 03 §3.2).
 *
 * networkKey = HMAC-SHA256(NETWORK_KEY_SECRET[version], family + "|" + normalized prefix)
 *
 * A keyed HMAC because the IPv4 space is small enough to brute-force a plain hash. The key
 * is all that is stored; the IP itself is never persisted or logged.
 */

export type NetworkKey = { key: Buffer; version: number; family: 4 | 6 };

export function deriveNetworkKey(ip: NormalizedIp, secret: { version: number; secret: string }): NetworkKey {
  return {
    key: hmacSha256(secret.secret, `${ip.family}|${ip.networkPrefix}`),
    version: secret.version,
    family: ip.family,
  };
}
