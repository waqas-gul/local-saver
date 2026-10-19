import "server-only";
import { sql } from "kysely";
import type { z } from "zod";
import type { createRoomBody, RoomDto, ShareDto, updateRoomBody } from "@/lib/shared/api/schemas";
import { audit } from "../audit/log";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import { assertFeature, assertNotDeletionPending, assertOption } from "../entitlements/enforce";
import { resolveEntitlements } from "../entitlements/resolve";
import { snapshotFor } from "../entitlements/snapshot";
import { ApiError, notFound } from "../http/errors";
import { assertNotRestricted } from "../policy/posting";
import { enforceRateLimit } from "../ratelimit/limits";
import { encodeCursor, listRoomFeed, pageParams } from "../shares/read";
import { requireRoom, type RoomAccess, type RoomRole } from "./access";
import { generateRoomLabel, roomLabelFrom } from "./labels";

/**
 * Private rooms (phase 4 §17.8.4, §17.11; P4-17). A room is a membership space reachable from any network, never a
 * network feed. Creating one needs Pro (E17), a custom name too (E18); the owner's limits at creation are its
 * snapshot (its member cap, D4-14), and a downgraded owner's room stays usable (§17.16). Only the owner changes its
 * settings or deletes it (D4-18: no transfer); members see the room, never who is where (G-R4).
 */

const ROOMS_NOT_IN_PLAN = "Private rooms are not in your plan";
const NAMES_NOT_IN_PLAN = "Custom room names are not in your plan";

function roomDto(room: Pick<RoomAccess, "id" | "role" | "label" | "membersCanCreateLinks" | "defaultExpirySeconds" | "createdAt">, memberCount: number): RoomDto {
  return {
    id: room.id,
    label: room.label,
    role: room.role,
    memberCount,
    settings: { membersCanCreateLinks: room.membersCanCreateLinks, defaultExpirySeconds: room.defaultExpirySeconds },
    createdAt: room.createdAt.toISOString(),
  };
}

async function memberCount(roomId: string): Promise<number> {
  const row = await getDb()
    .selectFrom("app.room_members")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("room_id", "=", roomId)
    .where("removed_at", "is", null)
    .executeTakeFirstOrThrow();
  return row.n;
}

/** GET /rooms/{roomId} (members); also what accepting an invite returns. */
export async function getRoom(caller: Caller, roomId: string): Promise<RoomDto> {
  const room = await requireRoom(caller, roomId);
  return roomDto(room, await memberCount(room.id));
}

/** POST /rooms (Pro, E17; a name: customRoomNames, E18). Restricted and deletion-pending accounts can't (E29, E30). */
export async function createRoom(caller: Caller, body: z.infer<typeof createRoomBody>): Promise<RoomDto> {
  const entitlements = await resolveEntitlements(caller.principal);
  assertFeature(entitlements, "privateRooms", ROOMS_NOT_IN_PLAN);
  assertNotDeletionPending(entitlements);
  await assertNotRestricted(caller);
  const custom = body.name !== undefined;
  if (custom) assertFeature(entitlements, "customRoomNames", NAMES_NOT_IN_PLAN);
  const label = custom ? roomLabelFrom(body.name as string) : generateRoomLabel();
  await enforceRateLimit("createRoom", caller.principal.userId);

  const roomId = await getDb()
    .transaction()
    .execute(async (trx) => {
      const { rows } = await sql<{ outcome: string; room_id: string | null }>`
        select outcome, room_id
          from app.create_room(${caller.principal.userId}::uuid, ${caller.device.id}::uuid, ${label}, ${custom},
                               ${JSON.stringify(snapshotFor(entitlements))}::jsonb, ${entitlements.limits.maxRooms}::integer)
      `.execute(trx);
      const row = rows[0];
      if (row?.outcome === "room_limit") {
        throw new ApiError(409, "ROOM_LIMIT", "You have as many rooms as your plan allows", { maxRooms: entitlements.limits.maxRooms });
      }
      if (row?.outcome !== "created" || !row.room_id) throw new Error("create_room created nothing");
      await audit(trx, {
        action: "room.created",
        actorUserId: caller.principal.userId,
        actorDeviceId: caller.device.id,
        networkSpaceId: null,
        targetType: "room",
        targetId: row.room_id,
        metadata: { customName: custom },
      });
      return row.room_id;
    });
  return getRoom(caller, roomId);
}

