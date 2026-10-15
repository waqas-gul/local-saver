import "server-only";
import { sql } from "kysely";
import type { NetworkStatus, ObserveResponse } from "@/lib/shared/api/schemas";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import type { Env } from "../env";
import { enforceRateLimit } from "../ratelimit/limits";
import { resolveNetworkKeys } from "./current";
import { type EgressRange, egressLookupPrefix, matchEgress } from "./egress";

/**
 * POST /api/v1/network/observe (02 §4.1): derive the network, upsert its space, classify it
 * (egress lists, large-network cap) and record presence for 10 minutes. Observing from a new
 * network ends presence on the old one (G3). Without SP-04 only this request's key counts
 * (no dual-stack probe, DV1-3). The client address itself never reaches the database (L5).
 */
export async function observeNetwork(caller: Caller, request: Request, env: Env): Promise<ObserveResponse> {
  await enforceRateLimit("observe", caller.device.id);

  const resolved = await resolveNetworkKeys(request, env);
  if (!resolved.ok) {
    return { status: "unavailable", reason: resolved.view.reason, spaceIds: [], devicesHere: 0 };
  }
  const [current, previous] = resolved.keys;
  if (!current) throw new Error("no network key");
  const db = getDb();

  // Key rotation: move a space seen under the previous secret to the current one (03 §3.2).
  if (previous) {
    await sql`select app.rekey_network_space(${previous.key}, ${previous.version}::integer, ${current.key}, ${current.version}::integer)`.execute(db);
  }

  // Only the /24 or /48 around the address goes to the database; containment is checked here.
  const nearby = await sql<EgressRange>`
    select cidr::text as cidr, source from app.egress_ranges_overlapping(${egressLookupPrefix(resolved.ip)}::cidr)
  `.execute(db);
  const egressSource = matchEgress(resolved.ip, nearby.rows);

  const { rows } = await sql<{ space_id: string; status: NetworkStatus; status_reason: string | null; devices_here: number }>`
    select * from app.observe_network(
      ${caller.device.id}::uuid, ${caller.principal.userId}::uuid, ${current.key},
      ${current.version}::integer, ${current.family}::integer, ${egressSource}::text)
  `.execute(db);
  const row = rows[0];
  if (!row) throw new Error("observe_network returned nothing");

  const ok = row.status === "ok";
  return {
    status: row.status,
    reason: ok ? null : row.status_reason,
    spaceIds: ok ? [row.space_id] : [],
    devicesHere: ok ? row.devices_here : 0,
  };
}
