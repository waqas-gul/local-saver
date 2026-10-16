import "server-only";

/**
 * The local visibility rule (03 §3.6, G1). Checked on every request that touches a share;
 * the feed (listLocalFeed in lib/server/shares/read.ts) applies its network part in SQL, and
 * creators reach their shares from other networks through My uploads (listMyShares).
 *
 *   visible(share) = scope in ('network', 'link_only') and expires_at > now()
 *     and status = 'active'
 *     and (caller is the creator
 *          or (scope = 'network' and space in the caller's eligible spaces))
 *
 * Link-only shares (DEC-033) are never visible on any network: through this API only their
 * creator sees them; everyone else reaches them only with a link grant (lib/server/links).
 * Uploads in progress (pending_upload) are visible only to their creator.
 * Not visible → the caller gets the same 404 as for a share that does not exist.
 *
 * Burn after download (Phase 3, DEC-015, phase 3 §17.8.4): while a share is claimed and its grace
 * lasts, it stays visible to its creator (D-7) and to its device claimant (the verified user and
 * device) while that device is still on an eligible network. Anyone else who would have seen it
 * learns that it was downloaded (410); after grace, or once consumed, so does the claimant
 * ("by you"). Everyone else still gets the 404.
 */

export type VisibleShareFields = {
  scope: string;
  status: string;
  expiresAt: Date | null;
  networkSpaceId: string | null;
  createdByUserId: string | null;
  /** Phase 3 claim columns; absent for shares that were never claimed. */
  claimedByUserId?: string | null;
  claimedDeviceId?: string | null;
  claimGraceUntil?: Date | null;
};

export type VisibilityContext = {
  userId: string;
  /** The caller's verified device (claimants are a user and a device). */
  deviceId?: string;
  /** Spaces of the caller's current, server-derived network whose status is ok. */
  eligibleSpaceIds: readonly string[];
  /** The database clock (authoritative for expiry and grace). */
  now: Date;
};

export type Visibility = "visible" | "hidden" | "downloaded_by_other" | "downloaded_by_you";

export function shareVisibility(share: VisibleShareFields, ctx: VisibilityContext): Visibility {
  if (share.scope !== "network" && share.scope !== "link_only") return "hidden";
  if (!share.expiresAt || share.expiresAt.getTime() <= ctx.now.getTime()) return "hidden";

  const isCreator = share.createdByUserId !== null && share.createdByUserId === ctx.userId;
  const onNetwork = share.scope === "network" && share.networkSpaceId !== null && ctx.eligibleSpaceIds.includes(share.networkSpaceId);

  if (share.status === "pending_upload") return isCreator ? "visible" : "hidden";
  if (share.status === "active") return isCreator || onNetwork ? "visible" : "hidden";

  if (share.status === "claimed" || share.status === "consumed") {
    const inGrace = share.status === "claimed" && !!share.claimGraceUntil && share.claimGraceUntil.getTime() > ctx.now.getTime();
    const isClaimant =
      ctx.deviceId !== undefined && share.claimedByUserId === ctx.userId && share.claimedDeviceId === ctx.deviceId;
    if (isCreator) return inGrace ? "visible" : "downloaded_by_other";
    if (isClaimant) {
      if (!onNetwork) return "hidden";
      return inGrace ? "visible" : "downloaded_by_you";
    }
    return onNetwork ? "downloaded_by_other" : "hidden";
  }
  return "hidden";
}

export function isShareVisible(share: VisibleShareFields, ctx: VisibilityContext): boolean {
  return shareVisibility(share, ctx) === "visible";
}
