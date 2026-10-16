import "server-only";
import { sql } from "kysely";
import { audit } from "../audit/log";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import type { NetworkView } from "../network/current";
import { enforceRateLimit } from "../ratelimit/limits";
import { requireOwnShare } from "./read";

/**
 * Ending shares (DEC-016): app.end_share() is the only path. Access ends at once: every request
 * checks the share's status and expiry. The same transaction writes the deletion requests to the
 * outbox (app.object_deletions), and the storage janitor deletes the objects within about a
 * minute: it is the one deletion executor (phase 3, owner decision D-1). Upload URLs can't be
 * revoked, so while one may still be live the janitor overwrites the object with an empty
 * tombstone first (review M1). The R2 lifecycle rule stays the backstop.
 */

/** DELETE /shares/{id}: creator only (T-011). */
export async function deleteShare(caller: Caller, network: NetworkView, shareId: string): Promise<void> {
  const share = await requireOwnShare(caller, network, shareId);
  await enforceRateLimit("deleteShare", caller.principal.userId);

  await getDb().transaction().execute(async (trx) => {
    await sql`select app.end_share(${share.id}::uuid, 'deleted_by_creator')`.execute(trx);
    await audit(trx, {
      action: "share.deleted",
      actorUserId: caller.principal.userId,
      actorDeviceId: caller.device.id,
      networkSpaceId: share.networkSpaceId,
      targetType: "share",
      targetId: share.id,
    });
  });
}