/** GET /rooms: the caller's active memberships, the latest joined first (cursor pagination, as the feeds). */
export async function listRooms(caller: Caller, url: URL): Promise<{ rooms: RoomDto[]; nextCursor: string | null }> {
  const { cursor, limit } = pageParams(url);
  let query = getDb()
    .selectFrom("app.room_members as m")
    .innerJoin("app.rooms as r", "r.id", "m.room_id")
    .select([
      "r.id", "m.role", "r.label", "r.members_can_create_links", "r.default_expiry_seconds", "r.created_at", "m.joined_at",
      (eb) =>
        eb
          .selectFrom("app.room_members as c")
          .select(sql<number>`count(*)::int`.as("n"))
          .whereRef("c.room_id", "=", "r.id")
          .where("c.removed_at", "is", null)
          .as("member_count"),
    ])
    .where("m.user_id", "=", caller.principal.userId)
    .where("m.removed_at", "is", null)
    .where("r.deleted_at", "is", null)
    .orderBy("m.joined_at", "desc")
    .orderBy("r.id", "desc")
    .limit(limit + 1);
  if (cursor) query = query.where(sql<boolean>`(m.joined_at, r.id) < (${new Date(cursor.t)}, ${cursor.id}::uuid)`);
  const rows = await query.execute();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rooms: page.map((row) =>
      roomDto(
        {
          id: row.id,
          role: row.role as RoomRole,
          label: row.label,
          membersCanCreateLinks: row.members_can_create_links,
          defaultExpirySeconds: row.default_expiry_seconds,
          createdAt: row.created_at,
        },
        row.member_count ?? 1,
      ),
    ),
    nextCursor: rows.length > limit && last ? encodeCursor(last.joined_at, last.id) : null,
  };
}

/**
 * PATCH /rooms/{roomId} (the owner). A custom name follows the current plan (E18: renaming is refused after a
 * downgrade, §17.16); going back to a generated name is always allowed. The default expiry must be one of the
 * owner's expiry options now (422 EXPIRY_NOT_ALLOWED); each poster's plan still decides whether it applies to them.
 */
export async function updateRoom(caller: Caller, roomId: string, body: z.infer<typeof updateRoomBody>): Promise<RoomDto> {
  const room = await requireRoom(caller, roomId, { owner: true });
  const entitlements = await resolveEntitlements(caller.principal);
  if (typeof body.name === "string") assertFeature(entitlements, "customRoomNames", NAMES_NOT_IN_PLAN);
  if (typeof body.defaultExpirySeconds === "number") assertOption(entitlements, "localExpiryOptionsSeconds", body.defaultExpirySeconds);
  const label =
    body.name === undefined ? undefined : body.name === null ? (room.labelIsCustom ? generateRoomLabel() : room.label) : roomLabelFrom(body.name);
  await enforceRateLimit("updateRoom", caller.principal.userId);

  await getDb()
    .transaction()
    .execute(async (trx) => {
      const updated = await trx
        .updateTable("app.rooms")
        .set({
          ...(label !== undefined ? { label, label_is_custom: body.name !== null } : {}),
          ...(body.membersCanCreateLinks !== undefined ? { members_can_create_links: body.membersCanCreateLinks } : {}),
          ...(body.defaultExpirySeconds !== undefined ? { default_expiry_seconds: body.defaultExpirySeconds } : {}),
        })
        .where("id", "=", room.id)
        .where("deleted_at", "is", null)
        .returning("id")
        .executeTakeFirst();
      // Deleted since requireRoom read it.
      if (!updated) throw notFound();
      // Which settings changed, never the name itself (audit metadata holds no content, 03 §14).
      await audit(trx, {
        action: "room.updated",
        actorUserId: caller.principal.userId,
        actorDeviceId: caller.device.id,
        networkSpaceId: null,
        targetType: "room",
        targetId: room.id,
        metadata: {
          ...(label !== undefined ? { name: body.name === null ? "generated" : "custom" } : {}),
          ...(body.membersCanCreateLinks !== undefined ? { membersCanCreateLinks: body.membersCanCreateLinks } : {}),
          ...(body.defaultExpirySeconds !== undefined ? { defaultExpirySeconds: body.defaultExpirySeconds } : {}),
        },
      });
    });
  return getRoom(caller, room.id);
}

/**
 * DELETE /rooms/{roomId} (the owner): app.delete_room ends the room's shares (their objects go to the janitor and
 * their links stop), revokes its invites, removes every member and audits; Realtime tells the members.
 */
export async function deleteRoom(caller: Caller, roomId: string): Promise<void> {
  const room = await requireRoom(caller, roomId, { owner: true });
  await enforceRateLimit("deleteRoom", caller.principal.userId);
  const { rows } = await sql<{ ended: number | null }>`
    select app.delete_room(${room.id}::uuid, ${caller.principal.userId}::uuid, 'deleted_by_owner') as ended
  `.execute(getDb());
  // Deleted meanwhile (by another of the owner's devices).
  if (rows[0]?.ended === null || rows[0]?.ended === undefined) throw notFound();
}

/** GET /rooms/{roomId}/shares (members): the room's feed. */
export async function listRoomShares(caller: Caller, roomId: string, url: URL): Promise<{ shares: ShareDto[]; nextCursor: string | null }> {
  const room = await requireRoom(caller, roomId);
  return listRoomFeed(caller, room.id, url);
}
