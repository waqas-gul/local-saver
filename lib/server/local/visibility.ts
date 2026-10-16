import "server-only";

/**
 * The local visibility rule (03 §3.6, G1). Checked on every request that touches a share;
 * the feed (listLocalFeed in lib/server/shares/read.ts) applies its network part in SQL, and
 * creators reach their shares from other networks through My uploads (listMyShares).
 *
 *   visible(share) = scope in ('network', 'link_only') and expires_at > now()
 *     and status = 'active'                     (claimed shares arrive in Phase 3)
 *     and (caller is the creator
 *          or (scope = 'network' and space in the caller's eligible spaces))
 *
 * Link-only shares (DEC-033) are never visible on any network: through this API only their
 * creator sees them; everyone else reaches them only with a link grant (lib/server/links).
 * Uploads in progress (pending_upload) are visible only to their creator.
 * Not visible → the caller gets the same 404 as for a share that does not exist.
 */

export type VisibleShareFields = {
  scope: string;
  status: string;
  expiresAt: Date | null;
  networkSpaceId: string | null;
  createdByUserId: string | null;
};

export type VisibilityContext = {
  userId: string;
  /** Spaces of the caller's current, server-derived network whose status is ok. */
  eligibleSpaceIds: readonly string[];
  /** The database clock (authoritative for expiry). */
  now: Date;
};

export function isShareVisible(share: VisibleShareFields, ctx: VisibilityContext): boolean {
  if (share.scope !== "network" && share.scope !== "link_only") return false;
  if (!share.expiresAt || share.expiresAt.getTime() <= ctx.now.getTime()) return false;

  const isCreator = share.createdByUserId !== null && share.createdByUserId === ctx.userId;
  if (share.status === "pending_upload") return isCreator;
  if (share.status !== "active") return false;
  if (isCreator) return true;

  return share.scope === "network" && share.networkSpaceId !== null && ctx.eligibleSpaceIds.includes(share.networkSpaceId);
}
