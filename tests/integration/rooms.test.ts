import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { accountDevice, counter, proDevice, setCounter } from "./support/entitlements";
import { adminDb, api, type ApiResponse, closeAdminDb, Device, newNetwork, PNG_BYTES, setFlag, stack, Viewer } from "./support/api";
import { accept, createInvite, createRoom, join, memberIdOf, postRoomText, setMemberCap, uploadToRoom, type Invite, type Room } from "./support/rooms";

/**
 * Private rooms (phase 4 §17.8.4, §17.8.4.1, §17.11; P4-17). Test IDs from §17.19.6: T4-R1 … R4 (IDOR), R7 (the
 * authorization cells), R8 (invite links), R9 (the member cap under concurrent accepts), R10 (cross-network),
 * R11 (local-feed isolation, G-R1 … G-R4), R13 (removal), R14 (deletion), T-034 (invite secrets), and the
 * enforcement rows E17 … E23 (§17.6.4) with the §17.16 downgrade rows for rooms. QR pairing codes (P4-18, E20) are in
 * pairing.test.ts.
 */

const DB_CONTAINER = "supabase_db_local-saver";
const code = (response: ApiResponse) => response.body?.error?.code as string | undefined;
/** A 404 body without its request ID: unknown and forbidden must be indistinguishable (§17.11.2). */
const shape = (response: ApiResponse) => ({ status: response.status, code: code(response), message: response.body?.error?.message, details: response.body?.error?.details });

async function pro(ip = newNetwork().ip()) {
  return proDevice(ip);
}

/** A Pro owner's room with `members` anonymous members, each on their own network. */
async function roomWithMembers(members = 1) {
  const owner = await pro();
  const room = await createRoom(owner.device);
  const invite = await createInvite(owner.device, room.id);
  const joined: Device[] = [];
  for (let i = 0; i < members; i++) {
    const member = await Device.create(newNetwork().ip());
    await join(member, invite);
    joined.push(member);
  }
  return { owner, room, invite, members: joined };
}

afterAll(closeAdminDb);

