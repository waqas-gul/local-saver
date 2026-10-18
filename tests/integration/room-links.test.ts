import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { proDevice, setCounter } from "./support/entitlements";
import { adminDb, api, type ApiResponse, closeAdminDb, Device, newNetwork, PNG_BYTES, setFlag, stack, turnstilePass, Viewer } from "./support/api";
import { createInvite, createRoom, createRoomLink, join, memberIdOf, postRoomText, uploadToRoom, type RoomLink } from "./support/rooms";

/**
 * Read-only room links (phase 4 §17.8.5, §17.11; P4-19). The owner (Pro, E22) makes a link that shows the room's
 * current and future active shares to whoever holds it, through the existing unlock, grant and viewer machinery:
 * never members, invites, settings, the room's name, networks or who posted. T4-R5 (a grant opens only its own
 * link's room), T4-R6 (files only of that room's active shares), T4-R12 (current and future shares, burn claims by
 * the link session), E11, E15, E16, E22, E29, E30, D4-16, D4-17, and the matrix rows for the new routes.
 */

const DB_CONTAINER = "supabase_db_local-saver";
const code = (response: ApiResponse) => response.body?.error?.code as string | undefined;
const shape = (response: ApiResponse) => ({ status: response.status, code: code(response), message: response.body?.error?.message, details: response.body?.error?.details });
const DAY = 86_400;

type RoomContent = {
  link: { id: string; expiresAt: string };
  access: { expiresAt: string };
  room: {
    shares: {
      id: string;
      kind: "files" | "text";
      createdAt: string;
      expiresAt: string;
      text: { content: string } | null;
      files: { id: string; name: string; previewable: boolean; riskFlags: string[]; blocked?: true }[];
      burn?: { claimed: boolean; byYou: boolean; textHidden: boolean };
    }[];
    nextCursor: string | null;
  };
};

async function pro() {
  return proDevice(newNetwork().ip());
}

/** A Pro owner's room with one anonymous member (by invite link), each on their own network. */
async function roomWithMember(name = `Room ${randomBytes(3).toString("hex")}`) {
  const owner = await pro();
  const room = await createRoom(owner.device, { name });
  const member = await Device.create(newNetwork().ip());
  await join(member, await createInvite(owner.device, room.id));
  return { owner, room, member, name };
}

async function viewing(link: RoomLink, password?: string) {
  const viewer = new Viewer(newNetwork().ip());
  const unlocked = await viewer.unlock(link.id, link.secret, password ? { password } : {});
  return { viewer, unlocked };
}

const sharesOf = (response: ApiResponse) => (response.body as RoomContent).room.shares;

afterAll(closeAdminDb);

