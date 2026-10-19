import "server-only";
import { sql } from "kysely";
import type { RoomMemberDto } from "@/lib/shared/api/schemas";
import { audit } from "../audit/log";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import { ApiError, notFound, notOwner } from "../http/errors";
import { enforceRateLimit } from "../ratelimit/limits";
import { requireRoom, type RoomRole } from "./access";

/**
 * Room members (phase 4 §17.8.4, §17.11; D4-15, D4-18). Members see each other as an opaque memberId (C4-18), a role,
 * when they joined and a label: the account's display name, or the name of the device an anonymous member joined
 * from. Never an email, a user ID, a network or presence. A member ID is looked up only inside the caller's own
 * room, so another room's member ID answers 404 (T4-R2).
 *
 * Leaving and removal take effect at the next request: every room route and room share re-reads the membership.
 * Realtime tells the room (member.changed) and the person (membership.changed); a channel already joined keeps
 * ID-only signals until its token refreshes (RISK-007). The owner can't leave (D4-18): deleting the room is the way.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** OWNER REVIEW: the label of a member whose name and joining device are both gone. */
const UNNAMED_MEMBER = "Member";

export async function listMembers(caller: Caller, roomId: string): Promise<RoomMemberDto[]> {
  const room = await requireRoom(caller, roomId);
  const rows = await getDb()
    .selectFrom("app.room_members as m")
    .leftJoin("app.profiles as p", "p.user_id", "m.user_id")
    .leftJoin("app.devices as d", "d.id", "m.joined_device_id")
    .select(["m.id", "m.role", "m.joined_at", "m.user_id", "p.display_name", "d.label as device_label"])
    .where("m.room_id", "=", room.id)
    .where("m.removed_at", "is", null)
    .orderBy(sql`m.role = 'owner'`, "desc")
    .orderBy("m.joined_at")
    .orderBy("m.id")
    .execute();
  return rows.map((row) => ({
    memberId: row.id,
    role: row.role as RoomRole,
    label: row.display_name ?? row.device_label ?? UNNAMED_MEMBER,
    joinedAt: row.joined_at.toISOString(),
    isYou: row.user_id === caller.principal.userId,
  }));
}

function ownerCannotLeave(): ApiError {
  return new ApiError(409, "OWNER_CANNOT_LEAVE", "The owner can't leave the room. Delete it instead.");
}

/**
 * DELETE /rooms/{roomId}/members/{memberId}: a member leaves (`me`, or their own memberId); the owner removes anyone
 * else. Another member's ID from a member is 403 NOT_OWNER (they can see the member list); an ID that isn't an
 * active member of this room is 404.
 */
export async function removeMember(caller: Caller, roomId: string, memberId: string): Promise<void> {
  const room = await requireRoom(caller, roomId);
  await enforceRateLimit("removeMember", caller.principal.userId);
  const db = getDb();

  let target: { id: string; user_id: string; role: string } | undefined;
  if (memberId === "me") {
    target = await db
      .selectFrom("app.room_members")
      .select(["id", "user_id", "role"])
      .where("room_id", "=", room.id)
      .where("user_id", "=", caller.principal.userId)
      .where("removed_at", "is", null)
      .executeTakeFirst();
  } else if (UUID.test(memberId)) {
    target = await db
      .selectFrom("app.room_members")
      .select(["id", "user_id", "role"])
      .where("id", "=", memberId)
      .where("room_id", "=", room.id)
      .where("removed_at", "is", null)
      .executeTakeFirst();
  }
  if (!target) throw notFound();
  const member = target;

  const self = member.user_id === caller.principal.userId;
  if (self && member.role === "owner") throw ownerCannotLeave();
  if (!self && room.role !== "owner") throw notOwner();

  await db.transaction().execute(async (trx) => {
    const removed = await trx
      .updateTable("app.room_members")
      .set({ removed_at: sql`now()`, removed_reason: self ? "left" : "removed", removed_by_user_id: caller.principal.userId })
      .where("id", "=", member.id)
      .where("removed_at", "is", null)
      .where("role", "=", "member")
      .returning("id")
      .executeTakeFirst();
    // Already gone (removed, left, or the room deleted meanwhile).
    if (!removed) throw notFound();
    await audit(trx, {
      action: "member.removed",
      actorUserId: caller.principal.userId,
      actorDeviceId: caller.device.id,
      networkSpaceId: null,
      targetType: "room",
      targetId: room.id,
      metadata: { memberId: member.id, by: self ? "self" : "owner" },
    });
  });
}
