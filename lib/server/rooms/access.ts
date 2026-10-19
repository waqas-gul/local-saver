import "server-only";
import { sql, type Transaction } from "kysely";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import type { DB } from "../db/types.gen";
import { ApiError, notFound, notOwner } from "../http/errors";

/**
 * Room access (phase 4 §17.11). A room is found only through the caller's own active membership of it
 * (§17.11.2): a room ID alone opens nothing, and a non-member, a removed member, another room's member and an
 * unknown ID all get the same 404. Members asking for an owner's action get 403 NOT_OWNER: they can already see
 * the room. Room shares use the same membership (lib/server/local/visibility.ts), and posting re-checks it under
 * row locks in the share's own transaction (lockRoomForPosting), so a removal or a deletion in progress wins.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RoomRole = "owner" | "member";

export type RoomAccess = {
  id: string;
  role: RoomRole;
  label: string;
  labelIsCustom: boolean;
  membersCanCreateLinks: boolean;
  defaultExpirySeconds: number | null;
  createdAt: Date;
};

/** The open room if `userId` is an active member of it, otherwise null. */
export async function findRoom(userId: string, roomId: string): Promise<RoomAccess | null> {
  if (!UUID.test(roomId)) return null;
  const row = await getDb()
    .selectFrom("app.rooms as r")
    .innerJoin("app.room_members as m", "m.room_id", "r.id")
    .select(["r.id", "m.role", "r.label", "r.label_is_custom", "r.members_can_create_links", "r.default_expiry_seconds", "r.created_at"])
    .where("r.id", "=", roomId)
    .where("m.user_id", "=", userId)
    .where("r.deleted_at", "is", null)
    .where("m.removed_at", "is", null)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    role: row.role as RoomRole,
    label: row.label,
    labelIsCustom: row.label_is_custom,
    membersCanCreateLinks: row.members_can_create_links,
    defaultExpirySeconds: row.default_expiry_seconds,
    createdAt: row.created_at,
  };
}

/** Every room route: the caller's room, or 404; with `owner`, members get 403 NOT_OWNER. */
export async function requireRoom(caller: Caller, roomId: string, options: { owner?: boolean } = {}): Promise<RoomAccess> {
  const room = await findRoom(caller.principal.userId, roomId);
  if (!room) throw notFound();
  if (options.owner && room.role !== "owner") throw notOwner();
  return room;
}

/**
 * Inside the transaction that inserts a room share: the room is still open and the poster still in it. The room
 * row is held FOR KEY SHARE and the member row FOR SHARE, so a deletion (room FOR UPDATE) or a removal (member row
 * update) in progress finishes first, and this then sees it (READ COMMITTED re-checks the locked rows).
 */
export async function lockRoomForPosting(trx: Transaction<DB>, roomId: string, userId: string): Promise<void> {
  const { rows } = await sql`
    select 1
      from app.rooms r
      join app.room_members m on m.room_id = r.id
     where r.id = ${roomId}::uuid and m.user_id = ${userId}::uuid and r.deleted_at is null and m.removed_at is null
       for key share of r
       for share of m
  `.execute(trx);
  if (rows.length === 0) throw notFound();
}

/**
 * A room share's creator who is no longer in its room keeps their creator rights (D4-15: delete it, and manage the
 * links they made) but can't put anything new in front of the room: edit its text, finish its upload, extend it or
 * make a new link to it.
 */
export function notRoomMember(): ApiError {
  return new ApiError(403, "NOT_ROOM_MEMBER", "You're no longer in this room");
}
