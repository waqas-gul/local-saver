import "server-only";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "../db/types.gen";
import { assertFeature } from "../entitlements/enforce";
import { snapshotFor } from "../entitlements/snapshot";
import type { Entitlements, Snapshot } from "../entitlements/types";
import type { Env } from "../env";
import { getRuntimeFlags } from "../flags";
import { alreadyDownloaded, ApiError } from "../http/errors";
import { log } from "../log";

/**
 * Burn after download (DEC-015; 03 §5; phase 3 §17.8–§17.10).
 *
 * Who may create one (Q-008, owner decision 2026-10-16): the Pro plan at paid launch
 * (features.burnAfterDownload, E10); during beta and testing the Free plan while the runtime flag
 * free_burn_after_download is on (off by default). burn_after_download_enabled is the kill switch
 * for new burn shares, Pro included. Only creation is gated: claims and retries rely on the share's
 * own row and snapshot, never on the plan again (07 §5).
 *
 * The claim is app.claim_burn_share: one conditional UPDATE under the share's row lock, called
 * inside the request's transaction at READ COMMITTED (the function refuses anything stricter).
 * Callers check visibility (device) or the link grant (viewer) first and presign before commit,
 * so a failed presign rolls the claim back. Nothing reads the state first and decides after.
 */

export const BURN_MAX_ISSUANCES = 3;

type Db = Kysely<DB> | Transaction<DB>;

/** Whether this plan may create burn shares right now (the UI asks through GET /me/entitlements). */
export async function burnAvailable(entitlements: Entitlements, env: Env): Promise<boolean> {
  const flags = await getRuntimeFlags(env);
  return flags.burnAfterDownloadEnabled && (entitlements.features.burnAfterDownload || (entitlements.plan === "free" && flags.freeBurnAfterDownload));
}

/**
 * The gate at share creation. Returns the entitlement snapshot (v2) to store with the share: when
 * burn was granted, the snapshot says so, whatever granted it (plan or beta flag).
 */
export async function burnSnapshot(entitlements: Entitlements, env: Env, requested: boolean | undefined): Promise<Snapshot> {
  if (!requested) return snapshotFor(entitlements);
  const flags = await getRuntimeFlags(env);
  if (!flags.burnAfterDownloadEnabled) {
    throw new ApiError(503, "BURN_AFTER_DOWNLOAD_DISABLED", "Burn after download is paused right now");
  }
  if (!(entitlements.plan === "free" && flags.freeBurnAfterDownload)) {
    assertFeature(entitlements, "burnAfterDownload", "Burn after download isn't available on your plan");
  }
  return snapshotFor({ ...entitlements, features: { ...entitlements.features, burnAfterDownload: true } });
}

export type Claimant =
  | { kind: "device"; userId: string; deviceId: string }
  | { kind: "viewer"; sessionHash: Buffer; linkId: string };

export type BurnPurpose = { kind: "file"; fileId: string; urlTtlSeconds: number } | { kind: "text" };

export type BurnIssuance = { availableUntil: Date; left: number; claimed: boolean };

type ClaimRow = {
  outcome: "claimed" | "retry" | "retry_limit" | "already_downloaded" | "not_claimable";
  claim_grace_until: Date | null;
  issuance: number;
  by_you: boolean;
};

/**
 * Claim the share or use one of the claimant's retries, in `trx`. `notClaimable` is what the caller
 * answers when the share is no longer an active burn share (it ended or expired meanwhile).
 */
