import { randomBytes } from "node:crypto";
import { adminDb, type Device, type Json } from "./api";

/**
 * Room fixtures for Phase 4 P4-17 (§17.19 "Room.create, Room.invite, Room.join"). Rooms need Pro (proDevice); members
 * join through invite links (or, P4-18, pairing codes) as a browser would, by the URL's fragment.
 */

export type Room = { id: string; label: string; role: "owner" | "member"; memberCount: number; settings: Json; createdAt: string };
export type Invite = { inviteId: string; url: string; secret: string; expiresAt: string; maxUses: number | null };

export async function createRoom(owner: Device, body: { name?: string } = {}): Promise<Room> {
  const response = await owner.call("POST", "/api/v1/rooms", body);
  if (response.status !== 201) throw new Error(`room creation failed: ${response.status} ${response.text}`);
  return response.body.room as Room;
}

export async function createInvite(owner: Device, roomId: string, body: { expiresIn?: number; maxUses?: number } = {}): Promise<Invite> {
  const response = await owner.call("POST", `/api/v1/rooms/${roomId}/invites`, { kind: "invite_link", expiresIn: 86_400, ...body });
  if (response.status !== 201) throw new Error(`invite creation failed: ${response.status} ${response.text}`);
  const invite = response.body.invite as Omit<Invite, "secret">;
  return { ...invite, secret: new URL(invite.url).hash.replace(/^#k=/, "") };
}

/** P4-18: a QR pairing code (one use, 10 minutes). Its URL is what the QR encodes; the secret is in its fragment. */
export async function createPairing(owner: Device, roomId: string): Promise<Invite> {
  const response = await owner.call("POST", `/api/v1/rooms/${roomId}/invites`, { kind: "pairing" });
  if (response.status !== 201) throw new Error(`pairing creation failed: ${response.status} ${response.text}`);
  const invite = response.body.invite as Omit<Invite, "secret">;
  return { ...invite, secret: new URL(invite.url).hash.replace(/^#k=/, "") };
}

export type RoomLink = { id: string; url: string; secret: string; createdAt: string; expiresAt: string; shortCode: null };

/** P4-19: a read-only room link (the owner, Pro). Its URL carries the secret in the fragment, as share links do. */
export async function createRoomLink(owner: Device, roomId: string, body: { expiresIn?: number; password?: string } = {}): Promise<RoomLink> {
  const response = await owner.call("POST", `/api/v1/rooms/${roomId}/links`, { expiresIn: 86_400, ...body });
  if (response.status !== 201) throw new Error(`room link creation failed: ${response.status} ${response.text}`);
  const link = response.body.link as Omit<RoomLink, "secret">;
  return { ...link, secret: new URL(link.url).hash.replace(/^#k=/, "") };
}

export function accept(device: Device, invite: Pick<Invite, "inviteId" | "secret">) {
  return device.call("POST", `/api/v1/invites/${invite.inviteId}/accept`, { secret: invite.secret });
}

export async function join(device: Device, invite: Invite): Promise<Room> {
  const response = await accept(device, invite);
  if (response.status !== 200) throw new Error(`joining failed: ${response.status} ${response.text}`);
  return response.body.room as Room;
}

/** The caller's own memberId in a room. */
export async function memberIdOf(device: Device, roomId: string): Promise<string> {
  const response = await device.call("GET", `/api/v1/rooms/${roomId}/members`);
  if (response.status !== 200) throw new Error(`member list failed: ${response.status} ${response.text}`);
  return (response.body.members as { memberId: string; isYou: boolean }[]).find((m) => m.isYou)!.memberId;
}

export async function postRoomText(device: Device, roomId: string, content = `room note ${randomBytes(4).toString("hex")}`, extra: Json = {}) {
  const response = await device.call("POST", "/api/v1/texts", { destination: { room: roomId }, content, ...extra });
  if (response.status !== 201) throw new Error(`room text failed: ${response.status} ${response.text}`);
  return response.body.share as { id: string; scope: string; room?: { id: string; label: string }; text: { content: string; version: number } | null };
}

/** Init → PUT → complete, into a room. */
export async function uploadToRoom(device: Device, roomId: string, name: string, bytes: Uint8Array, type = "application/octet-stream") {
  const init = await device.call("POST", "/api/v1/shares", { destination: { room: roomId }, files: [{ name, size: bytes.length, type }] });
  if (init.status !== 201) throw new Error(`room upload init failed: ${init.status} ${init.text}`);
  const upload = init.body.uploads[0] as { fileId: string; url: string; headers: Record<string, string> };
  const put = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: Buffer.from(bytes) });
  if (!put.ok) throw new Error(`PUT failed: ${put.status}`);
  const complete = await device.call("POST", `/api/v1/shares/${init.body.share.id}/files/${upload.fileId}/complete`, {});
  if (complete.status !== 200) throw new Error(`room upload complete failed: ${complete.status} ${complete.text}`);
  return { shareId: init.body.share.id as string, fileId: upload.fileId };
}

/** Make a room's member cap smaller than Pro's 50, as a snapshot from a smaller plan would (the cap is the snapshot's). */
export async function setMemberCap(roomId: string, cap: number): Promise<void> {
  await adminDb().query(
    "update app.rooms set entitlement_snapshot = jsonb_set(entitlement_snapshot, '{limits,maxRoomMembers}', to_jsonb($2::int)) where id = $1",
    [roomId, cap],
  );
}
