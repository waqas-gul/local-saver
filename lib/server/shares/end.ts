import "server-only";
import { sql } from "kysely";
import { audit } from "../audit/log";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import { notFound } from "../http/errors";
import type { NetworkView } from "../network/current";
import { enforceRateLimit } from "../ratelimit/limits";
import { findVisibleShare, notCreator } from "./read";

/**
 * Ending shares (DEC-016): app.end_share() is the only path. Access ends at once: every request
 * checks the share's status and expiry. The same transaction writes the deletion requests to the
 * outbox (app.object_deletions), and the storage janitor deletes the objects within about a
 * minute: it is the one deletion executor (phase 3, owner decision D-1). Upload URLs can't be
 * revoked, so while one may still be live the janitor overwrites the object with an empty
 * tombstone first (review M1). The R2 lifecycle rule stays the backstop.
 *
 * Phase 4 (P4-17, §17.11.1): a room's owner may also delete the room's shares (deleted_by_owner); its creator
 * may delete a room share even after leaving the room (D4-15).
 */

/** DELETE /shares/{id}: the creator (T-011), or the owner of the share's room. */
export async function deleteShare(caller: Caller, network: NetworkView, shareId: string): Promise<void> {
  const share = await findVisibleShare(caller, network, shareId);
  if (!share) throw notFound();
  const byRoomOwner = !share.isCreator && share.room?.role === "owner";
  if (!share.isCreator && !byRoomOwner) throw notCreator();
  await enforceRateLimit("deleteShare", caller.principal.userId);

  await getDb().transaction().execute(async (trx) => {
    await sql`select app.end_share(${share.id}::uuid, ${byRoomOwner ? "deleted_by_owner" : "deleted_by_creator"})`.execute(trx);
    await audit(trx, {
      action: "share.deleted",
      actorUserId: caller.principal.userId,
      actorDeviceId: caller.device.id,
      networkSpaceId: share.networkSpaceId,
      targetType: "share",
      targetId: share.id,
      ...(byRoomOwner ? { metadata: { by: "room_owner" } } : {}),
    });
  });
}