describe("creating rooms (E17, E18, E29, E30)", () => {
  it("is Pro: anonymous and Free accounts are refused with the upgrade hint; Pro creates a generated-name room", async () => {
    const anonymous = await Device.create(newNetwork().ip());
    const free = await accountDevice();
    for (const device of [anonymous, free.device]) {
      const refused = await device.call("POST", "/api/v1/rooms", {});
      expect(refused.status).toBe(403);
      expect(refused.body.error).toMatchObject({ code: "FEATURE_NOT_IN_PLAN", details: { feature: "privateRooms", requiredPlan: "pro" } });
    }
    const owner = await pro();
    const created = await owner.device.call("POST", "/api/v1/rooms", {});
    expect(created.status).toBe(201);
    expect(created.body.room).toMatchObject({ role: "owner", memberCount: 1, settings: { membersCanCreateLinks: true, defaultExpirySeconds: null } });
    expect(created.body.room.label).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    // G-R4: a room says nothing about networks, presence or who owns it.
    expect(Object.keys(created.body.room).sort()).toEqual(["createdAt", "id", "label", "memberCount", "role", "settings"]);
  });

  it("custom names are Pro (E18), cleaned, and never empty", async () => {
    const owner = await pro();
    const named = await createRoom(owner.device, { name: "  Family​   photos ‮ " });
    expect(named.label).toBe("Family photos");
    expect((await owner.device.call("POST", "/api/v1/rooms", { name: " ​ " })).status).toBe(400);
    expect((await owner.device.call("POST", "/api/v1/rooms", { name: "x".repeat(201) })).status).toBe(400);
    const free = await accountDevice();
    expect(code(await free.device.call("POST", "/api/v1/rooms", { name: "Mine" }))).toBe("FEATURE_NOT_IN_PLAN");
  });

  it("holds the owner's room cap (D4-14: 20), and counts only open rooms", async () => {
    const owner = await pro();
    // 19 rooms as the API would have made them, then the 20th and a 21st through the API.
    await adminDb().query(
      "select app.create_room($1, $2, 'Filler ' || n, true, '{\"limits\": {\"maxRoomMembers\": 50}}', 20) from generate_series(1, 19) n",
      [owner.userId, owner.device.deviceId],
    );
    expect((await owner.device.call("POST", "/api/v1/rooms", {})).status).toBe(201);
    const over = await owner.device.call("POST", "/api/v1/rooms", {});
    expect(over.status).toBe(409);
    expect(over.body.error).toMatchObject({ code: "ROOM_LIMIT", details: { maxRooms: 20 } });
    const { rows } = await adminDb().query("select id from app.rooms where owner_user_id = $1 order by created_at limit 1", [owner.userId]);
    expect((await owner.device.call("DELETE", `/api/v1/rooms/${rows[0].id}`)).status).toBe(204);
    expect((await owner.device.call("POST", "/api/v1/rooms", {})).status).toBe(201);
  });

  it("is refused for restricted accounts (E29), accounts being deleted (E30), and past the rate limit", async () => {
    const restricted = await pro();
    await adminDb().query("insert into app.user_flags (user_id, upload_restricted) values ($1, true)", [restricted.userId]);
    expect(code(await restricted.device.call("POST", "/api/v1/rooms", {}))).toBe("UPLOADS_RESTRICTED");
    const leaving = await pro();
    await adminDb().query("insert into app.profiles (user_id) values ($1) on conflict do nothing", [leaving.userId]);
    await adminDb().query("select app.request_account_deletion($1, interval '7 days')", [leaving.userId]);
    expect(code(await leaving.device.call("POST", "/api/v1/rooms", {}))).toBe("ACCOUNT_DELETION_PENDING");
    const busy = await pro();
    await setCounter(`createRoom:${busy.userId}`, "1 hour", 10);
    const limited = await busy.device.call("POST", "/api/v1/rooms", {});
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});

describe("T4-R1 … R4: no identifier alone opens anything (§17.11.2)", () => {
  let owner: Device;
  let member: Device;
  let room: Room;
  let invite: Invite;
  let shareId: string;
  let fileId: string;
  let removed: Device;
  let otherRoomMember: Device;
  let otherRoom: Room;
  let otherMemberId: string;
  let strangerAccount: Device;
  let anonymous: Device;

  beforeAll(async () => {
    owner = (await pro()).device;
    room = await createRoom(owner);
    invite = await createInvite(owner, room.id);
    member = await Device.create(newNetwork().ip());
    await join(member, invite);
    removed = await Device.create(newNetwork().ip());
    await join(removed, invite);
    expect((await owner.call("DELETE", `/api/v1/rooms/${room.id}/members/${await memberIdOf(removed, room.id)}`)).status).toBe(204);
    shareId = (await postRoomText(member, room.id, "inside the room")).id;
    fileId = (await uploadToRoom(member, room.id, "r.png", PNG_BYTES, "image/png")).fileId;

    const otherOwner = (await pro()).device;
    otherRoom = await createRoom(otherOwner);
    otherRoomMember = await Device.create(newNetwork().ip());
    await join(otherRoomMember, await createInvite(otherOwner, otherRoom.id));
    otherMemberId = await memberIdOf(otherRoomMember, otherRoom.id);
    strangerAccount = (await accountDevice()).device;
    anonymous = await Device.create(newNetwork().ip());
  });

  const roomRoutes = (roomId: string, memberId = randomUUID()): [string, string, unknown?][] => [
    ["GET", `/api/v1/rooms/${roomId}`],
    ["PATCH", `/api/v1/rooms/${roomId}`, { membersCanCreateLinks: false }],
    ["DELETE", `/api/v1/rooms/${roomId}`],
    ["GET", `/api/v1/rooms/${roomId}/members`],
    ["DELETE", `/api/v1/rooms/${roomId}/members/${memberId}`],
    ["DELETE", `/api/v1/rooms/${roomId}/members/me`],
    ["GET", `/api/v1/rooms/${roomId}/shares`],
    ["GET", `/api/v1/rooms/${roomId}/invites`],
    ["POST", `/api/v1/rooms/${roomId}/invites`, { kind: "invite_link", expiresIn: 3600 }],
  ];

  it("T4-R1: a valid room ID from a non-member, an anonymous browser, a removed member or another room's member is the unknown room's 404", async () => {
    for (const [method, path, body] of roomRoutes(room.id)) {
      const unknown = shape(await member.call(method, path.replace(room.id, randomUUID()), body));
      expect(unknown, `${method} ${path} (unknown)`).toEqual({ status: 404, code: "NOT_FOUND", message: "Not found", details: undefined });
      for (const [who, device] of Object.entries({ strangerAccount, anonymous, removed, otherRoomMember })) {
        expect(shape(await device.call(method, path, body)), `${who}: ${method} ${path}`).toEqual(unknown);
      }
      expect((await api(method, path, { body, ip: newNetwork().ip() })).status, `no session: ${method} ${path}`).toBe(401);
      expect(shape(await member.call(method, path.replace(room.id, "not-a-room"), body)), `malformed: ${method} ${path}`).toEqual(unknown);
    }
    // The room is untouched by every probe.
    expect((await member.call("GET", `/api/v1/rooms/${room.id}`)).body.room.memberCount).toBe(2);
  });

  it("T4-R2: another room's member ID is 404 on this room's path and, for anyone outside that room, on its own", async () => {
    const onThisPath = await owner.call("DELETE", `/api/v1/rooms/${room.id}/members/${otherMemberId}`);
    expect(shape(onThisPath)).toEqual({ status: 404, code: "NOT_FOUND", message: "Not found", details: undefined });
    expect((await owner.call("DELETE", `/api/v1/rooms/${otherRoom.id}/members/${otherMemberId}`)).status).toBe(404);
    expect((await member.call("DELETE", `/api/v1/rooms/${otherRoom.id}/members/${otherMemberId}`)).status).toBe(404);
    // Nothing changed for that member.
    expect((await otherRoomMember.call("GET", `/api/v1/rooms/${otherRoom.id}`)).status).toBe(200);
    // A removed member's old ID is gone too.
    const { rows } = await adminDb().query("select id from app.room_members where room_id = $1 and removed_at is not null", [room.id]);
    expect((await owner.call("DELETE", `/api/v1/rooms/${room.id}/members/${rows[0].id}`)).status).toBe(404);
  });

  it("T4-R4: a room share's ID is 404 for non-members and removed members on every share route", async () => {
    const routes: [string, string, unknown?][] = [
      ["GET", `/api/v1/shares/${shareId}`],
      ["PATCH", `/api/v1/shares/${shareId}/text`, { content: "hijack", version: 1 }],
      ["DELETE", `/api/v1/shares/${shareId}`],
      ["POST", `/api/v1/shares/${shareId}/links`, {}],
      ["GET", `/api/v1/shares/${shareId}/links`],
      ["POST", `/api/v1/shares/${shareId}/reveal`, { confirm: true }],
      ["POST", `/api/v1/shares/${shareId}/confirm-received`, {}],
      ["POST", `/api/v1/shares/${shareId}/extend`, { expiresIn: 86_400 }],
      ["POST", `/api/v1/files/${fileId}/download-url`, {}],
      ["POST", `/api/v1/files/${fileId}/preview-url`, {}],
    ];
    for (const [method, path, body] of routes) {
      for (const [who, device] of Object.entries({ strangerAccount, anonymous, removed, otherRoomMember })) {
        expect((await device.call(method, path, body)).status, `${who}: ${method} ${path}`).toBe(404);
      }
    }
    expect((await member.call("GET", `/api/v1/shares/${shareId}`)).status).toBe(200);
    expect((await owner.call("POST", `/api/v1/files/${fileId}/download-url`, {})).status).toBe(200);
  });

  it("T4-R3: invites answer one 404 for unknown, wrong and malformed; revoking is the owner's alone", async () => {
    const fresh = await createInvite(owner, room.id);
    const probes = [
      { id: fresh.inviteId, secret: randomBytes(32).toString("base64url") },
      { id: `${fresh.inviteId.slice(0, 15)}x`, secret: fresh.secret },
      { id: fresh.inviteId, secret: "" },
      { id: fresh.inviteId, secret: "not a secret at all" },
      { id: "short", secret: fresh.secret },
      { id: otherRoom.id, secret: fresh.secret },
    ];
    for (const action of ["preview", "accept"]) {
      const answers = [];
      for (const probe of probes) {
        answers.push(shape(await strangerAccount.call("POST", `/api/v1/invites/${probe.id}/${action}`, { secret: probe.secret })));
      }
      for (const answer of answers) expect(answer, action).toEqual({ status: 404, code: "INVITE_UNAVAILABLE", message: "This invite isn't available", details: undefined });
    }
    expect((await strangerAccount.call("POST", `/api/v1/invites/${fresh.inviteId}/accept`, {})).status).toBe(400);
    expect((await strangerAccount.call("GET", `/api/v1/rooms/${room.id}`)).status).toBe(404);
    for (const device of [member, strangerAccount, anonymous, otherRoomMember]) {
      expect(shape(await device.call("DELETE", `/api/v1/invites/${fresh.inviteId}`))).toEqual({ status: 404, code: "NOT_FOUND", message: "Not found", details: undefined });
    }
    // Still usable: none of that revoked it.
    expect((await accept(strangerAccount, fresh)).status).toBe(200);
  });
});

describe("T4-R7: what owners, members and removed members may do (§17.11.1)", () => {
  it("members see, list and post; settings, invites and other people's removal are the owner's (403 NOT_OWNER)", async () => {
    const { owner, room, members } = await roomWithMembers(2);
    const [a, b] = members as [Device, Device];
    expect((await a.call("GET", `/api/v1/rooms/${room.id}`)).body.room).toMatchObject({ role: "member", memberCount: 3 });
    const listed = await a.call("GET", `/api/v1/rooms/${room.id}/members`);
    expect(listed.status).toBe(200);
    expect(listed.body.members.map((m: { role: string }) => m.role)).toEqual(["owner", "member", "member"]);
    // D4-15: an opaque ID, a role, a label and when they joined. No user ID, email, network or presence.
    for (const m of listed.body.members) expect(Object.keys(m).sort()).toEqual(["isYou", "joinedAt", "label", "memberId", "role"]);
    expect(JSON.stringify(listed.body)).not.toContain(owner.userId);
    expect(JSON.stringify(listed.body)).not.toContain(a.userId);

    for (const [method, path, body] of [
      ["PATCH", `/api/v1/rooms/${room.id}`, { membersCanCreateLinks: false }],
      ["DELETE", `/api/v1/rooms/${room.id}`],
      ["GET", `/api/v1/rooms/${room.id}/invites`],
      ["POST", `/api/v1/rooms/${room.id}/invites`, { kind: "invite_link", expiresIn: 3600 }],
      ["DELETE", `/api/v1/rooms/${room.id}/members/${await memberIdOf(b, room.id)}`],
    ] as [string, string, unknown?][]) {
      expect(code(await a.call(method, path, body)), `${method} ${path}`).toBe("NOT_OWNER");
    }
    expect((await b.call("GET", `/api/v1/rooms/${room.id}`)).status).toBe(200);
    expect(code(await owner.device.call("DELETE", `/api/v1/rooms/${room.id}/members/me`))).toBe("OWNER_CANNOT_LEAVE");
    expect(code(await owner.device.call("DELETE", `/api/v1/rooms/${room.id}/members/${await memberIdOf(owner.device, room.id)}`))).toBe("OWNER_CANNOT_LEAVE");
  });

  it("room shares: members download and preview; the creator edits; the owner deletes anyone's, a member only their own", async () => {
    const { owner, room, members } = await roomWithMembers(2);
    const [a, b] = members as [Device, Device];
    const text = await postRoomText(a, room.id, "a's note");
    expect(text).toMatchObject({ scope: "room", room: { id: room.id, label: room.label } });
    const image = await uploadToRoom(b, room.id, "b.png", PNG_BYTES, "image/png");
    expect((await a.call("POST", `/api/v1/files/${image.fileId}/download-url`, {})).status).toBe(200);
    expect((await owner.device.call("POST", `/api/v1/files/${image.fileId}/preview-url`, {})).status).toBe(200);
    expect(code(await b.call("PATCH", `/api/v1/shares/${text.id}/text`, { content: "b edits a", version: 1 }))).toBe("NOT_CREATOR");
    expect(code(await owner.device.call("PATCH", `/api/v1/shares/${text.id}/text`, { content: "owner edits a", version: 1 }))).toBe("NOT_CREATOR");
    expect((await a.call("PATCH", `/api/v1/shares/${text.id}/text`, { content: "a edits a", version: 1 })).status).toBe(200);
    expect(code(await b.call("DELETE", `/api/v1/shares/${text.id}`))).toBe("NOT_CREATOR");
    expect((await owner.device.call("DELETE", `/api/v1/shares/${text.id}`)).status).toBe(204);
    const { rows } = await adminDb().query("select end_reason from app.shares where id = $1", [text.id]);
    expect(rows[0].end_reason).toBe("deleted_by_owner");
    expect((await b.call("DELETE", `/api/v1/shares/${image.shareId}`)).status).toBe(204);
    const { rows: own } = await adminDb().query("select metadata from app.audit_events where action = 'share.deleted' and target_id = $1", [text.id]);
    expect(own[0].metadata).toEqual({ by: "room_owner" });
  });

  it("links to room shares: their creator while in the room, a member only while the room allows it, the owner always", async () => {
    const { owner, room, members } = await roomWithMembers(1);
    const [a] = members as [Device];
    const mine = await postRoomText(a, room.id, "linkable");
    const ownersOwn = await postRoomText(owner.device, room.id, "owner's");
    expect((await a.call("POST", `/api/v1/shares/${mine.id}/links`, {})).status).toBe(201);
    expect(code(await owner.device.call("POST", `/api/v1/shares/${mine.id}/links`, {}))).toBe("NOT_CREATOR");
    expect((await owner.device.call("PATCH", `/api/v1/rooms/${room.id}`, { membersCanCreateLinks: false })).status).toBe(200);
    expect(code(await a.call("POST", `/api/v1/shares/${mine.id}/links`, {}))).toBe("ROOM_LINKS_DISABLED");
    expect((await owner.device.call("POST", `/api/v1/shares/${ownersOwn.id}/links`, {})).status).toBe(201);
    // Managing existing links stays the creator's.
    expect((await a.call("GET", `/api/v1/shares/${mine.id}/links`)).status).toBe(200);
  });

  it("a removed creator keeps delete and their links (D4-15) but can put nothing new in front of the room", async () => {
    const { owner, room, members } = await roomWithMembers(1);
    const [a] = members as [Device];
    const text = await postRoomText(a, room.id, "before removal");
    const kept = await postRoomText(a, room.id, "kept");
    const link = await a.createLink(kept.id);
    expect((await owner.device.call("DELETE", `/api/v1/rooms/${room.id}/members/${await memberIdOf(a, room.id)}`)).status).toBe(204);
    expect(code(await a.call("PATCH", `/api/v1/shares/${text.id}/text`, { content: "after removal", version: 1 }))).toBe("NOT_ROOM_MEMBER");
    expect(code(await a.call("POST", `/api/v1/shares/${text.id}/links`, {}))).toBe("NOT_ROOM_MEMBER");
    expect(code(await a.call("POST", `/api/v1/shares/${text.id}/extend`, { expiresIn: 86_400 }))).toBe("NOT_ROOM_MEMBER");
    expect(code(await a.call("POST", "/api/v1/texts", { destination: { room: room.id }, content: "sneak" }))).toBe("NOT_FOUND");
    expect(await a.myShareIds()).toEqual(expect.arrayContaining([text.id, kept.id]));
    // Their existing link still opens their share, until they revoke it or the room is deleted.
    const viewer = new Viewer();
    expect((await viewer.unlock(link.id, link.secret)).status).toBe(200);
    expect((await viewer.content(link.id)).status).toBe(200);
    expect((await a.call("DELETE", `/api/v1/shares/${text.id}`)).status).toBe(204);
    // Their uploads stay in the room for the others (§17.11.1).
    const feed = await owner.device.call("GET", `/api/v1/rooms/${room.id}/shares`);
    expect(feed.body.shares.map((s: { id: string }) => s.id)).toEqual([kept.id]);
  });

  it("burn after download in a room: the first member other than the creator claims it (DEC-015)", async () => {
    await setFlag("free_burn_after_download", true);
    try {
      const { owner, room, members } = await roomWithMembers(2);
      const [a, b] = members as [Device, Device];
      const burn = await postRoomText(owner.device, room.id, "read once", { burnAfterDownload: true });
      expect((await a.call("POST", `/api/v1/shares/${burn.id}/reveal`, { confirm: true })).status).toBe(200);
      expect(code(await b.call("POST", `/api/v1/shares/${burn.id}/reveal`, { confirm: true }))).toBe("ALREADY_DOWNLOADED");
      expect((await (await Device.create(newNetwork().ip())).call("POST", `/api/v1/shares/${burn.id}/reveal`, { confirm: true })).status).toBe(404);
      const { rows } = await adminDb().query("select actor_kind, room_id from app.downloads where share_id = $1", [burn.id]);
      expect(rows).toEqual([{ actor_kind: "room_member", room_id: room.id }]);
    } finally {
      await setFlag("free_burn_after_download", false);
    }
  });
});

describe("posting into a room (E23)", () => {
  it("membership decides, not the plan; the uploader's quota pays; the room's default expiry applies when the poster's plan offers it", async () => {
    const { owner, room, members } = await roomWithMembers(1);
    const [a] = members as [Device];
    expect((await owner.device.call("PATCH", `/api/v1/rooms/${room.id}`, { defaultExpirySeconds: 3600 })).status).toBe(200);
    const text = await postRoomText(a, room.id);
    const { rows } = await adminDb().query(
      "select scope, room_id, network_space_id, extract(epoch from expires_at - created_at)::int as secs from app.shares where id = $1",
      [text.id],
    );
    expect(rows[0]).toEqual({ scope: "room", room_id: room.id, network_space_id: null, secs: 3600 });
    await uploadToRoom(a, room.id, "q.png", PNG_BYTES, "image/png");
    const usage = await adminDb().query("select subject_id::text, bytes_committed::int from app.storage_usage where subject_id in ($1, $2)", [a.userId, owner.userId]);
    expect(usage.rows).toEqual([{ subject_id: a.userId, bytes_committed: PNG_BYTES.length }]);
    // A 90-day default isn't a Free poster's option: their plan's default applies.
    expect(code(await owner.device.call("PATCH", `/api/v1/rooms/${room.id}`, { defaultExpirySeconds: 1234 }))).toBe("EXPIRY_NOT_ALLOWED");
    expect((await owner.device.call("PATCH", `/api/v1/rooms/${room.id}`, { defaultExpirySeconds: 90 * 86_400 })).status).toBe(200);
    const later = await postRoomText(a, room.id);
    const { rows: free } = await adminDb().query("select extract(epoch from expires_at - created_at)::int as secs from app.shares where id = $1", [later.id]);
    expect(free[0].secs).toBe(86_400);
    // Non-members get the unknown room's 404 whatever the destination body says.
    const outsider = await Device.create(newNetwork().ip());
    expect(code(await outsider.call("POST", "/api/v1/texts", { destination: { room: room.id }, content: "x" }))).toBe("NOT_FOUND");
    expect(code(await outsider.call("POST", "/api/v1/shares", { destination: { room: room.id }, files: [{ name: "x", size: 1, type: "" }] }))).toBe("NOT_FOUND");
    // Refused before anything is spent: no rate limit counted, no upload started (the transaction's lock is the backstop).
    expect(await counter(`textWriteUser:${outsider.userId}`, "1 minute")).toBe(0);
    expect(await counter(`createShare:${outsider.userId}`, "1 hour")).toBe(0);
    expect((await outsider.call("POST", "/api/v1/texts", { destination: { room: room.id, network: "x" }, content: "x" })).status).toBe(400);
    expect((await outsider.call("POST", "/api/v1/texts", { destination: "room", content: "x" })).status).toBe(400);
  });

  it("room texts have their own limit (300 a minute per room) and the kill switches apply", async () => {
    const { room, members } = await roomWithMembers(1);
    const [a] = members as [Device];
    await setCounter(`textWriteRoom:${room.id}`, "1 minute", 300);
    expect((await a.call("POST", "/api/v1/texts", { destination: { room: room.id }, content: "one too many" })).status).toBe(429);
    await setFlag("uploads_enabled", false);
    try {
      const init = await a.call("POST", "/api/v1/shares", { destination: { room: room.id }, files: [{ name: "x.bin", size: 1, type: "" }] });
      expect(code(init)).toBe("UPLOADS_DISABLED");
    } finally {
      await setFlag("uploads_enabled", true);
    }
  });
});

describe("T4-R10 and T4-R11: rooms work across networks and never touch a network (G-R1 … G-R4)", () => {
  it("members on three networks share; neighbours on the poster's network see nothing", async () => {
    const home = newNetwork();
    const owner = await pro(home.ip());
    const room = await createRoom(owner.device);
    const invite = await createInvite(owner.device, room.id);
    const away = await Device.create(newNetwork().ip());
    const mobile = await Device.create(newNetwork().ip());
    await join(away, invite);
    await join(mobile, invite);
    const neighbour = await Device.create(home.ip());

    const fromAway = await postRoomText(away, room.id, "from far away");
    const fromHome = await postRoomText(owner.device, room.id, "from home");
    const image = await uploadToRoom(mobile, room.id, "m.png", PNG_BYTES, "image/png");
    for (const device of [owner.device, away, mobile]) {
      const feed = await device.call("GET", `/api/v1/rooms/${room.id}/shares`);
      expect(feed.body.shares.map((s: { id: string }) => s.id)).toEqual([image.shareId, fromHome.id, fromAway.id]);
      expect((await device.call("POST", `/api/v1/files/${image.fileId}/download-url`, {})).status).toBe(200);
    }
    // Moving networks changes nothing for a room (T4-R10).
    await away.moveTo(newNetwork().ip());
    expect((await away.call("GET", `/api/v1/shares/${fromHome.id}`)).status).toBe(200);

    // G-R1: never in any local feed, the poster's own included.
    for (const device of [neighbour, owner.device, away, mobile]) {
      expect(await device.feedIds()).not.toEqual(expect.arrayContaining([fromAway.id]));
      expect(await device.feedIds()).not.toContain(fromHome.id);
      expect(await device.feedIds()).not.toContain(image.shareId);
    }
    expect((await neighbour.call("GET", `/api/v1/shares/${fromHome.id}`)).status).toBe(404);
    // G-R2: no network space on a room share or its rows.
    const { rows } = await adminDb().query(
      `select (select count(*)::int from app.shares where room_id = $1 and network_space_id is not null) as shares,
              (select count(*)::int from app.files f join app.shares s on s.id = f.share_id where s.room_id = $1 and f.network_space_id is not null) as files,
              (select count(*)::int from app.text_items t join app.shares s on s.id = t.share_id where s.room_id = $1 and t.network_space_id is not null) as texts`,
      [room.id],
    );
    expect(rows[0]).toEqual({ shares: 0, files: 0, texts: 0 });
    // G-R4: what members get carries no network, space, presence or device count.
    const responses = [
      await away.call("GET", `/api/v1/rooms/${room.id}`),
      await away.call("GET", "/api/v1/rooms"),
      await away.call("GET", `/api/v1/rooms/${room.id}/members`),
      await away.call("GET", `/api/v1/rooms/${room.id}/shares`),
    ];
    const [space] = (await owner.device.observe()).spaceIds;
    for (const response of responses) {
      for (const word of ["space", "network", "presence", "devicesHere", "spaceId"]) expect(response.text).not.toContain(word);
      expect(response.text).not.toContain(space);
    }
  });
});

describe("T4-R13 and T4-R14: removal and deletion", () => {
  it("a removed member's next request is 404, they can leave and rejoin with a valid invite, and leaving is theirs", async () => {
    const { owner, room, invite, members } = await roomWithMembers(2);
    const [a, b] = members as [Device, Device];
    const share = await postRoomText(owner.device, room.id, "still here?");
    expect((await owner.device.call("DELETE", `/api/v1/rooms/${room.id}/members/${await memberIdOf(a, room.id)}`)).status).toBe(204);
    for (const path of [`/api/v1/rooms/${room.id}`, `/api/v1/rooms/${room.id}/shares`, `/api/v1/shares/${share.id}`]) {
      expect((await a.call("GET", path)).status, path).toBe(404);
    }
    expect((await a.call("GET", "/api/v1/rooms")).body.rooms).toEqual([]);
    expect((await b.call("DELETE", `/api/v1/rooms/${room.id}/members/me`)).status).toBe(204);
    expect((await b.call("GET", `/api/v1/rooms/${room.id}`)).status).toBe(404);
    expect((await owner.device.call("GET", `/api/v1/rooms/${room.id}`)).body.room.memberCount).toBe(1);
    // A valid invite lets a removed member back in (the matrix allows it); the owner can revoke it first.
    expect((await accept(a, invite)).status).toBe(200);
    expect((await a.call("GET", `/api/v1/shares/${share.id}`)).status).toBe(200);
    const { rows } = await adminDb().query("select action, metadata from app.audit_events where target_id = $1 and action = 'member.removed' order by id", [room.id]);
    expect(rows.map((r: { metadata: { by: string } }) => r.metadata.by)).toEqual(["owner", "self"]);
  });

  it("deleting a room ends its shares (objects queued), revokes its invites and share links, and removes everyone", async () => {
    const { owner, room, invite, members } = await roomWithMembers(1);
    const [a] = members as [Device];
    const text = await postRoomText(a, room.id, "goes with the room");
    const file = await uploadToRoom(a, room.id, "gone.png", PNG_BYTES, "image/png");
    const link = await a.createLink(text.id);
    const viewer = new Viewer();
    expect((await viewer.unlock(link.id, link.secret)).status).toBe(200);
    expect(code(await a.call("DELETE", `/api/v1/rooms/${room.id}`))).toBe("NOT_OWNER");
    expect((await owner.device.call("DELETE", `/api/v1/rooms/${room.id}`)).status).toBe(204);
    expect((await owner.device.call("DELETE", `/api/v1/rooms/${room.id}`)).status).toBe(404);
    for (const device of [owner.device, a]) {
      expect((await device.call("GET", `/api/v1/rooms/${room.id}`)).status).toBe(404);
      expect((await device.call("GET", `/api/v1/shares/${text.id}`)).status).toBe(404);
    }
    expect((await viewer.content(link.id)).status).toBe(410);
    expect(code(await accept(await Device.create(newNetwork().ip()), invite))).toBe("INVITE_EXPIRED");
    const { rows } = await adminDb().query(
      `select (select array_agg(distinct end_reason) from app.shares where room_id = $1) as reasons,
              (select count(*)::int from app.object_deletions o join app.files f on f.object_key = o.object_key where f.id = $2) as queued,
              (select count(*)::int from app.room_invites where room_id = $1 and revoked_at is null) as open_invites,
              (select count(*)::int from app.room_members where room_id = $1 and removed_at is null) as members`,
      [room.id, file.fileId],
    );
    expect(rows[0]).toEqual({ reasons: ["room_deleted"], queued: 1, open_invites: 0, members: 0 });
  });
});

describe("invites (§17.8.4.1, T-034, T4-R8, T4-R9, E19, E21)", () => {
  it("invite links: 1 hour, 24 hours or 7 days; a maximum number of uses; revocation; the owner's list never shows a secret", async () => {
    const owner = await pro();
    const room = await createRoom(owner.device);
    for (const expiresIn of [3600, 86_400, 7 * 86_400]) {
      expect((await owner.device.call("POST", `/api/v1/rooms/${room.id}/invites`, { kind: "invite_link", expiresIn })).status).toBe(201);
    }
    for (const expiresIn of [30 * 86_400, 600, 7 * 86_400 + 1]) {
      const refused = await owner.device.call("POST", `/api/v1/rooms/${room.id}/invites`, { kind: "invite_link", expiresIn });
      expect(refused.body.error).toMatchObject({ code: "EXPIRY_NOT_ALLOWED", details: { allowed: [3600, 86_400, 604_800] } });
    }
    // A pairing code (P4-18) takes no expiry of its own: always 10 minutes (pairing.test.ts).
    expect((await owner.device.call("POST", `/api/v1/rooms/${room.id}/invites`, { kind: "pairing", expiresIn: 600 })).status).toBe(400);
    expect((await owner.device.call("POST", `/api/v1/rooms/${room.id}/invites`, { kind: "invite_link", expiresIn: 3600, roomId: randomUUID() })).status).toBe(400);

    const twice = await createInvite(owner.device, room.id, { maxUses: 2 });
    expect(twice.url).toMatch(new RegExp(`^${stack().origin}/j/${twice.inviteId}#k=[A-Za-z0-9_-]{43}$`));
    const [x, y, z] = await Promise.all([0, 1, 2].map(() => Device.create(newNetwork().ip())));
    expect((await accept(x!, twice)).status).toBe(200);
    expect((await accept(x!, twice)).status).toBe(200); // a member again: idempotent, uses nothing
    expect((await accept(y!, twice)).status).toBe(200);
    expect(code(await accept(z!, twice))).toBe("INVITE_EXPIRED");

    const listed = await owner.device.call("GET", `/api/v1/rooms/${room.id}/invites`);
    expect(listed.body.invites.map((i: { inviteId: string }) => i.inviteId)).not.toContain(twice.inviteId);
    expect(listed.text).not.toContain("#k=");
    const revocable = await createInvite(owner.device, room.id);
    expect((await owner.device.call("DELETE", `/api/v1/invites/${revocable.inviteId}`)).status).toBe(204);
    expect((await owner.device.call("DELETE", `/api/v1/invites/${revocable.inviteId}`)).status).toBe(204);
    expect(code(await accept(z!, revocable))).toBe("INVITE_EXPIRED");
    expect(code(await z!.call("POST", `/api/v1/invites/${revocable.inviteId}/preview`, { secret: revocable.secret }))).toBe("INVITE_EXPIRED");
  });

  it("an expired invite is 410 only after its secret; a preview shows the room's name and size, nothing about its members", async () => {
    const owner = await pro();
    const room = await createRoom(owner.device, { name: "Book club" });
    const invite = await createInvite(owner.device, room.id, { expiresIn: 3600 });
    const guest = await Device.create(newNetwork().ip());
    const preview = await guest.call("POST", `/api/v1/invites/${invite.inviteId}/preview`, { secret: invite.secret });
    expect(preview.body).toEqual({ roomLabel: "Book club", memberCount: 1, kind: "invite_link", expiresAt: invite.expiresAt });
    expect((await guest.call("GET", `/api/v1/rooms/${room.id}`)).status).toBe(404); // previewing isn't joining
    await adminDb().query("update app.room_invites set created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' where id = $1", [invite.inviteId]);
    expect(code(await guest.call("POST", `/api/v1/invites/${invite.inviteId}/preview`, { secret: invite.secret }))).toBe("INVITE_EXPIRED");
    expect(code(await accept(guest, invite))).toBe("INVITE_EXPIRED");
    expect(code(await accept(guest, { ...invite, secret: randomBytes(32).toString("base64url") }))).toBe("INVITE_UNAVAILABLE");
  });

  it("T4-R9: under 20 concurrent accepts the room holds exactly its member cap; a single-use invite joins exactly one", async () => {
    const owner = await pro();
    const room = await createRoom(owner.device);
    await setMemberCap(room.id, 5);
    // Two invites, so the per-invite limit (10 in 10 minutes) isn't what refuses anyone.
    const invites = [await createInvite(owner.device, room.id), await createInvite(owner.device, room.id)];
    const guests = await Promise.all(Array.from({ length: 20 }, () => Device.create(newNetwork().ip())));
    const answers = await Promise.all(guests.map((guest, i) => accept(guest, invites[i % 2]!)));
    expect(answers.filter((a) => a.status === 200)).toHaveLength(4);
    expect(answers.filter((a) => code(a) === "ROOM_MEMBER_LIMIT")).toHaveLength(16);
    expect((await owner.device.call("GET", `/api/v1/rooms/${room.id}`)).body.room.memberCount).toBe(5);

    const once = await createInvite(owner.device, (await createRoom(owner.device)).id, { maxUses: 1 });
    const racers = await Promise.all(Array.from({ length: 8 }, () => Device.create(newNetwork().ip())));
    const raced = await Promise.all(racers.map((r) => accept(r, once)));
    expect(raced.filter((a) => a.status === 200)).toHaveLength(1);
    expect(raced.filter((a) => code(a) === "INVITE_EXPIRED")).toHaveLength(7);
    const { rows } = await adminDb().query("select use_count from app.room_invites where id = $1", [once.inviteId]);
    expect(rows[0].use_count).toBe(1);
  });

  it("is limited per invite and per network key, before any lookup", async () => {
    const owner = await pro();
    const room = await createRoom(owner.device);
    const invite = await createInvite(owner.device, room.id);
    await setCounter(`inviteAccept:${invite.inviteId}`, "10 minutes", 10);
    const guest = await Device.create(newNetwork().ip());
    const limited = await accept(guest, invite);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    await setCounter(`invitePreview:${invite.inviteId}`, "10 minutes", 10);
    expect((await guest.call("POST", `/api/v1/invites/${invite.inviteId}/preview`, { secret: "wrong" })).status).toBe(429);
  });

  it("T-034: the secret is stored only as its HMAC and never reaches a log, the audit trail or a later response", { timeout: 120_000 }, async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const sql = (statement: string) => execFileSync("docker", ["exec", DB_CONTAINER, "psql", "-U", "supabase_admin", "-d", "postgres", "-Atqc", statement]);
    sql("alter system set log_statement = 'all'");
    sql("select pg_reload_conf()");
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const owner = await pro();
      const room = await createRoom(owner.device, { name: "Secret keepers" });
      const invite = await createInvite(owner.device, room.id);
      const guest = await Device.create(newNetwork().ip());
      const responses = [
        await guest.call("POST", `/api/v1/invites/${invite.inviteId}/preview`, { secret: invite.secret }),
        await accept(guest, invite),
        await owner.device.call("GET", `/api/v1/rooms/${room.id}/invites`),
        await owner.device.call("GET", `/api/v1/rooms/${room.id}`),
      ];
      await new Promise((resolve) => setTimeout(resolve, 500));
      const { rows } = await adminDb().query("select r::text as row, octet_length(secret_hmac) as n from app.room_invites r where id = $1", [invite.inviteId]);
      expect(rows[0].n).toBe(32);
      expect(rows[0].row).not.toContain(invite.secret);
      const audit = await adminDb().query("select metadata::text as m from app.audit_events where target_id in ($1, $2) or metadata ->> 'roomId' = $2", [invite.inviteId, room.id]);
      expect(audit.rows.length).toBeGreaterThanOrEqual(4);
      const dbLog = spawnSync("docker", ["logs", "--since", since, DB_CONTAINER], { encoding: "utf8" });
      const statements = `${dbLog.stdout}${dbLog.stderr}`;
      expect(statements).toContain("app.room_invites"); // control: statements were logged
      const serverLog = readFileSync(stack().serverLog, "utf8");
      for (const text of [statements, serverLog, ...audit.rows.map((r: { m: string }) => r.m), ...responses.map((r) => r.text)]) {
        expect(text).not.toContain(invite.secret);
      }
      for (const r of audit.rows) expect(r.m).not.toContain("Secret keepers");
    } finally {
      sql("alter system reset log_statement");
      sql("select pg_reload_conf()");
    }
  });
});

