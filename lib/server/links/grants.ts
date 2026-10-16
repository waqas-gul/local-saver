import "server-only";
import { sql, type Transaction } from "kysely";
import { getDb } from "../db/client";
import type { DB } from "../db/types.gen";
import type { Env } from "../env";
import { assertRemoteLinksEnabled } from "../flags";
import { linkExpired, linkUnavailable } from "../http/errors";
import { hashSessionToken, readLinkSessionToken } from "./cookies";
import { isLinkId } from "./secrets";

/**
 * Link grants (03 §4.2, 04 §7.5): what a viewer session may open. One grant per (session,
 * link), at most 12 hours and never past the link or the share. Every viewer request goes
 * through requireViewerAccess, which re-checks the grant, the link and the share each time, so
 * a revoked or expired link, or an ended share, stops working on the next request (T-031).
 */

export const GRANT_MAX_SECONDS = 12 * 60 * 60;

export async function grantAccess(trx: Transaction<DB>, sessionHash: Buffer, linkId: string, via: "secret" | "code"): Promise<void> {
  await sql`
    insert into app.link_grants (session_id_hash, link_id, granted_via, granted_at, expires_at)
    select ${sessionHash}, l.id, ${via}, now(),
           least(now() + make_interval(secs => ${GRANT_MAX_SECONDS}), l.expires_at, s.expires_at)
      from app.share_links l
      join app.shares s on s.id = l.share_id
     where l.id = ${linkId}
    on conflict (session_id_hash, link_id) do update
       set granted_via = excluded.granted_via, granted_at = excluded.granted_at, expires_at = excluded.expires_at
  `.execute(trx);
}

export type ViewerAccess = {
  linkId: string;
  shareId: string;
  sessionHash: Buffer;
  kind: "files" | "text";
  /** The share's network, kept only for download logs and abuse reports; never sent to viewers. */
  networkSpaceId: string | null;
  linkExpiresAt: Date;
  shareExpiresAt: Date;
  grantExpiresAt: Date;
  /** The link's entitlement snapshot (limits applied when it was created, 07 §2.3). */
  entitlementSnapshot: unknown;
};

type AccessRow = {
  link_id: string;
  share_id: string;
  link_expires_at: Date;
  revoked_at: Date | null;
  entitlement_snapshot: unknown;
  kind: "files" | "text";
  status: string;
  share_expires_at: Date;
  network_space_id: string | null;
  grant_expires_at: Date;
  db_now: Date;
};

/** The access a session hash holds for a link, checked against the link and share right now. */
export async function accessFor(sessionHash: Buffer, linkId: string): Promise<ViewerAccess> {
  const { rows } = await sql<AccessRow>`
    select l.id as link_id, l.share_id, l.expires_at as link_expires_at, l.revoked_at, l.entitlement_snapshot,
           s.kind, s.status, s.expires_at as share_expires_at, s.network_space_id,
           g.expires_at as grant_expires_at, now() as db_now
      from app.link_grants g
      join app.link_sessions ss on ss.id_hash = g.session_id_hash
      join app.share_links l on l.id = g.link_id
      join app.shares s on s.id = l.share_id
     where g.session_id_hash = ${sessionHash} and g.link_id = ${linkId} and ss.expires_at > now()
  `.execute(getDb());
  const row = rows[0];
  if (!row) throw linkUnavailable();
  const now = row.db_now.getTime();
  // This session proved the secret (or code) before, so it may learn that the link has ended.
  if (row.revoked_at || row.link_expires_at.getTime() <= now || row.status !== "active" || row.share_expires_at.getTime() <= now) {
    throw linkExpired();
  }
  // The link still works, but this browser's 12 hours are up: it needs the link again.
  if (row.grant_expires_at.getTime() <= now) throw linkUnavailable();
  return {
    linkId: row.link_id,
    shareId: row.share_id,
    sessionHash,
    kind: row.kind,
    networkSpaceId: row.network_space_id,
    linkExpiresAt: row.link_expires_at,
    shareExpiresAt: row.share_expires_at,
    grantExpiresAt: row.grant_expires_at,
    entitlementSnapshot: row.entitlement_snapshot,
  };
}

/** Every viewer endpoint: remote links on, a live session cookie, and a live grant for this link. */
export async function requireViewerAccess(request: Request, env: Env, linkId: string): Promise<ViewerAccess> {
  await assertRemoteLinksEnabled(env);
  const token = readLinkSessionToken(request, env);
  if (!token || !isLinkId(linkId)) throw linkUnavailable();
  return accessFor(hashSessionToken(token), linkId);
}
