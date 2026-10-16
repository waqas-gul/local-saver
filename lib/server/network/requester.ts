import "server-only";
import { IntegrationNotConfiguredError } from "../config/integrations";
import type { Env } from "../env";
import { resolveClientIp } from "./client-ip";
import { deriveNetworkKey } from "./key";

/**
 * A rate-limit key for the requester's network (03 §10: "per network key"), for requests that
 * don't go through local mode: link unlocks, code guesses, abuse reports, link-only posts.
 * It is the current network key in hex (a keyed hash, never the address). Without a trusted
 * client IP every such request shares one "unknown" bucket, so a misconfigured proxy makes
 * these limits stricter, not looser.
 */
export function requesterKey(request: Request, env: Env): string {
  const resolved = resolveClientIp(request.headers, env);
  if (resolved.status !== "ok") return "unknown";
  const current = env.networkKeys[0];
  if (!current) throw new IntegrationNotConfiguredError("Network keys", ["NETWORK_KEY_SECRET_CURRENT"]);
  return deriveNetworkKey(resolved.ip, current).key.toString("hex");
}