describe("after a downgrade (§17.16, D4-14, D4-16)", () => {
  it("the room stays usable; new rooms, renames and new invite links are refused; existing invites and the snapshot's cap hold", async () => {
    const owner = await pro();
    const room = await createRoom(owner.device, { name: "Pro era" });
    const invite = await createInvite(owner.device, room.id, { maxUses: 10 });
    await owner.downgrade();
    expect(code(await owner.device.call("POST", "/api/v1/rooms", {}))).toBe("FEATURE_NOT_IN_PLAN");
    expect(code(await owner.device.call("PATCH", `/api/v1/rooms/${room.id}`, { name: "Free era" }))).toBe("FEATURE_NOT_IN_PLAN");
    expect(code(await owner.device.call("POST", `/api/v1/rooms/${room.id}/invites`, { kind: "invite_link", expiresIn: 3600 }))).toBe("FEATURE_NOT_IN_PLAN");
    const back = await owner.device.call("PATCH", `/api/v1/rooms/${room.id}`, { name: null, membersCanCreateLinks: false });
    expect(back.status).toBe(200);
    expect(back.body.room.label).not.toBe("Pro era");
    const guest = await Device.create(newNetwork().ip());
    await join(guest, invite);
    await postRoomText(guest, room.id, "still works");
    await postRoomText(owner.device, room.id, "mine too");
    const { rows } = await adminDb().query("select entitlement_snapshot -> 'limits' ->> 'maxRoomMembers' as cap from app.rooms where id = $1", [room.id]);
    expect(rows[0].cap).toBe("50");
  });
});

