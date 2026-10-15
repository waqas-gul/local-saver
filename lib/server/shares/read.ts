import "server-only";
import { sql } from "kysely";
import type { ShareDto } from "@/lib/shared/api/schemas";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import { ApiError, notFound } from "../http/errors";
import { isShareVisible } from "../local/visibility";
import type { NetworkView } from "../network/current";
import { loadShareDto, loadShareDtos } from "./dto";

/**
 * Reading shares: detail, the local feed and My uploads. The feed applies the visibility
 * rule (03 §3.6) in SQL; details load the row and apply lib/server/local/visibility.ts
 * with the database clock.
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
  status: string;
  networkSpaceId: string | null;
  createdByUserId: string | null;
  isCreator: boolean;
  entitlementSnapshot: unknown;
};

/** The share if the caller may see it right now, otherwise null (callers answer 404). */
export async function findVisibleShare(caller: Caller, network: NetworkView, shareId: string): Promise<VisibleShare | null> {
  if (!isUuid(shareId)) return null;
  const row = await getDb()
    .selectFrom("app.shares")
    .select([
      "id", "scope", "kind", "status", "expires_at", "network_space_id", "created_by_user_id", "entitlement_snapshot",
      sql<Date>`now()`.as("db_now"),
    ])
    .where("id", "=", shareId)
    .executeTakeFirst();
  if (!row) return null;

  const visible = isShareVisible(
    {
      scope: row.scope,
      status: row.status,
      expiresAt: row.expires_at,
      networkSpaceId: row.network_space_id,
      createdByUserId: row.created_by_user_id,
    },
    { userId: caller.principal.userId, eligibleSpaceIds: network.eligibleSpaceIds, now: row.db_now },
  );
  if (!visible) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    networkSpaceId: row.network_space_id,
    createdByUserId: row.created_by_user_id,
    isCreator: row.created_by_user_id === caller.principal.userId,
    entitlementSnapshot: row.entitlement_snapshot,
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
  return loadShareDto(getDb(), share.id, caller.principal.userId);
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
  viewerUserId: string,
): Promise<{ shares: ShareDto[]; nextCursor: string | null }> {
  const visible = ids.slice(0, limit);
  const dtos = await loadShareDtos(getDb(), visible.map((r) => r.id), viewerUserId);
  const last = visible[visible.length - 1];
  return {
    shares: visible.map((r) => dtos.get(r.id)).filter((d): d is ShareDto => d !== undefined),
    nextCursor: ids.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

/** GET /local/shares: active, unexpired shares of the caller's current eligible network only. */
export async function listLocalFeed(caller: Caller, network: NetworkView, url: URL) {
  const { cursor, limit } = pageParams(url);
  if (network.eligibleSpaceIds.length === 0) return { networkStatus: network.status, shares: [], nextCursor: null };

  let query = getDb()
    .selectFrom("app.shares")
    .select(["id", "created_at"])
    .where("scope", "=", "network")
    .where("network_space_id", "in", network.eligibleSpaceIds)
    .where("status", "=", "active")
    .where(sql<boolean>`expires_at > now()`)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(limit + 1);
  if (cursor) {
    query = query.where(sql<boolean>`(created_at, id) < (${new Date(cursor.t)}, ${cursor.id}::uuid)`);
  }
  return { networkStatus: network.status, ...(await page(await query.execute(), limit, caller.principal.userId)) };
}

/** GET /me/shares: the caller's own open shares, from any network (T-014). */
export async function listMyShares(caller: Caller, url: URL) {
  const { cursor, limit } = pageParams(url);
  let query = getDb()
    .selectFrom("app.shares")
    .select(["id", "created_at"])
    .where("created_by_user_id", "=", caller.principal.userId)
    .where("status", "in", ["pending_upload", "active"])
    .where(sql<boolean>`expires_at > now()`)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(limit + 1);
  if (cursor) {
    query = query.where(sql<boolean>`(created_at, id) < (${new Date(cursor.t)}, ${cursor.id}::uuid)`);
  }
  return page(await query.execute(), limit, caller.principal.userId);
}