export async function claimOrRetry(
  trx: Transaction<DB>,
  shareId: string,
  claimant: Claimant,
  purpose: BurnPurpose,
  userAgentFamily: string | null,
  notClaimable: () => ApiError,
): Promise<BurnIssuance> {
  const device = claimant.kind === "device" ? claimant : null;
  const viewer = claimant.kind === "viewer" ? claimant : null;
  const { rows } = await sql<ClaimRow>`
    select outcome, claim_grace_until, issuance, by_you
      from app.claim_burn_share(
        ${shareId}::uuid,
        ${purpose.kind === "file" ? purpose.fileId : null}::uuid,
        ${purpose.kind},
        ${device?.userId ?? null}::uuid,
        ${device?.deviceId ?? null}::uuid,
        ${viewer?.sessionHash ?? null}::bytea,
        ${viewer?.linkId ?? null},
        ${purpose.kind === "file" ? purpose.urlTtlSeconds : null}::integer,
        ${userAgentFamily})
  `.execute(trx);
  const row = rows[0];
  switch (row?.outcome) {
    case "claimed":
    case "retry":
      if (row.outcome === "claimed") log.info("burn.claimed", { shareId, claimant: claimant.kind, purpose: purpose.kind });
      return { availableUntil: row.claim_grace_until as Date, left: Math.max(0, BURN_MAX_ISSUANCES - row.issuance), claimed: row.outcome === "claimed" };
    case "retry_limit":
      throw new ApiError(409, "BURN_RETRY_LIMIT", purpose.kind === "text" ? "You've revealed this the maximum number of times" : "You've used every download of this file", {
        max: BURN_MAX_ISSUANCES,
      });
    case "already_downloaded":
      throw alreadyDownloaded(row.by_you);
    default:
      throw notClaimable();
  }
}

/** A burn claim needs the client to say it means it (phase 3 §17.8.8): GETs and unaware clients never claim. */
export function requireConfirmation(confirm: boolean | undefined, purpose: "file" | "text"): void {
  if (confirm !== true) {
    throw new ApiError(
      409,
      "CONFIRMATION_REQUIRED",
      purpose === "text" ? "Revealing this deletes it for everyone else: confirm first" : "Downloading this deletes it for everyone else: confirm first",
    );
  }
}

/** Issuances the claimant has used, per file (and "text" for reveals), for downloadsLeft and revealsLeft. */
export async function issuancesUsed(db: Db, shareIds: string[]): Promise<Map<string, Map<string, number>>> {
  const result = new Map<string, Map<string, number>>();
  if (shareIds.length === 0) return result;
  const rows = await db
    .selectFrom("app.downloads")
    .select(["share_id", "file_id", "event", sql<number>`count(*)::int`.as("n")])
    .where("share_id", "in", shareIds)
    .where("event", "in", ["burn_claimed", "burn_retry", "text_revealed"])
    .groupBy(["share_id", "file_id", "event"])
    .execute();
  for (const row of rows) {
    const perShare = result.get(row.share_id) ?? new Map<string, number>();
    const key = row.event === "text_revealed" ? "text" : (row.file_id as string);
    perShare.set(key, (perShare.get(key) ?? 0) + row.n);
    result.set(row.share_id, perShare);
  }
  return result;
}

export function left(used: number | undefined): number {
  return Math.max(0, BURN_MAX_ISSUANCES - (used ?? 0));
}

/**
 * "I've got it": the claimant ends the share now (end_share 'consumed'; the objects go 5 minutes
 * later). Repeating it answers the same. Anyone else gets `notClaimant()`.
 */
export async function confirmBurnReceived(
  db: Kysely<DB>,
  shareId: string,
  claimant: Claimant,
  notClaimant: () => ApiError,
): Promise<"consumed" | "already_consumed"> {
  const device = claimant.kind === "device" ? claimant : null;
  const viewer = claimant.kind === "viewer" ? claimant : null;
  const { rows } = await sql<{ result: string }>`
    select app.confirm_burn_received(${shareId}::uuid, ${device?.userId ?? null}::uuid, ${device?.deviceId ?? null}::uuid,
                                     ${viewer?.sessionHash ?? null}::bytea) as result
  `.execute(db);
  const result = rows[0]?.result;
  if (result === "consumed" || result === "already_consumed") return result;
  throw notClaimant();
}
