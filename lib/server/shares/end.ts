import "server-only";
import { sql } from "kysely";
import { after } from "next/server";
import { audit } from "../audit/log";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import type { Env } from "../env";
import { log } from "../log";
import type { NetworkView } from "../network/current";
import { enforceRateLimit } from "../ratelimit/limits";
import { deleteObject, putTombstone } from "../storage/s3";
import { requireOwnShare } from "./read";

/**
 * Ending shares (DEC-016): app.end_share() is the only path. It writes deletion requests to
 * the outbox in the same transaction; Phase 1 then executes them best-effort right away
 * (04 §9.2), and sweeps a few due ones after each response. Anything left over is retried by
 * the Phase 3 janitor; the R2 lifecycle rule is the backstop.
 *
 * Upload URLs can't be revoked. While one may still be live for an object, the object is
 * overwritten with an empty tombstone instead of deleted, so the write-once URL can't put
 * bytes back (review M1); the tombstone is deleted once every URL has expired.
 */

const SHARE_BATCH = 100; // more than the 20 files a share can hold
const SWEEP_BATCH = 10;

type ClaimedDeletion = {
  id: string;
  object_key: string;
  source_file_id: string | null;
  /** Set while an upload URL may still be live: write a tombstone and come back then. */
  hold_until: Date | null;
  tombstoned: boolean;
};

async function claimDeletions(shareId: string | null, limit: number): Promise<ClaimedDeletion[]> {
  const { rows } = await sql<ClaimedDeletion>`
    select * from app.claim_object_deletions(${shareId}::uuid, ${limit}::integer)
  `.execute(getDb());
  return rows;
}

async function executeDeletion(env: Env, row: ClaimedDeletion): Promise<void> {
  const db = getDb();
  try {
    if (row.hold_until) {
      if (!row.tombstoned) await putTombstone(env, row.object_key);
      await db
        .updateTable("app.object_deletions")
        .set({ tombstoned_at: sql`coalesce(tombstoned_at, now())`, not_before: row.hold_until, locked_until: null })
        .where("id", "=", row.id)
        .execute();
    } else {
      await deleteObject(env, row.object_key);
      await db.updateTable("app.object_deletions").set({ completed_at: sql`now()`, locked_until: null }).where("id", "=", row.id).execute();
    }
    // The content is gone either way.
    if (row.source_file_id) {
      await db
        .updateTable("app.files")
        .set({ object_deleted_at: sql`coalesce(object_deleted_at, now())` })
        .where("id", "=", row.source_file_id)
        .execute();
    }
  } catch (error) {
    log.warn("storage.delete_failed", { objectDeletionId: row.id, err: error });
    await db
      .updateTable("app.object_deletions")
      .set({ attempts: sql`attempts + 1`, last_error: String((error as Error).name ?? "error").slice(0, 200), locked_until: null })
      .where("id", "=", row.id)
      .execute();
  }
}

/** A few due deletions of any share: expired holds, earlier failures, shares the jobs ended. */
export async function sweepDueDeletions(env: Env): Promise<void> {
  try {
    for (const row of await claimDeletions(null, SWEEP_BATCH)) await executeDeletion(env, row);
  } catch (error) {
    log.warn("storage.sweep_failed", { err: error });
  }
}

/** Delete (or tombstone) the share's queued objects now. Failures stay queued; access is already denied. */
export async function executePendingDeletions(env: Env, shareId: string): Promise<void> {
  for (const row of await claimDeletions(shareId, SHARE_BATCH)) await executeDeletion(env, row);
  after(() => sweepDueDeletions(env));
}

/** DELETE /shares/{id}: creator only (T-011). */
export async function deleteShare(caller: Caller, network: NetworkView, shareId: string, env: Env): Promise<void> {
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
  await executePendingDeletions(env, share.id);
}
