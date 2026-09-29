import "server-only";
import type { Env } from "../env";
import { timingSafeEqualString } from "./crypto";

/** Header set by the Cloudflare Transform Rule (DEC-004, infra/cloudflare/README.md). */
export const ORIGIN_AUTH_HEADER = "x-origin-auth";

/** The origin lock is on whenever the Cloudflare client-IP header is trusted. */
export function isOriginLockEnabled(env: Env): boolean {
  return env.TRUST_PROXY_MODE === "cloudflare";
}

/** True if the header carries the current or previous origin secret. Timing-safe. */
export function verifyOriginAuth(headerValue: string | null, env: Env): boolean {
  if (!headerValue) return false;
  let match = false;
  // Compare against every secret so timing doesn't reveal which one matched.
  for (const secret of env.originSecrets) {
    if (timingSafeEqualString(headerValue, secret)) match = true;
  }
  return match;
}
