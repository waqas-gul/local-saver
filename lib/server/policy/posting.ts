import "server-only";
import type { Destination } from "@/lib/shared/api/schemas";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import type { Entitlements } from "../entitlements/types";
import type { Env } from "../env";
import { assertRemoteLinksEnabled, getRuntimeFlags } from "../flags";
import { ApiError, notFound } from "../http/errors";
import type { NetworkView } from "../network/current";
import { requesterKey } from "../network/requester";
import { findRoom } from "../rooms/access";

/**
 * Who may post (DEC-033, 03 §3.7, §10): kill switches, per-user restrictions, and, for the
 * network destination, local mode being on for the caller's current network (fail closed, G5).
 * Link-only posts need no local network (they are never visible on one), but they need remote
 * links to be on, since a link is the only way to reach them.
 *
 * Phase 4 (E29, C4-15): the same kill switches and restrictions apply to every write that publishes
 * content, not only to posting: text edits and upload completion (assertMayWrite), and new short
 * codes (assertNotRestricted).
 *
 * Phase 4 (P4-17, E23): a private room is a destination for its active members, from any network; membership, not
 * the plan, decides, and anyone else gets the same 404 as for a room that doesn't exist. The uploader's own plan
 * gives the limits and pays the quota (DEC-018). The share's transaction checks the membership again under row
 * locks (lockRoomForPosting).
 */

export type PostingTarget = {
  scope: "network" | "link_only" | "room";
  /** The space a network share goes into; null for a link-only or room share. */
  spaceId: string | null;
  /** Phase 4 (P4-17): the room a room share goes into; null otherwise. */
  roomId: string | null;
  /** The room's default expiry, if its owner set one; the poster's plan still decides whether it applies. */
  roomDefaultExpirySeconds: number | null;
  /**
   * Key for the per-network daily volume and text rate limits. Network shares count against
   * their space; link-only and room shares against the same space when the network was observed, and
   * otherwise against the requester's network key, so switching destination doesn't add budget.
   */
  networkLimitKey: string;
};

/** Kill switches and the caller's upload restriction, for posts, edits and upload completion. */
export async function assertMayWrite(caller: Caller, env: Env, options: { files: boolean }): Promise<void> {
  const flags = await getRuntimeFlags(env);
  if ((options.files && !flags.uploadsEnabled) || (caller.principal.isAnonymous && !flags.anonymousUploadsEnabled)) {
    throw new ApiError(503, "UPLOADS_DISABLED", "Posting is temporarily disabled");
  }
  await assertNotRestricted(caller);
}

/** Upload-restricted users may neither post nor send their content off the network by link. */
export async function assertNotRestricted(caller: Caller): Promise<void> {
  const restriction = await getDb()
    .selectFrom("app.user_flags")
    .select("upload_restricted")
    .where("user_id", "=", caller.principal.userId)
    .executeTakeFirst();
  if (restriction?.upload_restricted) throw new ApiError(403, "UPLOADS_RESTRICTED", "Posting is not allowed for this account");
}

/** Returns the space the new share goes into. */
export async function assertCanPost(
  caller: Caller,
  network: NetworkView,
  env: Env,
  options: { files: boolean },
): Promise<string> {
  await assertMayWrite(caller, env, options);
  if (network.status !== "ok" || !network.spaceId) {
    throw new ApiError(409, "LOCAL_SHARING_UNAVAILABLE", "Local sharing is off on this network", {
      status: network.status,
      reason: network.spaceId ? network.reason : (network.reason ?? "network_not_observed"),
    });
  }
  return network.spaceId;
}

/** Where a new share goes and which network budget it uses, for any destination. */
export async function postingTarget(
  caller: Caller,
  network: NetworkView,
  request: Request,
  env: Env,
  options: { files: boolean; destination: Destination },
): Promise<PostingTarget> {
  const { destination } = options;
  if (destination === "network") {
    const spaceId = await assertCanPost(caller, network, env, options);
    return { scope: "network", spaceId, roomId: null, roomDefaultExpirySeconds: null, networkLimitKey: spaceId };
  }
  const networkLimitKey = network.spaceId ?? `key:${requesterKey(request, env)}`;
  if (destination === "link_only") {
    await assertMayWrite(caller, env, options);
    await assertRemoteLinksEnabled(env);
    return { scope: "link_only", spaceId: null, roomId: null, roomDefaultExpirySeconds: null, networkLimitKey };
  }
  // A room (E23): its active members only; nothing about it is revealed to anyone else.
  const room = await findRoom(caller.principal.userId, destination.room);
  if (!room) throw notFound();
  await assertMayWrite(caller, env, options);
  return { scope: "room", spaceId: null, roomId: room.id, roomDefaultExpirySeconds: room.defaultExpirySeconds, networkLimitKey };
}

/** The expiry a post asked for or, in a room, the room's default when the poster's plan offers it. */
export function requestedExpiry(entitlements: Entitlements, target: PostingTarget, expiresIn: number | undefined): number | undefined {
  if (expiresIn !== undefined) return expiresIn;
  const roomDefault = target.roomDefaultExpirySeconds;
  return roomDefault !== null && entitlements.limits.localExpiryOptionsSeconds.includes(roomDefault) ? roomDefault : undefined;
}