describe("making room links (E22, E11, E29, E30, D4-16, D4-17)", () => {
  it("the owner makes 1-hour to 30-day links, with a password if they like; members get 403, everyone else one 404", async () => {
    const { owner, room, member } = await roomWithMember("Garden club");
    for (const expiresIn of [3600, DAY, 7 * DAY, 30 * DAY]) {
      const created = await owner.device.call("POST", `/api/v1/rooms/${room.id}/links`, { expiresIn });
      expect(created.status, String(expiresIn)).toBe(201);
      expect(created.body.link.shortCode).toBeNull();
      expect(created.body.link.url).toMatch(new RegExp(`^${stack().origin}/s/${created.body.link.id}#k=[A-Za-z0-9_-]{43}$`));
    }
    for (const expiresIn of [600, 7200, 90 * DAY]) {
      const refused = await owner.device.call("POST", `/api/v1/rooms/${room.id}/links`, { expiresIn });
      expect(refused.body.error).toMatchObject({ code: "EXPIRY_NOT_ALLOWED", details: { allowed: [3600, DAY, 7 * DAY, 30 * DAY] } });
    }
    for (const body of [{}, { expiresIn: DAY, shortCode: { expiresIn: 600 } }, { expiresIn: DAY, roomId: randomUUID() }, { expiresIn: DAY, shareId: randomUUID() }]) {
      expect((await owner.device.call("POST", `/api/v1/rooms/${room.id}/links`, body)).status, JSON.stringify(body)).toBe(400);
    }

    const link = await createRoomLink(owner.device, room.id, { expiresIn: 7 * DAY, password: "correct horse battery" });
    const { rows } = await adminDb().query(
      `select target_type, room_id, share_id, short_code_hmac, follows_share_expiry, password_hash is not null as has_password,
              entitlement_snapshot ->> 'plan' as plan, extract(epoch from expires_at - created_at)::int as life, l::text as row
         from app.share_links l where id = $1`,
      [link.id],
    );
    expect(rows[0]).toMatchObject({ target_type: "room", room_id: room.id, share_id: null, short_code_hmac: null, follows_share_expiry: false, has_password: true, plan: "pro", life: 7 * DAY });
    expect(rows[0].row).not.toContain(link.secret);

    const listed = await owner.device.call("GET", `/api/v1/rooms/${room.id}/links`);
    expect(listed.status).toBe(200);
    expect(listed.body.links).toContainEqual(expect.objectContaining({ id: link.id, state: "active", hasPassword: true, shortCodeExpiresAt: null, followsShareExpiry: false }));
    expect(listed.text).not.toContain(link.secret);
    expect(listed.text).not.toContain("#k=");

    // Members see the room: 403 NOT_OWNER. Removed members, outsiders, anonymous browsers, unknown rooms: one 404.
    expect(code(await member.call("POST", `/api/v1/rooms/${room.id}/links`, { expiresIn: DAY }))).toBe("NOT_OWNER");
    expect(code(await member.call("GET", `/api/v1/rooms/${room.id}/links`))).toBe("NOT_OWNER");
    const removed = await Device.create(newNetwork().ip());
    await join(removed, await createInvite(owner.device, room.id));
    expect((await owner.device.call("DELETE", `/api/v1/rooms/${room.id}/members/${await memberIdOf(removed, room.id)}`)).status).toBe(204);
    const unknown = shape(await owner.device.call("POST", `/api/v1/rooms/${randomUUID()}/links`, { expiresIn: DAY }));
    expect(unknown).toMatchObject({ status: 404, code: "NOT_FOUND" });
    for (const caller of [removed, (await pro()).device, await Device.create(newNetwork().ip())]) {
      expect(shape(await caller.call("POST", `/api/v1/rooms/${room.id}/links`, { expiresIn: DAY }))).toEqual(unknown);
      expect(shape(await caller.call("GET", `/api/v1/rooms/${room.id}/links`))).toEqual(unknown);
    }
    expect((await api("POST", `/api/v1/rooms/${room.id}/links`, { body: { expiresIn: DAY }, ip: newNetwork().ip() })).status).toBe(401);

    const audit = await adminDb().query("select metadata from app.audit_events where action = 'link.created' and target_id = $1", [link.id]);
    expect(audit.rows).toEqual([{ metadata: { roomId: room.id, password: true } }]);
  });

  it("needs Pro (E22): a downgraded owner's links keep working, new ones are refused (D4-16); restricted, deleting and busy owners can't", async () => {
    const owner = await pro();
    const room = await createRoom(owner.device);
    const link = await createRoomLink(owner.device, room.id);
    await postRoomText(owner.device, room.id, "before the downgrade");
    await owner.downgrade();
    const refused = await owner.device.call("POST", `/api/v1/rooms/${room.id}/links`, { expiresIn: DAY });
    expect(refused.body.error).toMatchObject({ code: "FEATURE_NOT_IN_PLAN" });
    const { viewer, unlocked } = await viewing(link);
    expect(unlocked.status).toBe(200);
    expect(sharesOf(await viewer.content(link.id)).map((s) => s.text?.content)).toEqual(["before the downgrade"]);

    const restricted = await pro();
    const r1 = await createRoom(restricted.device);
    await adminDb().query("insert into app.user_flags (user_id, upload_restricted) values ($1, true)", [restricted.userId]);
    expect(code(await restricted.device.call("POST", `/api/v1/rooms/${r1.id}/links`, { expiresIn: DAY }))).toBe("UPLOADS_RESTRICTED");

    const leaving = await pro();
    const r2 = await createRoom(leaving.device);
    await adminDb().query("insert into app.profiles (user_id) values ($1) on conflict do nothing", [leaving.userId]);
    await adminDb().query("select app.request_account_deletion($1, interval '7 days')", [leaving.userId]);
    expect(code(await leaving.device.call("POST", `/api/v1/rooms/${r2.id}/links`, { expiresIn: DAY }))).toBe("ACCOUNT_DELETION_PENDING");

    // Pro's link-creation limit (300 an hour, D4-29) applies to room links too, counted on their own key.
    const busy = await pro();
    const r3 = await createRoom(busy.device);
    await setCounter(`createRoomLink:${busy.userId}`, "1 hour", 300);
    const limited = await busy.device.call("POST", `/api/v1/rooms/${r3.id}/links`, { expiresIn: DAY });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});

describe("viewing a room through its link (T4-R12)", () => {
  it("shows the room's current and future active shares and their files, never members, settings, the name or who posted", async () => {
    const { owner, room, member, name } = await roomWithMember();
    const ownerNote = await postRoomText(owner.device, room.id, "owner's room note");
    const file = await uploadToRoom(member, room.id, "photo.png", PNG_BYTES, "image/png");
    // A pending upload never shows.
    const pending = await member.call("POST", "/api/v1/shares", { destination: { room: room.id }, files: [{ name: "pending.bin", size: 10, type: "application/octet-stream" }] });
    expect(pending.status).toBe(201);
    const link = await createRoomLink(owner.device, room.id);

    const { viewer, unlocked } = await viewing(link);
    expect(unlocked.status).toBe(200);
    const first = unlocked.body as RoomContent;
    expect(first.link).toEqual({ id: link.id, expiresAt: link.expiresAt });
    expect(first.room.shares.map((s) => s.id)).toEqual([file.shareId, ownerNote.id]);
    expect(first.room.shares[1]!.text).toEqual({ content: "owner's room note" });
    expect(first.room.shares[0]!.files).toEqual([
      expect.objectContaining({ id: file.fileId, name: "photo.png", previewable: true, riskFlags: [] }),
    ]);
    expect(Object.keys(first).sort()).toEqual(["access", "link", "room"]);
    expect(Object.keys(first.room).sort()).toEqual(["nextCursor", "shares"]);
    const text = unlocked.text;
    for (const secret of [name, member.label, owner.device.label, member.userId, owner.userId, member.deviceId, room.id, link.secret]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/fromLabel|isMine|memberCount|spaceId|network/i);

    // Future shares appear; ended ones go.
    const later = await postRoomText(member, room.id, "posted after the link");
    expect((await owner.device.call("DELETE", `/api/v1/shares/${ownerNote.id}`)).status).toBe(204);
    const now = sharesOf(await viewer.content(link.id));
    expect(now.map((s) => s.id)).toEqual([later.id, file.shareId]);

    // Files: download and preview, logged as the link viewer's, in the room.
    const download = await viewer.fileUrl(link.id, file.fileId);
    expect(download.status).toBe(200);
    expect((await fetch(download.body.url)).status).toBe(200);
    expect((await viewer.fileUrl(link.id, file.fileId, "preview-url")).status).toBe(200);
    const logged = await adminDb().query("select actor_kind, link_id, room_id, network_space_id, event from app.downloads where file_id = $1 order by created_at", [file.fileId]);
    expect(logged.rows).toEqual([
      { actor_kind: "link_viewer", link_id: link.id, room_id: room.id, network_space_id: null, event: "url_issued" },
      { actor_kind: "link_viewer", link_id: link.id, room_id: room.id, network_space_id: null, event: "preview_issued" },
    ]);
  });

  it("pages the room's shares by cursor, newest first", async () => {
    const owner = await pro();
    const room = await createRoom(owner.device);
    const posted = [];
    for (let i = 0; i < 5; i++) posted.push((await postRoomText(owner.device, room.id, `note ${i}`)).id);
    const link = await createRoomLink(owner.device, room.id);
    const { viewer } = await viewing(link);
    const page1 = (await viewer.call("GET", `/api/v1/links/${link.id}/content?limit=2`)).body as RoomContent;
    expect(page1.room.shares.map((s) => s.id)).toEqual([posted[4], posted[3]]);
    const page2 = (await viewer.call("GET", `/api/v1/links/${link.id}/content?limit=2&cursor=${page1.room.nextCursor}`)).body as RoomContent;
    expect(page2.room.shares.map((s) => s.id)).toEqual([posted[2], posted[1]]);
    const page3 = (await viewer.call("GET", `/api/v1/links/${link.id}/content?limit=2&cursor=${page2.room.nextCursor}`)).body as RoomContent;
    expect(page3.room.shares.map((s) => s.id)).toEqual([posted[0]]);
    expect(page3.room.nextCursor).toBeNull();
    expect((await viewer.call("GET", `/api/v1/links/${link.id}/content?cursor=garbage`)).status).toBe(400);
  });

  it("T4-R5: a grant opens only its own link's room: not another room's link, and a share link's grant lists no room", async () => {
    const a = await roomWithMember();
    const b = await roomWithMember();
    const fileB = await uploadToRoom(b.member, b.room.id, "b.png", PNG_BYTES, "image/png");
    const linkA = await createRoomLink(a.owner.device, a.room.id);
    const linkB = await createRoomLink(b.owner.device, b.room.id);
    const { viewer } = await viewing(linkA);
    const unavailable = shape(await viewer.content(linkB.id));
    expect(unavailable).toMatchObject({ status: 404, code: "LINK_UNAVAILABLE" });
    expect(shape(await viewer.fileUrl(linkB.id, fileB.fileId))).toEqual(unavailable);
    // Room A's secret on room B's link is a wrong secret.
    expect(shape(await viewer.unlock(linkB.id, linkA.secret))).toEqual(unavailable);

    // A share link's grant (a network share's link) used on a room link, and the reverse.
    const sharer = await Device.create(newNetwork().ip());
    const shared = await sharer.postText("a network note", undefined, "link_only");
    const shareLink = await sharer.createLink(shared.id);
    const shareViewer = new Viewer(newNetwork().ip());
    expect((await shareViewer.unlock(shareLink.id, shareLink.secret)).status).toBe(200);
    expect(shape(await shareViewer.content(linkA.id))).toEqual(unavailable);
    expect(shape(await viewer.content(shareLink.id))).toEqual(unavailable);
  });

  it("T4-R6: a room link hands out only its room's files: not another room's, a share link's, a pending or an ended share's", async () => {
    const a = await roomWithMember();
    const b = await roomWithMember();
    const fileA = await uploadToRoom(a.member, a.room.id, "a.png", PNG_BYTES, "image/png");
    const endedA = await uploadToRoom(a.member, a.room.id, "gone.png", PNG_BYTES, "image/png");
    const fileB = await uploadToRoom(b.member, b.room.id, "b.png", PNG_BYTES, "image/png");
    const pending = await a.member.call("POST", "/api/v1/shares", { destination: { room: a.room.id }, files: [{ name: "pending.png", size: PNG_BYTES.length, type: "image/png" }] });
    const sharer = await Device.create(newNetwork().ip());
    const network = await sharer.uploadFile("net.png", PNG_BYTES, "image/png", PNG_BYTES.length, "link_only");
    expect((await a.member.call("DELETE", `/api/v1/shares/${endedA.shareId}`)).status).toBe(204);
    const textB = await postRoomText(b.member, b.room.id, "room B's note");

    const link = await createRoomLink(a.owner.device, a.room.id);
    const { viewer } = await viewing(link);
    expect((await viewer.fileUrl(link.id, fileA.fileId)).status).toBe(200);
    const notFound = shape(await viewer.fileUrl(link.id, fileB.fileId));
    expect(notFound).toMatchObject({ status: 404, code: "NOT_FOUND" });
    for (const fileId of [network.upload.fileId, pending.body.uploads[0].fileId, endedA.fileId, randomUUID()]) {
      expect(shape(await viewer.fileUrl(link.id, fileId)), fileId).toEqual(notFound);
      expect(shape(await viewer.fileUrl(link.id, fileId, "preview-url")), fileId).toEqual(notFound);
    }
    expect(shape(await viewer.fileUrl(link.id, "not-a-uuid"))).toEqual(notFound);
    // Burn actions name a share: another room's (or none at all) is 404 too.
    for (const body of [{ confirm: true, shareId: textB.id }, { confirm: true }, { confirm: true, shareId: randomUUID() }]) {
      expect(shape(await viewer.call("POST", `/api/v1/links/${link.id}/reveal`, body)), JSON.stringify(body)).toEqual(notFound);
    }
    expect(shape(await viewer.call("POST", `/api/v1/links/${link.id}/confirm-received`, { shareId: textB.id }))).toMatchObject({ status: 404 });
    expect(sharesOf(await viewer.content(link.id)).map((s) => s.id)).toEqual([fileA.shareId]);
  });

  it("burn after download: the first viewer claims through the room link; other viewers and members find it gone (DEC-015)", async () => {
    await setFlag("free_burn_after_download", true);
    try {
      const { owner, room, member } = await roomWithMember();
      const burn = await postRoomText(member, room.id, "read once", { burnAfterDownload: true });
      const link = await createRoomLink(owner.device, room.id);
      const first = await viewing(link);
      const second = await viewing(link);
      const listed = sharesOf(await first.viewer.content(link.id)).find((s) => s.id === burn.id)!;
      expect(listed).toMatchObject({ text: null, burn: { claimed: false, byYou: false, textHidden: true } });
      expect(code(await first.viewer.call("POST", `/api/v1/links/${link.id}/reveal`, { shareId: burn.id }))).toBe("CONFIRMATION_REQUIRED");

      const revealed = await first.viewer.call("POST", `/api/v1/links/${link.id}/reveal`, { confirm: true, shareId: burn.id });
      expect(revealed.status).toBe(200);
      expect(revealed.body.text).toEqual({ content: "read once" });
      expect(sharesOf(await second.viewer.content(link.id)).map((s) => s.id)).not.toContain(burn.id);
      expect(code(await second.viewer.call("POST", `/api/v1/links/${link.id}/reveal`, { confirm: true, shareId: burn.id }))).toBe("ALREADY_DOWNLOADED");
      expect(code(await owner.device.call("POST", `/api/v1/shares/${burn.id}/reveal`, { confirm: true }))).toBe("ALREADY_DOWNLOADED");
      expect(sharesOf(await first.viewer.content(link.id)).find((s) => s.id === burn.id)?.burn).toMatchObject({ claimed: true, byYou: true });
      const claim = await adminDb().query("select actor_kind, link_id, room_id from app.downloads where share_id = $1", [burn.id]);
      expect(claim.rows).toEqual([{ actor_kind: "link_viewer", link_id: link.id, room_id: room.id }]);

      expect((await first.viewer.call("POST", `/api/v1/links/${link.id}/confirm-received`, { shareId: burn.id })).status).toBe(204);
      expect(sharesOf(await first.viewer.content(link.id)).map((s) => s.id)).not.toContain(burn.id);

      // Another room's burn share, named through this room's link, is 404 (T4-R6).
      const other = await roomWithMember();
      const otherBurn = await postRoomText(other.member, other.room.id, "not this link's", { burnAfterDownload: true });
      expect(code(await second.viewer.call("POST", `/api/v1/links/${link.id}/reveal`, { confirm: true, shareId: otherBurn.id }))).toBe("NOT_FOUND");

      // 8 viewers racing for one burn share: exactly one claims it.
      const race = await postRoomText(member, room.id, "only one", { burnAfterDownload: true });
      const racers = await Promise.all(Array.from({ length: 8 }, () => viewing(link)));
      const answers = await Promise.all(racers.map((r) => r.viewer.call("POST", `/api/v1/links/${link.id}/reveal`, { confirm: true, shareId: race.id })));
      expect(answers.filter((a) => a.status === 200)).toHaveLength(1);
      expect(answers.filter((a) => code(a) === "ALREADY_DOWNLOADED")).toHaveLength(7);
    } finally {
      await setFlag("free_burn_after_download", false);
    }
  });

  it("executables and disk images in a room are listed as blocked and never handed out through the link (E16)", async () => {
    const { owner, room, member } = await roomWithMember();
    const exe = await uploadToRoom(member, room.id, "setup.exe", new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3, 4]));
    const link = await createRoomLink(owner.device, room.id);
    const { viewer } = await viewing(link);
    const listed = sharesOf(await viewer.content(link.id)).find((s) => s.id === exe.shareId)!;
    expect(listed.files[0]).toMatchObject({ id: exe.fileId, blocked: true });
    expect(listed.files[0]!.riskFlags).toContain("executable");
    expect(code(await viewer.fileUrl(link.id, exe.fileId))).toBe("REMOTE_FILE_BLOCKED");
    // Members download it in the room as before (DV4-97).
    expect((await member.call("POST", `/api/v1/files/${exe.fileId}/download-url`, {})).status).toBe(200);
  });

  it("the link's daily URL cap (E15) and the viewer limits apply", async () => {
    const { owner, room, member } = await roomWithMember();
    const file = await uploadToRoom(member, room.id, "cap.png", PNG_BYTES, "image/png");
    const link = await createRoomLink(owner.device, room.id);
    const { viewer } = await viewing(link);
    await setCounter(`linkUrlsDay:${link.id}`, "1 day", 10_000);
    expect(code(await viewer.fileUrl(link.id, file.fileId))).toBe("LINK_DAILY_LIMIT");
  });
});