describe("Realtime: room:{id} is for members only and never meets a net: topic", () => {
  type Joined = { status: string; channel: RealtimeChannel; messages: Record<string, unknown>[] };
  const joinedDevices: Device[] = [];
  afterEach(async () => {
    await Promise.all(joinedDevices.splice(0).map((d) => d.supabase.removeAllChannels()));
  });
  async function listen(device: Device, topic: string): Promise<Joined> {
    joinedDevices.push(device);
    const messages: Record<string, unknown>[] = [];
    const channel = device.supabase.channel(topic, { config: { private: true } });
    channel.on("broadcast", { event: "*" }, (message) => messages.push({ event: message.event, ...(message.payload as Record<string, unknown>) }));
    const status = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("TIMED_OUT"), 10_000);
      channel.subscribe((state) => {
        if (state === "SUBSCRIBED" || state === "CHANNEL_ERROR" || state === "TIMED_OUT" || state === "CLOSED") {
          clearTimeout(timer);
          resolve(state);
        }
      });
    });
    return { status, channel, messages };
  }
  async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return predicate();
  }

  it("members join; outsiders and removed members are refused; room shares arrive as IDs, never on the network's topic", async () => {
    const home = newNetwork();
    const owner = await pro(home.ip());
    const room = await createRoom(owner.device);
    const invite = await createInvite(owner.device, room.id);
    const member = await Device.create(newNetwork().ip());
    await join(member, invite);
    const neighbour = await Device.create(home.ip());
    const [space] = (await neighbour.observe()).spaceIds;
    await owner.device.observe();

    const memberRoom = await listen(member, `room:${room.id}`);
    const ownerRoom = await listen(owner.device, `room:${room.id}`);
    const neighbourNet = await listen(neighbour, `net:${space}`);
    const outsider = await listen(await Device.create(home.ip()), `room:${room.id}`);
    expect([memberRoom.status, ownerRoom.status, neighbourNet.status, outsider.status]).toEqual(["SUBSCRIBED", "SUBSCRIBED", "SUBSCRIBED", "CHANNEL_ERROR"]);
    // No presence on room topics: tracking is refused.
    expect(await memberRoom.channel.track({ deviceId: member.deviceId })).not.toBe("ok");

    const memberUser = await listen(member, `user:${member.userId}`);
    const share = await postRoomText(owner.device, room.id, "realtime in a room");
    expect(await waitFor(() => memberRoom.messages.some((m) => m.shareId === share.id), 3_000)).toBe(true);
    const signal = memberRoom.messages.find((m) => m.shareId === share.id)!;
    expect(Object.keys(signal).every((k) => ["event", "v", "type", "shareId", "status", "id"].includes(k))).toBe(true);
    expect(JSON.stringify(memberRoom.messages)).not.toContain("realtime in a room");
    // G-R3: the owner's own network hears nothing of it.
    expect(await waitFor(() => neighbourNet.messages.some((m) => m.shareId === share.id), 1_500)).toBe(false);

    expect((await owner.device.call("DELETE", `/api/v1/rooms/${room.id}/members/${await memberIdOf(member, room.id)}`)).status).toBe(204);
    expect(await waitFor(() => memberUser.messages.some((m) => m.event === "membership.changed" && m.roomId === room.id && m.change === "removed"), 3_000)).toBe(true);
    expect(await waitFor(() => ownerRoom.messages.some((m) => m.event === "member.changed" && m.change === "removed"), 3_000)).toBe(true);
    await member.supabase.removeAllChannels();
    expect((await listen(member, `room:${room.id}`)).status).toBe("CHANNEL_ERROR");
  });
});
