import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createAccount, signInByCode } from "./support/accounts";
import { requestDeletion } from "./support/billing";
import { grantOverride, proDevice } from "./support/entitlements";
import { adminDb, api, type ApiResponse, closeAdminDb, Device, newNetwork, PNG_BYTES, Viewer, type Session } from "./support/api";
import { createInvite, createRoom, createRoomLink, join, memberIdOf, postRoomText } from "./support/rooms";

/**
 * Merge and account-deletion coverage for rooms, history and links (phase 4 §17.5.4, §17.5.7, §17.9; P4-21): T-053.3
 * and T-053.12 through the API (an anonymous room member with posts, links and history merging into a Pro account that
 * is already in the room), the merge racing the room's owner, the room's deletion and the browser's own join, and what
 * an account's deletion leaves for everyone else (T4-A5's execution; the request flow, the schedule and the UI are
 * P4-22). supabase/tests/phase4_account_coverage.test.sql holds the column-by-column coverage.
 */

afterAll(closeAdminDb);

const code = (response: ApiResponse) => response.body?.error?.code as string | undefined;

async function intentFor(anon: Device): Promise<{ intentId: string; secret: string }> {
  const created = await anon.call("POST", "/api/v1/account/merge-intents", {});
  expect(created.status).toBe(201);
  return created.body;
}

function redeem(session: Session, deviceId: string, intent: { intentId: string; secret: string }) {
  return api("POST", "/api/v1/account/merge-anonymous", { token: session.accessToken, deviceId, body: { intentId: intent.intentId, secret: intent.secret } });
}

/**
 * A Pro account. `session` is the merging browser's sign-in, which redeems before it registers a device
 * (lib/client/runtime.tsx); `device`, when asked for, is another browser of the account on its own session.
 */
async function proAccount(ip: string, options: { withBrowser?: boolean } = {}) {
  const account = await createAccount();
  await grantOverride(account.userId);
  const session = await signInByCode(account.email);
  const device = options.withBrowser ? await Device.attach(await signInByCode(account.email), ip) : null;
  return { ...account, session, device };
}

async function activeMembers(roomId: string): Promise<number> {
  const { rows } = await adminDb().query("select count(*)::int as n from app.room_members where room_id = $1 and removed_at is null", [roomId]);
  return rows[0].n;
}

describe("the merge with rooms, history and links (T-053.3, T-053.12)", () => {
  it("an anonymous room member merges into a Pro account already in the room: one membership; the posts, links and history come along", async () => {
    const home = newNetwork();
    const owner = await proDevice(home.ip());
    const room = await createRoom(owner.device);
    const anon = await Device.create(home.ip());
    await join(anon, await createInvite(owner.device, room.id));
    const roomPost = await postRoomText(anon, room.id, `room post ${randomBytes(3).toString("hex")}`);
    const upload = await anon.uploadFile("merged.png", PNG_BYTES, "image/png");
    const fileShare = upload.init.body.share.id as string;
    const link = await anon.createLink(fileShare);
    const neighbour = await Device.create(home.ip());
    expect((await neighbour.call("POST", `/api/v1/files/${upload.upload.fileId}/download-url`, {})).status).toBe(200);
    const viewer = new Viewer();
    expect((await viewer.unlock(link.id, link.secret)).status).toBe(200);
    expect((await viewer.fileUrl(link.id, upload.upload.fileId)).status).toBe(200);

    const target = await proAccount(home.ip(), { withBrowser: true });
    await join(target.device!, await createInvite(owner.device, room.id));
    expect(await activeMembers(room.id)).toBe(3);

    const merged = await redeem(target.session, anon.deviceId, await intentFor(anon));
    expect(merged.status, merged.text).toBe(200);
    // The account was already in the room: it gains no membership; the anonymous row goes with the anonymous user.
    expect(merged.body.merged).toMatchObject({ shares: 2, links: 1, memberships: 0 });
    const account = await Device.attach(target.session, home.ip(), { deviceId: anon.deviceId });
    expect(await activeMembers(room.id)).toBe(2);
    const rooms = (await account.call("GET", "/api/v1/rooms")).body.rooms as { id: string; memberCount: number }[];
    expect(rooms.filter((r) => r.id === room.id)).toEqual([expect.objectContaining({ memberCount: 2 })]);
    const members = (await owner.device.call("GET", `/api/v1/rooms/${room.id}/members`)).body.members as { isYou: boolean }[];
    expect(members).toHaveLength(2);

    // Posts and links are the account's: in My uploads, managed by it, still open to the link's holder.
    expect(await account.myShareIds()).toEqual(expect.arrayContaining([roomPost.id, fileShare]));
    expect((await viewer.content(link.id)).status).toBe(200);

    // History (P4-20): the shares, and what happened to them, now the account's, its own link named.
    const shares = (await account.call("GET", "/api/v1/history/shares")).body.items as { id: string; room?: { id: string } }[];
    expect(shares.map((s) => s.id)).toEqual(expect.arrayContaining([roomPost.id, fileShare]));
    expect(shares.find((s) => s.id === roomPost.id)?.room?.id).toBe(room.id);
    const downloads = (await account.call("GET", `/api/v1/history/downloads?shareId=${fileShare}`)).body.items as {
      actorKind: string;
      link: { kind: string; id: string | null } | null;
    }[];
    expect(downloads.map((d) => [d.actorKind, d.link]).sort()).toEqual(
      [["link_viewer", { kind: "share", id: link.id }], ["network_device", null]].sort(),
    );

    expect((await account.call("DELETE", `/api/v1/links/${link.id}`)).status).toBe(204);
    expect(code(await viewer.content(link.id))).toBe("LINK_EXPIRED");
    expect((await account.call("DELETE", `/api/v1/shares/${roomPost.id}`)).status).toBe(204);
    const { rows } = await adminDb().query("select count(*)::int as n from app.room_members where user_id = $1", [anon.userId]);
    expect(rows[0].n).toBe(0);
  });
});