describe("ending room links: revoked, expired, the room deleted, passwords, the owner suspended", () => {
  it("unknown and wrong are one 404; revoked, expired and a deleted room are 410 after proof; only the owner manages a link", async () => {
    const { owner, room, member } = await roomWithMember();
    await postRoomText(owner.device, room.id, "still here");
    const link = await createRoomLink(owner.device, room.id);
    const stranger = new Viewer(newNetwork().ip());
    const unavailable = shape(await stranger.unlock(link.id, randomBytes(32).toString("base64url")));
    expect(unavailable).toMatchObject({ status: 404, code: "LINK_UNAVAILABLE" });
    expect(shape(await stranger.unlock("AAAAAAAAAAAAAAAA", link.secret))).toEqual(unavailable);
    expect(shape(await stranger.content(link.id))).toEqual(unavailable);

    // Revoke: the owner only (members and everyone else: the unknown link's 404). Room links take no short code.
    const { viewer } = await viewing(link);
    const notFound = { status: 404, code: "NOT_FOUND" };
    for (const caller of [member, (await pro()).device]) {
      expect(shape(await caller.call("DELETE", `/api/v1/links/${link.id}`))).toMatchObject(notFound);
      expect(shape(await caller.call("PATCH", `/api/v1/links/${link.id}`, { password: null }))).toMatchObject(notFound);
    }
    expect(shape(await owner.device.call("POST", `/api/v1/links/${link.id}/code`, { expiresIn: 600 }))).toMatchObject(notFound);
    expect((await owner.device.call("DELETE", `/api/v1/links/${link.id}`)).status).toBe(204);
    expect((await owner.device.call("DELETE", `/api/v1/links/${link.id}`)).status).toBe(204);
    expect(code(await viewer.content(link.id))).toBe("LINK_EXPIRED");
    expect(code(await new Viewer(newNetwork().ip()).unlock(link.id, link.secret))).toBe("LINK_EXPIRED");
    const revokedAudit = await adminDb().query("select metadata from app.audit_events where action = 'link.revoked' and target_id = $1", [link.id]);
    expect(revokedAudit.rows).toEqual([{ metadata: { roomId: room.id } }]);

    // Expired.
    const short = await createRoomLink(owner.device, room.id, { expiresIn: 3600 });
    const holder = await viewing(short);
    await adminDb().query("update app.share_links set created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' where id = $1", [short.id]);
    expect(code(await holder.viewer.content(short.id))).toBe("LINK_EXPIRED");
    expect(code(await new Viewer(newNetwork().ip()).unlock(short.id, short.secret))).toBe("LINK_EXPIRED");

    // The room deleted: its links are revoked with it.
    const third = await createRoomLink(owner.device, room.id);
    const watcher = await viewing(third);
    expect((await owner.device.call("DELETE", `/api/v1/rooms/${room.id}`)).status).toBe(204);
    expect(code(await watcher.viewer.content(third.id))).toBe("LINK_EXPIRED");
    expect(code(await new Viewer(newNetwork().ip()).unlock(third.id, third.secret))).toBe("LINK_EXPIRED");
    const { rows } = await adminDb().query("select revoke_reason from app.share_links where id = $1", [third.id]);
    expect(rows[0].revoke_reason).toBe("room_deleted");
    // Even if the revocation were lost, a deleted room's link opens nothing: the room itself is checked too, by unlock
    // before any session, grant or count is written.
    await adminDb().query("update app.share_links set revoked_at = null, revoke_reason = null, revoked_by_user_id = null where id = $1", [third.id]);
    expect(code(await watcher.viewer.content(third.id))).toBe("LINK_EXPIRED");
    const trace = "select l.unlock_count, (select count(*)::int from app.link_grants g where g.link_id = l.id) as grants from app.share_links l where l.id = $1";
    const before = (await adminDb().query(trace, [third.id])).rows;
    expect(code(await new Viewer(newNetwork().ip()).unlock(third.id, third.secret))).toBe("LINK_EXPIRED");
    expect((await adminDb().query(trace, [third.id])).rows).toEqual(before);
  });

  it("a password room link asks for it; removing it ends existing grants; a suspended owner's links open nothing new", async () => {
    const owner = await pro();
    const room = await createRoom(owner.device);
    await postRoomText(owner.device, room.id, "behind a password");
    const link = await createRoomLink(owner.device, room.id, { password: "correct horse battery" });
    const viewer = new Viewer(newNetwork().ip());
    expect(code(await viewer.unlock(link.id, link.secret))).toBe("PASSWORD_REQUIRED");
    expect(code(await viewer.content(link.id))).toBe("PASSWORD_REQUIRED");
    expect(code(await viewer.password(link.id, "wrong horse battery"))).toBe("PASSWORD_INCORRECT");
    expect((await viewer.password(link.id, "correct horse battery")).status).toBe(204);
    expect(sharesOf(await viewer.content(link.id)).map((s) => s.text?.content)).toEqual(["behind a password"]);

    const changed = await owner.device.call("PATCH", `/api/v1/links/${link.id}`, { password: null });
    expect(changed.status).toBe(200);
    expect(changed.body.link).toMatchObject({ id: link.id, hasPassword: false });
    expect(code(await viewer.content(link.id))).toBe("LINK_UNAVAILABLE"); // the grant predates the change
    expect((await viewer.unlock(link.id, link.secret)).status).toBe(200);
    expect((await owner.device.call("PATCH", `/api/v1/links/${link.id}`, { password: "a brand new password" })).status).toBe(200);
    expect(code(await viewer.content(link.id))).toBe("PASSWORD_REQUIRED");

    await adminDb().query("insert into app.user_flags (user_id, suspended_at, reason) values ($1, now(), 'test')", [owner.userId]);
    expect(code(await new Viewer(newNetwork().ip()).unlock(link.id, link.secret))).toBe("LINK_EXPIRED");
  });
});

