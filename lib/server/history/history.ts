import "server-only";
import { sql } from "kysely";
import {
  HISTORY_STATUS_FILTERS,
  type DownloadActorKind,
  type DownloadEvent,
  type HistoryDownloadsResponse,
  type HistorySharesResponse,
  type ShareEndReason,
} from "@/lib/shared/api/schemas";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import { assertFeature } from "../entitlements/enforce";
import { resolveEntitlements } from "../entitlements/resolve";
import { ApiError, notFound } from "../http/errors";
import { encodeCursor, isUuid, pageParams } from "../shares/read";

/**
 * Transfer history (phase 4 §17.8.6, P4-20, E24): queries only, over the rows the app already keeps.
 *
 * - **Whose:** the caller's own shares (`created_by_user_id`), and the download records of those shares only. No
 *   route takes a user ID; another user's `shareId` is the unknown share's 404.
 * - **How far back:** the current plan's `historyRetentionDays` (Pro 365, Q-015), counted from when the share was made
 *   or the record written. A plan without `transferHistory` gets 403 (07 §5: after a downgrade history is hidden; the
 *   rows stay until their snapshot dates, purge_tombstones).
 * - **What, never who (D4-20):** actor kinds only. No user, device or network IDs, no IP, no display or device names,
 *   no text content. A link viewer's link is shown by kind, and by ID only when the caller made the link (a room
 *   link, or a share link the room's owner made, is someone else's).
 */

const DOWNLOAD_ID = /^[1-9][0-9]{0,18}$/;
const OPEN_STATUSES = ["pending_upload", "active", "claimed"];

/** E24: the plan has history; the window is the current plan's, in days. */
async function historyDays(caller: Caller): Promise<number> {
  const entitlements = await resolveEntitlements(caller.principal);
  assertFeature(entitlements, "transferHistory", "Transfer history isn't available on your plan");
  return entitlements.limits.historyRetentionDays;
}

function queryFilter<T extends string>(url: URL, name: string, allowed: readonly T[]): T | null {
  const value = url.searchParams.get(name);
  if (value === null) return null;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new ApiError(400, "VALIDATION_FAILED", "Request query failed validation", [{ path: name, code: "invalid_value" }]);
}

type ShareRow = {
  id: string;
  kind: "files" | "text";
  scope: "network" | "link_only" | "room";
  title: string | null;
  first_file_name: string | null;
  room_id: string | null;
  room_label: string | null;
  created_at: Date;
  expires_at: Date | null;
  status: HistorySharesResponse["items"][number]["status"];
  ended_at: Date | null;
  end_reason: ShareEndReason | null;
  burn_after_download: boolean;
  file_count: number;
  total_bytes: string;
};

/**
 * GET /history/shares?cursor&limit&status&kind (T4-H1): every state, newest first. A share still open in the table
 * but past its time reads as the job will leave it: a claimed burn share past its grace as consumed, any other open
 * share past its expiry as expired, ended then.
 */