describe("the merge racing room changes (M7, M9)", () => {
  async function anonymousMember(owner: Device, roomId: string, ip: string) {
    const anon = await Device.create(ip);
    await join(anon, await createInvite(owner, roomId));
    const target = await proAccount(newNetwork().ip());
    return { anon, target, intent: await intentFor(anon) };
  }

  it("the owner removing the anonymous member while it merges: either order ends with the person out of the room", async () => {
    for (let round = 0; round < 4; round++) {
      const owner = await proDevice();
      const room = await createRoom(owner.device);
      const { anon, target, intent } = await anonymousMember(owner.device, room.id, newNetwork().ip());
      const memberId = await memberIdOf(anon, room.id);
      const [merged, removed] = await Promise.all([
        redeem(target.session, anon.deviceId, intent),
        owner.device.call("DELETE", `/api/v1/rooms/${room.id}/members/${memberId}`),
      ]);
      expect([merged.status, removed.status], `round ${round}`).toEqual([200, 204]);
      expect(await activeMembers(room.id)).toBe(1);
      const { rows } = await adminDb().query("select count(*)::int as n from app.room_members where room_id = $1 and user_id = $2 and removed_at is null", [
        room.id,
        target.userId,
      ]);
      expect(rows[0].n, `round ${round}`).toBe(0);
    }
  });

  it("the room deleted while its anonymous member merges: no membership survives in a deleted room", async () => {
    for (let round = 0; round < 4; round++) {
      const owner = await proDevice();
      const room = await createRoom(owner.device);
      const { anon, target, intent } = await anonymousMember(owner.device, room.id, newNetwork().ip());
      const [merged, deleted] = await Promise.all([
        redeem(target.session, anon.deviceId, intent),
        owner.device.call("DELETE", `/api/v1/rooms/${room.id}`),
      ]);
      expect([merged.status, deleted.status], `round ${round}`).toEqual([200, 204]);
      expect(await activeMembers(room.id)).toBe(0);
      const account = await Device.attach(target.session, newNetwork().ip(), { deviceId: anon.deviceId });
      expect(((await account.call("GET", "/api/v1/rooms")).body.rooms as { id: string }[]).map((r) => r.id)).not.toContain(room.id);
    }
  });

  it("the browser joining another room while it merges: the join lands on the account or is refused, never a 500", async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < 6; round++) {
      const owner = await proDevice();
      const first = await createRoom(owner.device);
      const second = await createRoom(owner.device);
      const { anon, target, intent } = await anonymousMember(owner.device, first.id, newNetwork().ip());
      const invite = await createInvite(owner.device, second.id);
      const [merged, joined] = await Promise.all([
        redeem(target.session, anon.deviceId, intent),
        anon.call("POST", `/api/v1/invites/${invite.inviteId}/accept`, { secret: invite.secret }),
      ]);
      expect(merged.status, `round ${round}`).toBe(200);
      expect(joined.status, `round ${round}: ${joined.text}`).not.toBe(500);
      const { rows } = await adminDb().query("select count(*)::int as n from app.room_members where room_id = $1 and user_id = $2 and removed_at is null", [
        second.id,
        target.userId,
      ]);
      if (joined.status === 200) {
        expect(rows[0].n, `round ${round}: joined, so the account is in the room`).toBe(1);
        outcomes.add("joined");
      } else {
        expect(rows[0].n, `round ${round}`).toBe(0);
        outcomes.add(`refused ${joined.status} ${code(joined)}`);
      }
      expect((await adminDb().query("select count(*)::int as n from app.room_members where user_id = $1", [anon.userId])).rows[0].n).toBe(0);
    }
    expect(outcomes.size).toBeGreaterThan(0);
  });
  it("the browser posting to its room and its network while it merges: each post lands on the account or is refused, never a 500", async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < 6; round++) {
      const owner = await proDevice();
      const room = await createRoom(owner.device);
      const ip = newNetwork().ip();
      const { anon, target, intent } = await anonymousMember(owner.device, room.id, ip);
      const [merged, roomPost, networkPost] = await Promise.all([
        redeem(target.session, anon.deviceId, intent),
        anon.call("POST", "/api/v1/texts", { destination: { room: room.id }, content: `race ${round}` }),
        anon.call("POST", "/api/v1/texts", { destination: "network", content: `race ${round}` }),
      ]);
      expect(merged.status, `round ${round}`).toBe(200);
      for (const [name, post] of [["room", roomPost], ["network", networkPost]] as const) {
        expect(post.status, `round ${round} ${name}: ${post.text}`).not.toBe(500);
        if (post.status === 201) {
          const { rows } = await adminDb().query("select created_by_user_id from app.shares where id = $1", [post.body.share.id]);
          expect(rows[0].created_by_user_id, `round ${round} ${name}`).toBe(target.userId);
        }
        outcomes.add(`${name} ${post.status} ${code(post) ?? ""}`);
      }
    }
    expect(outcomes.size).toBeGreaterThan(0);
  });
});