describe("reports from room-link viewers (03 §7.6)", () => {
  it("a viewer reports one share of the room; not another room's share, and a share link only its own share", async () => {
    const a = await roomWithMember();
    const b = await roomWithMember();
    const noteA = await postRoomText(a.member, a.room.id, "report me");
    const noteB = await postRoomText(b.member, b.room.id, "not yours to report");
    const link = await createRoomLink(a.owner.device, a.room.id);
    const { viewer } = await viewing(link);
    const report = (target: Record<string, unknown>) =>
      viewer.call("POST", "/api/v1/reports", { target: { type: "link", linkId: link.id, ...target }, category: "spam", turnstileToken: turnstilePass() });
    const made = await report({ shareId: noteA.id });
    expect(made.status).toBe(201);
    const { rows } = await adminDb().query("select link_id, share_id, network_space_id, reporter_kind from app.abuse_reports where id = $1", [made.body.report.id]);
    expect(rows[0]).toEqual({ link_id: link.id, share_id: noteA.id, network_space_id: null, reporter_kind: "link_viewer" });
    expect(shape(await report({ shareId: noteB.id }))).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(shape(await report({}))).toMatchObject({ status: 404, code: "NOT_FOUND" });

    const sharer = await Device.create(newNetwork().ip());
    const shared = await sharer.postText("a shared note", undefined, "link_only");
    const shareLink = await sharer.createLink(shared.id);
    const shareViewer = new Viewer(newNetwork().ip());
    await shareViewer.unlock(shareLink.id, shareLink.secret);
    const own = await shareViewer.call("POST", "/api/v1/reports", { target: { type: "link", linkId: shareLink.id, shareId: shared.id }, category: "spam", turnstileToken: turnstilePass() });
    expect(own.status).toBe(201);
    const other = await shareViewer.call("POST", "/api/v1/reports", { target: { type: "link", linkId: shareLink.id, shareId: noteA.id }, category: "spam", turnstileToken: turnstilePass() });
    expect(shape(other)).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
});

describe("concurrency and secrecy", () => {
  it("links made while the room is being deleted never stay live on the deleted room", async () => {
    for (let round = 0; round < 3; round++) {
      const owner = await pro();
      const room = await createRoom(owner.device);
      const answers = await Promise.all([
        ...Array.from({ length: 6 }, () => owner.device.call("POST", `/api/v1/rooms/${room.id}/links`, { expiresIn: DAY })),
        owner.device.call("DELETE", `/api/v1/rooms/${room.id}`),
      ]);
      expect(answers.every((a) => [201, 204, 404].includes(a.status)), answers.map((a) => a.status).join()).toBe(true);
      const { rows } = await adminDb().query("select count(*)::int as n from app.share_links where room_id = $1 and revoked_at is null", [room.id]);
      expect(rows[0].n, `round ${round}`).toBe(0);
    }
  });

  it("a room link's secret is stored only as its HMAC and never reaches a log, the audit trail or a later response", { timeout: 120_000 }, async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const sql = (statement: string) => execFileSync("docker", ["exec", DB_CONTAINER, "psql", "-U", "supabase_admin", "-d", "postgres", "-Atqc", statement]);
    sql("alter system set log_statement = 'all'");
    sql("select pg_reload_conf()");
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const owner = await pro();
      const room = await createRoom(owner.device, { name: "Hushed hall" });
      await postRoomText(owner.device, room.id, "quiet");
      const link = await createRoomLink(owner.device, room.id);
      const { viewer, unlocked } = await viewing(link);
      const responses = [unlocked, await viewer.content(link.id), await owner.device.call("GET", `/api/v1/rooms/${room.id}/links`)];
      await new Promise((resolve) => setTimeout(resolve, 500));
      const audit = await adminDb().query("select metadata::text as m from app.audit_events where target_id = $1 or metadata ->> 'roomId' = $2", [link.id, room.id]);
      expect(audit.rows.length).toBeGreaterThanOrEqual(2);
      const dbLog = spawnSync("docker", ["logs", "--since", since, DB_CONTAINER], { encoding: "utf8" });
      const statements = `${dbLog.stdout}${dbLog.stderr}`;
      expect(statements).toMatch(/"?app"?\."?share_links"?/); // control: the service's statements were logged
      const serverLog = readFileSync(stack().serverLog, "utf8");
      for (const text of [statements, serverLog, ...audit.rows.map((r: { m: string }) => r.m), ...responses.map((r) => r.text)]) {
        expect(text).not.toContain(link.secret);
      }
    } finally {
      sql("alter system reset log_statement");
      sql("select pg_reload_conf()");
    }
  });
});
