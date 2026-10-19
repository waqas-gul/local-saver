import "server-only";
import type { Env } from "../env";
import { ORIGIN_AUTH_HEADER, verifyOriginAuth } from "../security/origin-lock";
import { normalizeClientIp, type NormalizedIp } from "./normalize";

/**
 * The trusted client IP (DEC-004, 03 §3.3).
 *
 * Under DEC-031 this decides who sees local content, so the rules are strict:
 * - CF-Connecting-IP is read only after the origin secret is verified.
 * - X-Forwarded-For and X-Real-IP are never read.
 * - X-Test-Client-IP is honoured only when env.testClientIpAllowed (never in production builds).
 */

export const TEST_CLIENT_IP_HEADER = "x-test-client-ip";
const CLOUDFLARE_IP_HEADER = "cf-connecting-ip";

export type ClientIpResult =
  | { status: "ok"; ip: NormalizedIp; source: "cloudflare" | "test-override" }
  | {
      status: "unavailable";
      reason: "no_trusted_proxy" | "origin_unverified" | "missing_header" | "invalid" | "non_global";
    };

export function resolveClientIp(headers: Headers, env: Env): ClientIpResult {
  const ipv6PrefixLength = env.NETWORK_IPV6_PREFIX_LEN;

  if (env.testClientIpAllowed) {
    // TEST_CLIENT_IP_DEFAULT lets local browsers, which connect from 127.0.0.1, share one network.
    const override = headers.get(TEST_CLIENT_IP_HEADER) ?? env.testClientIpDefault ?? null;
    if (override !== null) {
      const result = normalizeClientIp(override, { allowDocumentationRanges: true, ipv6PrefixLength });
      return result.ok
        ? { status: "ok", ip: result.value, source: "test-override" }
        : { status: "unavailable", reason: result.reason };
    }
  }

  if (env.TRUST_PROXY_MODE !== "cloudflare") {
    return { status: "unavailable", reason: "no_trusted_proxy" };
  }

  if (!verifyOriginAuth(headers.get(ORIGIN_AUTH_HEADER), env)) {
    return { status: "unavailable", reason: "origin_unverified" };
  }

  const value = headers.get(CLOUDFLARE_IP_HEADER);
  if (value === null) return { status: "unavailable", reason: "missing_header" };

  const result = normalizeClientIp(value, { ipv6PrefixLength });
  return result.ok
    ? { status: "ok", ip: result.value, source: "cloudflare" }
    : { status: "unavailable", reason: result.reason };
}