describe("what an account's deletion leaves for everyone else (T4-A5's execution)", () => {
  it("its room, links and invites end for their holders; another owner's room loses only it; other people's history keeps what happened", async () => {
    const home = newNetwork();
    const leaving = await proDevice(home.ip());
    const room = await createRoom(leaving.device);
    const member = await Device.create(newNetwork().ip());
    await join(member, await createInvite(leaving.device, room.id));
    const memberPost = await postRoomText(member, room.id);
    const roomLink = await createRoomLink(leaving.device, room.id);
    const roomViewer = new Viewer();
    expect((await roomViewer.unlock(roomLink.id, roomLink.secret)).status).toBe(200);
    const spareInvite = await createInvite(leaving.device, room.id);
    const note = await leaving.device.postText(`leaving ${randomBytes(3).toString("hex")}`);
    const link = await leaving.device.createLink(note.id);
    const shareViewer = new Viewer();
    expect((await shareViewer.unlock(link.id, link.secret)).status).toBe(200);

    const other = await proDevice(home.ip());
    const otherRoom = await createRoom(other.device);
    await join(leaving.device, await createInvite(other.device, otherRoom.id));
    const leavingPost = await postRoomText(leaving.device, otherRoom.id);
    const othersFile = await other.device.uploadFile("kept.png", PNG_BYTES, "image/png");
    expect((await leaving.device.call("POST", `/api/v1/files/${othersFile.upload.fileId}/download-url`, {})).status).toBe(200);

    await requestDeletion(leaving.userId);
    await adminDb().query("update app.profiles set deletion_scheduled_for = now() where user_id = $1", [leaving.userId]);
    await adminDb().query("select app.delete_due_accounts(100)");
    expect((await adminDb().query("select count(*)::int as n from auth.users where id = $1", [leaving.userId])).rows[0].n).toBe(0);

    // Its room is gone for its member, with the member's post; its links and invites open nothing any more.
    expect((await member.call("GET", `/api/v1/rooms/${room.id}`)).status).toBe(404);
    expect(((await member.call("GET", "/api/v1/rooms")).body.rooms as { id: string }[]).map((r) => r.id)).not.toContain(room.id);
    expect(await member.myShareIds()).not.toContain(memberPost.id);
    expect(code(await roomViewer.content(roomLink.id))).toBe("LINK_EXPIRED");
    expect(code(await shareViewer.content(link.id))).toBe("LINK_EXPIRED");
    expect(code(await new Viewer().unlock(link.id, link.secret))).toBe("LINK_EXPIRED");
    const preview = await member.call("POST", `/api/v1/invites/${spareInvite.inviteId}/preview`, { secret: spareInvite.secret });
    expect([404, 410]).toContain(preview.status);

    // The other room keeps its owner and loses only the account and its post.
    const members = (await other.device.call("GET", `/api/v1/rooms/${otherRoom.id}/members`)).body.members as unknown[];
    expect(members).toHaveLength(1);
    const feed = (await other.device.call("GET", `/api/v1/rooms/${otherRoom.id}/shares`)).body.shares as { id: string }[];
    expect(feed.map((s) => s.id)).not.toContain(leavingPost.id);

    // The other owner's history still shows the download, by actor kind; the record names nobody.
    const downloads = (await other.device.call("GET", `/api/v1/history/downloads?shareId=${othersFile.init.body.share.id}`)).body.items as {
      actorKind: string;
    }[];
    expect(downloads.map((d) => d.actorKind)).toEqual(["network_device"]);
    const { rows } = await adminDb().query("select user_id, device_id from app.downloads where share_id = $1", [othersFile.init.body.share.id]);
    expect(rows).toEqual([{ user_id: null, device_id: null }]);

    // The account's own sessions have nothing left.
    expect((await leaving.device.call("GET", "/api/v1/me")).status).toBe(401);
  });
});
