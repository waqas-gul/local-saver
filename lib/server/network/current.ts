import "server-only";
import { sql } from "kysely";
import type { NetworkStatus } from "@/lib/shared/api/schemas";
import { IntegrationNotConfiguredError } from "../config/integrations";
import { getDb } from "../db/client";
import type { Env } from "../env";
import { getRuntimeFlags } from "../flags";
import { log } from "../log";
import { resolveClientIp } from "./client-ip";
import { egressListUsable } from "./egress";
import { deriveNetworkKey, type NetworkKey } from "./key";
import type { NormalizedIp } from "./normalize";

/**
 * The caller's current network, derived on every request from the trusted client IP
 * (03 §3.2, §3.6). Nothing here is ever taken from the client (P1, T-010).
 * Read-only: only observe creates spaces and records presence.
 */

export type NetworkView = {
  status: NetworkStatus;
  /** Why local sharing is off, for status copy. Null when ok. */
  reason: string | null;
  /** The space this request's key maps to, if it has been observed. */
  spaceId: string | null;
  /** Spaces whose shares this request may see: [spaceId] when ok, otherwise none (G5). */
  eligibleSpaceIds: string[];
  ip: NormalizedIp | null;
  keys: NetworkKey[];
};

function unavailable(reason: string): NetworkView {
  return { status: "unavailable", reason, spaceId: null, eligibleSpaceIds: [], ip: null, keys: [] };
}

export type ResolvedIp = { ok: true; ip: NormalizedIp; keys: NetworkKey[] } | { ok: false; view: NetworkView };

/** Trusted IP and network keys for this request (current secret version first). */
export async function resolveNetworkKeys(request: Request, env: Env): Promise<ResolvedIp> {
  const flags = await getRuntimeFlags(env);
  if (!flags.localSharingEnabled) return { ok: false, view: unavailable("disabled") };
  // Without current relay/Tor lists, shared exit addresses can't be recognized: fail closed.
  if (!egressListUsable(flags.egressRanges, new Date(), env.isDeployed)) {
    log.error("network.egress_list_stale", {});
    return { ok: false, view: unavailable("classification_unavailable") };
  }

  const result = resolveClientIp(request.headers, env);
  if (result.status !== "ok") {
    if (result.reason === "non_global") {
      // A proxy handing us private addresses is a misconfiguration (03 §3.2, §14).
      log.warn("network.non_global_client_ip", { requestId: request.headers.get("x-request-id") });
      return { ok: false, view: unavailable("non_global_ip") };
    }
    return { ok: false, view: unavailable("no_trusted_ip") };
  }

  if (env.networkKeys.length === 0) {
    throw new IntegrationNotConfiguredError("Network keys", ["NETWORK_KEY_SECRET_CURRENT"]);
  }
  return { ok: true, ip: result.ip, keys: env.networkKeys.map((secret) => deriveNetworkKey(result.ip, secret)) };
}

export async function currentNetwork(request: Request, env: Env): Promise<NetworkView> {
  const resolved = await resolveNetworkKeys(request, env);
  if (!resolved.ok) return resolved.view;
  const { ip, keys } = resolved;

  const { rows } = await sql<{ id: string; status: NetworkStatus; status_reason: string | null }>`
    select s.id, s.status, s.status_reason
      from app.network_spaces s
      join unnest(${keys.map((k) => k.version)}::smallint[], ${keys.map((k) => k.key)}::bytea[]) as k(version, key)
        on s.key_version = k.version and s.network_key = k.key
     order by s.key_version desc
     limit 1
  `.execute(getDb());

  const space = rows[0];
  if (!space) {
    // Never observed: no content can exist here yet.
    return { status: "ok", reason: null, spaceId: null, eligibleSpaceIds: [], ip, keys };
  }
  const ok = space.status === "ok";
  return {
    status: space.status,
    reason: ok ? null : space.status_reason,
    spaceId: space.id,
    eligibleSpaceIds: ok ? [space.id] : [],
    ip,
    keys,
  };
}
