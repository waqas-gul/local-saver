import "server-only";
import { sql } from "kysely";
import type { ShareDto } from "@/lib/shared/api/schemas";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import { alreadyDownloaded, ApiError, notFound } from "../http/errors";
import { shareVisibility } from "../local/visibility";
import type { NetworkView } from "../network/current";
import { loadShareDto, loadShareDtos } from "./dto";

/**
 * Reading shares: detail, the local feed and My uploads. The feed applies the visibility
 * rule (03 §3.6) in SQL; details load the row and apply lib/server/local/visibility.ts
 * with the database clock. A claimed burn share stays in its claimant's feed and its creator's
 * My uploads while its grace lasts (phase 3 §17.8.7).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export type VisibleShare = {
  id: string;
  kind: string;
  scope: string;
  status: string;
  networkSpaceId: string | null;
  createdByUserId: string | null;
  isCreator: boolean;
  entitlementSnapshot: unknown;
  expiresAt: Date;
  /** Phase 3: burn after download. */
  burnAfterDownload: boolean;
  /** This device claimed the (burn) share. */
  isClaimant: boolean;
  claimGraceUntil: Date | null;
};

/**
 * The share if the caller may see it right now, otherwise null (callers answer 404). A burn share
 * someone else claimed (or that is consumed) answers 410 ALREADY_DOWNLOADED to callers who could
 * have seen it (phase 3 §17.8.4).
 */
export async function findVisibleShare(caller: Caller, network: NetworkView, shareId: string): Promise<VisibleShare | null> {
  if (!isUuid(shareId)) return null;
  const row = await getDb()
    .selectFrom("app.shares")
    .select([
      "id", "scope", "kind", "status", "expires_at", "network_space_id", "created_by_user_id", "entitlement_snapshot",
      "burn_after_download", "claimed_by_user_id", "claimed_device_id", "claim_grace_until",
      sql<Date>`now()`.as("db_now"),
    ])
    .where("id", "=", shareId)
    .executeTakeFirst();
  if (!row) return null;

  const visibility = shareVisibility(
    {
      scope: row.scope,
      status: row.status,
      expiresAt: row.expires_at,
      networkSpaceId: row.network_space_id,
      createdByUserId: row.created_by_user_id,
      claimedByUserId: row.claimed_by_user_id,
      claimedDeviceId: row.claimed_device_id,
      claimGraceUntil: row.claim_grace_until,
    },
    { userId: caller.principal.userId, deviceId: caller.device.id, eligibleSpaceIds: network.eligibleSpaceIds, now: row.db_now },
  );
  if (visibility === "downloaded_by_other") throw alreadyDownloaded(false);
  if (visibility === "downloaded_by_you") throw alreadyDownloaded(true);
  if (visibility !== "visible") return null;
  return {
    id: row.id,
    kind: row.kind,
    scope: row.scope,
    status: row.status,
    networkSpaceId: row.network_space_id,
    createdByUserId: row.created_by_user_id,
    isCreator: row.created_by_user_id === caller.principal.userId,
    entitlementSnapshot: row.entitlement_snapshot,
    expiresAt: row.expires_at as Date,
    burnAfterDownload: row.burn_after_download,
    isClaimant: row.claimed_by_user_id === caller.principal.userId && row.claimed_device_id === caller.device.id,
    claimGraceUntil: row.claim_grace_until,
  };
}

/** Visible share, or 404; and creator-only actions get 403 NOT_CREATOR (T-011, DEC-033). */
export async function requireOwnShare(caller: Caller, network: NetworkView, shareId: string): Promise<VisibleShare> {
  const share = await findVisibleShare(caller, network, shareId);
  if (!share) throw notFound();
  if (!share.isCreator) throw new ApiError(403, "NOT_CREATOR", "Only the person who posted this can change it");
  return share;
}

export async function getShare(caller: Caller, network: NetworkView, shareId: string): Promise<ShareDto> {
  const share = await findVisibleShare(caller, network, shareId);
  if (!share) throw notFound();
  return loadShareDto(getDb(), share.id, caller.principal.userId, caller.device.id);
}

// ------------------------------------------------------------------ pagination

type Cursor = { t: string; id: string };

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id } satisfies Cursor)).toString("base64url");
}

function decodeCursor(value: string | null): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    if (typeof parsed.t !== "string" || Number.isNaN(Date.parse(parsed.t)) || !isUuid(parsed.id)) throw new Error();
    return parsed;
  } catch {
    throw new ApiError(400, "INVALID_CURSOR", "Invalid cursor");
  }
}

export function pageParams(url: URL): { cursor: Cursor | null; limit: number } {
  const raw = url.searchParams.get("limit");
  const limit = raw === null ? DEFAULT_PAGE : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
    throw new ApiError(400, "INVALID_LIMIT", `limit must be between 1 and ${MAX_PAGE}`);
  }
  return { cursor: decodeCursor(url.searchParams.get("cursor")), limit };
}

async function page(
  ids: { id: string; created_at: Date }[],
  limit: number,
  caller: Caller,
): Promise<{ shares: ShareDto[]; nextCursor: string | null }> {
  const visible = ids.slice(0, limit);
  const dtos = await loadShareDtos(getDb(), visible.map((r) => r.id), caller.principal.userId, caller.device.id);
  const last = visible[visible.length - 1];
  return {
    shares: visible.map((r) => dtos.get(r.id)).filter((d): d is ShareDto => d !== undefined),
    nextCursor: ids.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

/**
 * GET /local/shares: active, unexpired shares of the caller's current eligible network only, plus
 * burn shares this device claimed, while their grace lasts (phase 3 §17.8.7).
 */
export async function listLocalFeed(caller: Caller, network: NetworkView, url: URL) {
  const { cursor, limit } = pageParams(url);
  if (network.eligibleSpaceIds.length === 0) return { networkStatus: network.status, shares: [], nextCursor: null };

  let query = getDb()
    .selectFrom("app.shares")
    .select(["id", "created_at"])
    .where("scope", "=", "network")
    .where("network_space_id", "in", network.eligibleSpaceIds)
    .where((eb) =>
      eb.or([
        eb("status", "=", "active"),
        eb.and([
          eb("status", "=", "claimed"),
          eb("claimed_by_user_id", "=", caller.principal.userId),
          eb("claimed_device_id", "=", caller.device.id),
          sql<boolean>`claim_grace_until > now()`,
        ]),
      ]),
    )
    .where(sql<boolean>`expires_at > now()`)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(limit + 1);
  if (cursor) {
    query = query.where(sql<boolean>`(created_at, id) < (${new Date(cursor.t)}, ${cursor.id}::uuid)`);
  }
  return { networkStatus: network.status, ...(await page(await query.execute(), limit, caller)) };
}

/** GET /me/shares: the caller's own open shares, from any network (T-014); claimed ones while their grace lasts. */
export async function listMyShares(caller: Caller, url: URL) {
  const { cursor, limit } = pageParams(url);
  let query = getDb()
    .selectFrom("app.shares")
    .select(["id", "created_at"])
    .where("created_by_user_id", "=", caller.principal.userId)
    .where((eb) => eb.or([eb("status", "in", ["pending_upload", "active"]), eb.and([eb("status", "=", "claimed"), sql<boolean>`claim_grace_until > now()`])]))
    .where(sql<boolean>`expires_at > now()`)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(limit + 1);
  if (cursor) {
    query = query.where(sql<boolean>`(created_at, id) < (${new Date(cursor.t)}, ${cursor.id}::uuid)`);
  }
  return page(await query.execute(), limit, caller);
}