export async function listShareHistory(caller: Caller, url: URL): Promise<HistorySharesResponse> {
  const days = await historyDays(caller);
  const { cursor, limit } = pageParams(url);
  const status = queryFilter(url, "status", HISTORY_STATUS_FILTERS);
  const kind = queryFilter(url, "kind", ["files", "text"] as const);
  const open = sql.join(OPEN_STATUSES);
  const { rows } = await sql<ShareRow>`
    select s.id, s.kind, s.scope, s.title, f.original_name as first_file_name, s.room_id, r.label as room_label,
           s.created_at, s.expires_at, v.status, v.ended_at, v.end_reason, s.burn_after_download, s.file_count, s.total_bytes
      from app.shares s
      left join app.rooms r on r.id = s.room_id
      left join lateral (select original_name from app.files where share_id = s.id order by position, id limit 1) f on true
      cross join lateral (
        select case when s.status = 'claimed' and s.claim_grace_until <= now() then 'consumed'
                    when s.status in (${open}) and s.expires_at <= now() then 'expired'
                    else s.status end as status,
               case when s.status = 'claimed' and s.claim_grace_until <= now() then s.claim_grace_until
                    when s.status in (${open}) and s.expires_at <= now() then s.expires_at
                    else s.ended_at end as ended_at,
               case when s.status = 'claimed' and s.claim_grace_until <= now() then 'consumed'
                    when s.status in (${open}) and s.expires_at <= now() then 'expired'
                    else s.end_reason end as end_reason
      ) v
     where s.created_by_user_id = ${caller.principal.userId}::uuid
       and s.created_at > now() - make_interval(days => ${days})
       ${status === "active" ? sql`and v.status in (${open})` : status === "ended" ? sql`and v.status not in (${open})` : sql``}
       ${kind ? sql`and s.kind = ${kind}` : sql``}
       ${cursor ? sql`and (s.created_at, s.id) < (${new Date(cursor.t)}, ${cursor.id}::uuid)` : sql``}
     order by s.created_at desc, s.id desc
     limit ${limit + 1}
  `.execute(getDb());
  const visible = rows.slice(0, limit);
  const last = visible[visible.length - 1];
  return {
    items: visible.map((s) => ({
      id: s.id,
      kind: s.kind,
      title: s.title ?? s.first_file_name,
      scope: s.scope,
      ...(s.room_id && s.room_label !== null ? { room: { id: s.room_id, label: s.room_label } } : {}),
      status: s.status,
      createdAt: s.created_at.toISOString(),
      expiresAt: s.expires_at?.toISOString() ?? null,
      endedAt: s.ended_at?.toISOString() ?? null,
      endReason: s.end_reason,
      burnAfterDownload: s.burn_after_download,
      fileCount: s.file_count,
      totalBytes: Number(s.total_bytes),
    })),
    nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

type DownloadRow = {
  id: string;
  created_at: Date;
  event: DownloadEvent;
  actor_kind: DownloadActorKind;
  user_agent_family: string | null;
  share_id: string;
  share_title: string | null;
  share_first_file: string | null;
  file_id: string | null;
  file_name: string | null;
  link_kind: "share" | "room" | null;
  own_link_id: string | null;
};

/**
 * GET /history/downloads?cursor&limit&shareId (T4-H2): download and preview URLs issued, burn claims, retries and
 * reveals on the caller's own shares, newest first. `shareId` narrows it to one of them; any other value is a 404.
 */
export async function listDownloadHistory(caller: Caller, url: URL): Promise<HistoryDownloadsResponse> {
  const days = await historyDays(caller);
  const { cursor, limit } = pageParams(url, (id) => DOWNLOAD_ID.test(id));
  const shareId = url.searchParams.get("shareId");
  if (shareId !== null) {
    const own = isUuid(shareId)
      ? await getDb()
          .selectFrom("app.shares")
          .select("id")
          .where("id", "=", shareId)
          .where("created_by_user_id", "=", caller.principal.userId)
          .executeTakeFirst()
      : undefined;
    if (!own) throw notFound();
  }
  const me = caller.principal.userId;
  const { rows } = await sql<DownloadRow>`
    select d.id::text as id, d.created_at, d.event, d.actor_kind, d.user_agent_family, d.share_id,
           s.title as share_title, sf.original_name as share_first_file, d.file_id, f.original_name as file_name,
           l.target_type as link_kind, case when l.created_by_user_id = ${me}::uuid then l.id end as own_link_id
      from app.downloads d
      join app.shares s on s.id = d.share_id
      left join app.files f on f.id = d.file_id
      left join lateral (select original_name from app.files where share_id = s.id order by position, id limit 1) sf on true
      left join app.share_links l on l.id = d.link_id and d.actor_kind = 'link_viewer'
     where s.created_by_user_id = ${me}::uuid
       and d.created_at > now() - make_interval(days => ${days})
       ${shareId !== null ? sql`and d.share_id = ${shareId}::uuid` : sql``}
       ${cursor ? sql`and (d.created_at, d.id) < (${new Date(cursor.t)}, ${cursor.id}::bigint)` : sql``}
     order by d.created_at desc, d.id desc
     limit ${limit + 1}
  `.execute(getDb());
  const visible = rows.slice(0, limit);
  const last = visible[visible.length - 1];
  return {
    items: visible.map((d) => ({
      id: d.id,
      at: d.created_at.toISOString(),
      share: { id: d.share_id, title: d.share_title ?? d.share_first_file },
      file: d.file_id && d.file_name !== null ? { id: d.file_id, name: d.file_name } : null,
      event: d.event,
      actorKind: d.actor_kind,
      link: d.link_kind ? { kind: d.link_kind, id: d.own_link_id } : null,
      browser: d.user_agent_family,
    })),
    nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  };
}
