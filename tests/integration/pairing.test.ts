import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createAccount, signInByCode } from "./support/accounts";
import { grantOverride, proDevice, setCounter } from "./support/entitlements";
import { adminDb, api, type ApiResponse, closeAdminDb, Device, newNetwork, stack } from "./support/api";
import { accept, createInvite, createPairing, createRoom, join, memberIdOf, setMemberCap, type Invite } from "./support/rooms";

/**
 * QR pairing (phase 4 §17.8.4.1; P4-18): the owner shows a QR code that one person scans to join. The code is an
 * invite of kind "pairing": one use, 10 minutes, the owner's only (E20; a downgraded owner too, D4-16). T-034, T4-R3,
 * R8, R9 for pairing codes; T4-R15's render-and-decode half is a component test and the E2E journey (a real phone's
 * camera is manual). Scanning only opens the join page: a code previews, and joins nobody until Join.
 */

const DB_CONTAINER = "supabase_db_local-saver";
const code = (response: ApiResponse) => response.body?.error?.code as string | undefined;
/** A response without its request ID: unknown, wrong and malformed must be indistinguishable. */
const shape = (response: ApiResponse) => ({ status: response.status, code: code(response), message: response.body?.error?.message, details: response.body?.error?.details });
const pairing = { kind: "pairing" };
const randomInviteId = () => randomBytes(12).toString("base64url");
const randomSecret = () => randomBytes(32).toString("base64url");

async function ownerWithRoom(name?: string) {
  const owner = await proDevice(newNetwork().ip());
  const room = await createRoom(owner.device, name ? { name } : {});
  return { owner, room };
}

function preview(device: Device, invite: Pick<Invite, "inviteId" | "secret">) {
  return device.call("POST", `/api/v1/invites/${invite.inviteId}/preview`, { secret: invite.secret });
}

async function useCount(inviteId: string): Promise<number> {
  return (await adminDb().query("select use_count from app.room_invites where id = $1", [inviteId])).rows[0].use_count;
}

async function activeMembers(roomId: string): Promise<number> {
  return (await adminDb().query("select count(*)::int as n from app.room_members where room_id = $1 and removed_at is null", [roomId])).rows[0].n;
}

afterAll(closeAdminDb);

describe("making a pairing code (E20, E29, E30, D4-16)", () => {
  it("the owner gets a 10-minute, single-use code whose URL carries the secret once; nobody else gets one", async () => {
    const { owner, room } = await ownerWithRoom("Pairing hall");
    const created = await owner.device.call("POST", `/api/v1/rooms/${room.id}/invites`, pairing);
    expect(created.status).toBe(201);
    const invite = created.body.invite;
    expect(invite).toMatchObject({ kind: "pairing", maxUses: 1 });
    expect(invite.url).toMatch(new RegExp(`^${stack().origin}/j/${invite.inviteId}#k=[A-Za-z0-9_-]{43}$`));
    const secret = new URL(invite.url).hash.replace(/^#k=/, "");
    const { rows } = await adminDb().query(
      `select kind, max_uses, use_count, revoked_at, octet_length(secret_hmac) as n, extract(epoch from expires_at - created_at)::int as lifetime,
              expires_at, r::text as row
         from app.room_invites r where id = $1`,
      [invite.inviteId],
    );
    expect(rows[0]).toMatchObject({ kind: "pairing", max_uses: 1, use_count: 0, revoked_at: null, n: 32, lifetime: 600 });
    expect(new Date(invite.expiresAt).getTime()).toBe(new Date(rows[0].expires_at).getTime());
    expect(rows[0].row).not.toContain(secret);

    // The body is strict: a pairing code has no expiry or maximum of its own, and no room ID is ever taken from it.
    for (const body of [{ kind: "pairing", expiresIn: 600 }, { kind: "pairing", maxUses: 1 }, { kind: "pairing", roomId: randomUUID() }, { kind: "qr" }, {}]) {
      expect((await owner.device.call("POST", `/api/v1/rooms/${room.id}/invites`, body)).status, JSON.stringify(body)).toBe(400);
    }

    // Members may not (403 NOT_OWNER: they see the room); removed members, outsiders and unknown rooms get one 404.
    const linkInvite = await createInvite(owner.device, room.id);
    const member = await Device.create(newNetwork().ip());
    await join(member, linkInvite);
    const removed = await Device.create(newNetwork().ip());
    await join(removed, linkInvite);
    expect((await owner.device.call("DELETE", `/api/v1/rooms/${room.id}/members/${await memberIdOf(removed, room.id)}`)).status).toBe(204);
    const outsider = await proDevice(newNetwork().ip());
    const anonymous = await Device.create(newNetwork().ip());
    expect(code(await member.call("POST", `/api/v1/rooms/${room.id}/invites`, pairing))).toBe("NOT_OWNER");
    const unknown = shape(await owner.device.call("POST", `/api/v1/rooms/${randomUUID()}/invites`, pairing));
    expect(unknown).toMatchObject({ status: 404, code: "NOT_FOUND" });
    for (const caller of [removed, outsider.device, anonymous]) expect(shape(await caller.call("POST", `/api/v1/rooms/${room.id}/invites`, pairing))).toEqual(unknown);
    expect(shape(await owner.device.call("POST", "/api/v1/rooms/not-a-room/invites", pairing))).toEqual(unknown);
    expect((await api("POST", `/api/v1/rooms/${room.id}/invites`, { body: pairing, ip: newNetwork().ip() })).status).toBe(401);
    expect((await adminDb().query("select count(*)::int as n from app.room_invites where room_id = $1 and kind = 'pairing'", [room.id])).rows[0].n).toBe(1);

    const audit = await adminDb().query("select actor_user_id, metadata from app.audit_events where action = 'invite.created' and target_id = $1", [invite.inviteId]);
    expect(audit.rows).toEqual([{ actor_user_id: owner.userId, metadata: { roomId: room.id, kind: "pairing", expiresIn: 600, maxUses: 1 } }]);
  });

  it("a downgraded owner may still pair people in (D4-16), not make invite links; restricted, deleting and busy owners can't", async () => {
    const { owner, room } = await ownerWithRoom();
    await owner.downgrade();
    expect(code(await owner.device.call("POST", `/api/v1/rooms/${room.id}/invites`, { kind: "invite_link", expiresIn: 3600 }))).toBe("FEATURE_NOT_IN_PLAN");
    const code1 = await createPairing(owner.device, room.id);
    const guest = await Device.create(newNetwork().ip());
    expect((await join(guest, code1)).role).toBe("member");
    const { rows } = await adminDb().query("select entitlement_snapshot -> 'limits' ->> 'maxRoomMembers' as cap from app.rooms where id = $1", [room.id]);
    expect(rows[0].cap).toBe("50"); // the room's own snapshot, not the owner's current plan

    const restricted = await ownerWithRoom();
    await adminDb().query("insert into app.user_flags (user_id, upload_restricted) values ($1, true)", [restricted.owner.userId]);
    expect(code(await restricted.owner.device.call("POST", `/api/v1/rooms/${restricted.room.id}/invites`, pairing))).toBe("UPLOADS_RESTRICTED");

    const leaving = await ownerWithRoom();
    await adminDb().query("insert into app.profiles (user_id) values ($1) on conflict do nothing", [leaving.owner.userId]);
    await adminDb().query("select app.request_account_deletion($1, interval '7 days')", [leaving.owner.userId]);
    expect(code(await leaving.owner.device.call("POST", `/api/v1/rooms/${leaving.room.id}/invites`, pairing))).toBe("ACCOUNT_DELETION_PENDING");

    // Pairing codes have their own limit (30 an hour per user), apart from invite links'.
    const busy = await ownerWithRoom();
    await setCounter(`createPairing:${busy.owner.userId}`, "1 hour", 30);
    const limited = await busy.owner.device.call("POST", `/api/v1/rooms/${busy.room.id}/invites`, pairing);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await busy.owner.device.call("POST", `/api/v1/rooms/${busy.room.id}/invites`, { kind: "invite_link", expiresIn: 3600 })).status).toBe(201);
  });
});

describe("scanning and joining (T-034, T4-R3, T4-R8)", () => {
  it("a scan only previews: the room's name and size after proof; nobody joins or spends the code until Join", async () => {
    const { owner, room } = await ownerWithRoom("Kitchen table");
    const code1 = await createPairing(owner.device, room.id);
    const guest = await Device.create(newNetwork().ip());
    for (let i = 0; i < 2; i++) {
      const previewed = await preview(guest, code1);
      expect(previewed.status).toBe(200);
      expect(previewed.body).toEqual({ roomLabel: "Kitchen table", memberCount: 1, kind: "pairing", expiresAt: code1.expiresAt });
    }
    expect((await guest.call("GET", `/api/v1/rooms/${room.id}`)).status).toBe(404);
    expect(await useCount(code1.inviteId)).toBe(0);
    expect(await activeMembers(room.id)).toBe(1);
    const listed = await owner.device.call("GET", `/api/v1/rooms/${room.id}/invites`);
    expect(listed.body.invites).toContainEqual(expect.objectContaining({ inviteId: code1.inviteId, kind: "pairing", useCount: 0, maxUses: 1 }));
    expect(listed.text).not.toContain(code1.secret);

    const joined = await accept(guest, code1);
    expect(joined.status).toBe(200);
    expect(joined.body.room).toMatchObject({ id: room.id, role: "member", memberCount: 2 });
    const member = await adminDb().query("select joined_via, invite_id, joined_device_id from app.room_members where room_id = $1 and user_id = $2", [room.id, guest.userId]);
    expect(member.rows[0]).toEqual({ joined_via: "pairing", invite_id: code1.inviteId, joined_device_id: guest.deviceId });
    const audit = await adminDb().query(
      "select action, target_type, metadata from app.audit_events where actor_user_id = $1 and action in ('member.joined', 'invite.accepted') order by action",
      [guest.userId],
    );
    expect(audit.rows).toEqual([
      { action: "invite.accepted", target_type: "invite", metadata: { roomId: room.id } },
      { action: "member.joined", target_type: "room", metadata: { via: "pairing", inviteId: code1.inviteId } },
    ]);

    // The same person again: already a member, nothing used. Anyone else: used up (410, after proof).
    expect((await accept(guest, code1)).status).toBe(200);
    expect(await useCount(code1.inviteId)).toBe(1);
    const second = await Device.create(newNetwork().ip());
    expect(code(await accept(second, code1))).toBe("INVITE_EXPIRED");
    expect(code(await preview(second, code1))).toBe("INVITE_EXPIRED");
    expect((await second.call("GET", `/api/v1/rooms/${room.id}`)).status).toBe(404);
    expect((await owner.device.call("GET", `/api/v1/rooms/${room.id}/invites`)).body.invites.map((i: { inviteId: string }) => i.inviteId)).not.toContain(code1.inviteId);
  });

  it("invalid, malformed, wrong and another room's codes get one 404; expired and revoked ones 410, only after proof", async () => {
    const { owner, room } = await ownerWithRoom();
    const other = await ownerWithRoom();
    const code1 = await createPairing(owner.device, room.id);
    const otherCode = await createPairing(other.owner.device, other.room.id);
    const guest = await Device.create(newNetwork().ip());
    const unknown = shape(await accept(guest, { inviteId: randomInviteId(), secret: code1.secret }));
    expect(unknown).toMatchObject({ status: 404, code: "INVITE_UNAVAILABLE" });
    const probes = [
      { inviteId: code1.inviteId, secret: randomSecret() }, // wrong secret
      { inviteId: code1.inviteId, secret: otherCode.secret }, // room B's secret on room A's code
      { inviteId: otherCode.inviteId, secret: code1.secret }, // and the reverse
      { inviteId: code1.inviteId, secret: "" },
      { inviteId: code1.inviteId, secret: "%%%not base64%%%" },
      { inviteId: code1.inviteId, secret: code1.secret.slice(0, 42) }, // a QR read short
      { inviteId: "short", secret: code1.secret },
      { inviteId: "A".repeat(17), secret: code1.secret },
      { inviteId: "AAAAAAAAAAAAAAA!", secret: code1.secret },
    ];
    for (const probe of probes) {
      expect(shape(await accept(guest, probe)), JSON.stringify(probe)).toEqual(unknown);
      expect(shape(await preview(guest, probe)), JSON.stringify(probe)).toEqual(unknown);
    }
    expect((await accept(guest, { inviteId: code1.inviteId, secret: "x".repeat(257) })).status).toBe(400); // over the body's size cap
    expect(await useCount(code1.inviteId)).toBe(0);
    expect(await useCount(otherCode.inviteId)).toBe(0);
    expect(await activeMembers(room.id)).toBe(1);

    // Revoked by the owner only: everyone else, members included, gets the unknown invite's 404.
    const member = await Device.create(newNetwork().ip());
    await join(member, await createPairing(owner.device, room.id));
    const revocable = await createPairing(owner.device, room.id);
    for (const caller of [member, other.owner.device, guest]) {
      expect(shape(await caller.call("DELETE", `/api/v1/invites/${revocable.inviteId}`))).toMatchObject({ status: 404, code: "NOT_FOUND" });
    }
    expect((await owner.device.call("DELETE", `/api/v1/invites/${revocable.inviteId}`)).status).toBe(204);
    expect(code(await preview(guest, revocable))).toBe("INVITE_EXPIRED");
    expect(code(await accept(guest, revocable))).toBe("INVITE_EXPIRED");
    expect(shape(await accept(guest, { ...revocable, secret: randomSecret() }))).toEqual(unknown); // proof first

    // Expired: 410 after proof, the uniform 404 without it.
    const late = await createPairing(owner.device, room.id);
    await adminDb().query("update app.room_invites set created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' where id = $1", [late.inviteId]);
    expect(code(await preview(guest, late))).toBe("INVITE_EXPIRED");
    expect(code(await accept(guest, late))).toBe("INVITE_EXPIRED");
    expect(shape(await accept(guest, { ...late, secret: randomSecret() }))).toEqual(unknown);
    expect((await guest.call("GET", `/api/v1/rooms/${room.id}`)).status).toBe(404);
  });

  it("T4-R9: 8 people scanning one code at once admit exactly one; one person racing themselves joins once", async () => {
    const { owner, room } = await ownerWithRoom();
    const code1 = await createPairing(owner.device, room.id);
    const scanners = await Promise.all(Array.from({ length: 8 }, () => Device.create(newNetwork().ip())));
    const raced = await Promise.all(scanners.map((s) => accept(s, code1)));
    expect(raced.filter((a) => a.status === 200)).toHaveLength(1);
    expect(raced.filter((a) => code(a) === "INVITE_EXPIRED")).toHaveLength(7);
    expect(await useCount(code1.inviteId)).toBe(1);
    expect(await activeMembers(room.id)).toBe(2);

    const code2 = await createPairing(owner.device, room.id);
    const eager = await Device.create(newNetwork().ip());
    const self = await Promise.all(Array.from({ length: 5 }, () => accept(eager, code2)));
    expect(self.map((a) => a.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await useCount(code2.inviteId)).toBe(1);
    expect((await adminDb().query("select count(*)::int as n from app.room_members where room_id = $1 and user_id = $2", [room.id, eager.userId])).rows[0].n).toBe(1);
  });

  it("E19: concurrent pairings into a nearly full room stop at its member cap; refused codes stay unused", async () => {
    const { owner, room } = await ownerWithRoom();
    await setMemberCap(room.id, 3);
    const codes = await Promise.all(Array.from({ length: 5 }, () => createPairing(owner.device, room.id)));
    const guests = await Promise.all(codes.map(() => Device.create(newNetwork().ip())));
    const answers = await Promise.all(guests.map((guest, i) => accept(guest, codes[i]!)));
    expect(answers.filter((a) => a.status === 200)).toHaveLength(2);
    expect(answers.filter((a) => code(a) === "ROOM_MEMBER_LIMIT")).toHaveLength(3);
    expect(await activeMembers(room.id)).toBe(3);
    const uses = await Promise.all(codes.map((c) => useCount(c.inviteId)));
    expect(uses.sort()).toEqual([0, 0, 0, 1, 1]);
  });

  it("brute force: 10 tries per code and 30 per network an hour, counted before any lookup, even with the right secret", async () => {
    const { owner, room } = await ownerWithRoom();
    const code1 = await createPairing(owner.device, room.id);
    const attacker = await Device.create(newNetwork().ip());
    for (let i = 0; i < 10; i++) expect(code(await accept(attacker, { ...code1, secret: randomSecret() }))).toBe("INVITE_UNAVAILABLE");
    const locked = await accept(attacker, code1);
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await useCount(code1.inviteId)).toBe(0);
    expect(await activeMembers(room.id)).toBe(1);

    // One network enumerating codes: 30 unknown IDs, then even a real code with its secret is refused.
    const code2 = await createPairing(owner.device, room.id);
    const prober = await Device.create(newNetwork().ip());
    for (let i = 0; i < 30; i++) expect(code(await accept(prober, { inviteId: randomInviteId(), secret: randomSecret() }))).toBe("INVITE_UNAVAILABLE");
    expect((await accept(prober, code2)).status).toBe(429);
    expect(await useCount(code2.inviteId)).toBe(0);
    // Someone on another network is unaffected.
    expect((await accept(await Device.create(newNetwork().ip()), code2)).status).toBe(200);
  });

  it("T-034: a code's secret is stored only as its HMAC and never reaches a log, the audit trail or a later response", { timeout: 120_000 }, async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const sql = (statement: string) => execFileSync("docker", ["exec", DB_CONTAINER, "psql", "-U", "supabase_admin", "-d", "postgres", "-Atqc", statement]);
    sql("alter system set log_statement = 'all'");
    sql("select pg_reload_conf()");
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const { owner, room } = await ownerWithRoom("Quiet corner");
      const code1 = await createPairing(owner.device, room.id);
      const guest = await Device.create(newNetwork().ip());
      const responses = [
        await preview(guest, code1),
        await accept(guest, code1),
        await accept(await Device.create(newNetwork().ip()), code1),
        await owner.device.call("GET", `/api/v1/rooms/${room.id}/invites`),
        await owner.device.call("GET", `/api/v1/rooms/${room.id}/members`),
        await owner.device.call("DELETE", `/api/v1/invites/${code1.inviteId}`),
      ];
      await new Promise((resolve) => setTimeout(resolve, 500));
      const audit = await adminDb().query("select metadata::text as m from app.audit_events where target_id in ($1, $2) or metadata ->> 'roomId' = $2", [code1.inviteId, room.id]);
      expect(audit.rows.length).toBeGreaterThanOrEqual(4);
      const dbLog = spawnSync("docker", ["logs", "--since", since, DB_CONTAINER], { encoding: "utf8" });
      const statements = `${dbLog.stdout}${dbLog.stderr}`;
      expect(statements).toMatch(/"?app"?\."?room_invites"?/); // control: the service's statements were logged
      const serverLog = readFileSync(stack().serverLog, "utf8");
      for (const text of [statements, serverLog, ...audit.rows.map((r: { m: string }) => r.m), ...responses.map((r) => r.text)]) {
        expect(text).not.toContain(code1.secret);
      }
    } finally {
      sql("alter system reset log_statement");
      sql("select pg_reload_conf()");
    }
  });
});

describe("device, session and account state (03 §8, C4-2, C4-3)", () => {
  it("revoked devices, mismatched sessions and suspended accounts can neither make nor use a code", async () => {
    // An owner account with two browsers; the second is revoked.
    const account = await createAccount();
    const ownerBrowser = await Device.attach(await signInByCode(account.email), newNetwork().ip());
    const revokedBrowser = await Device.attach(await signInByCode(account.email), newNetwork().ip());
    await grantOverride(account.userId);
    const room = await createRoom(ownerBrowser);
    expect((await ownerBrowser.call("DELETE", `/api/v1/me/devices/${revokedBrowser.deviceId}`)).status).toBe(204);
    expect(code(await revokedBrowser.call("POST", `/api/v1/rooms/${room.id}/invites`, pairing))).toBe("DEVICE_REVOKED");

    // The owner's token with another browser's device ID (and the reverse) is an unknown device.
    const stranger = await Device.create(newNetwork().ip());
    const crossed = await api("POST", `/api/v1/rooms/${room.id}/invites`, { token: ownerBrowser.token, deviceId: stranger.deviceId, ip: ownerBrowser.ip, body: pairing });
    expect(code(crossed)).toBe("DEVICE_UNKNOWN");
    const code1 = await createPairing(ownerBrowser, room.id);
    const guest = await Device.create(newNetwork().ip());
    const mismatched = await api("POST", `/api/v1/invites/${code1.inviteId}/accept`, { token: guest.token, deviceId: stranger.deviceId, ip: guest.ip, body: { secret: code1.secret } });
    expect(code(mismatched)).toBe("DEVICE_UNKNOWN");

    // A guest account whose scanning browser was revoked.
    const guestAccount = await createAccount();
    const scanning = await Device.attach(await signInByCode(guestAccount.email), newNetwork().ip());
    const keeper = await Device.attach(await signInByCode(guestAccount.email), newNetwork().ip());
    expect((await keeper.call("DELETE", `/api/v1/me/devices/${scanning.deviceId}`)).status).toBe(204);
    expect(code(await preview(scanning, code1))).toBe("DEVICE_REVOKED");
    expect(code(await accept(scanning, code1))).toBe("DEVICE_REVOKED");

    // Suspended scanner, then suspended owner.
    const suspended = await Device.create(newNetwork().ip());
    await adminDb().query("insert into app.user_flags (user_id, suspended_at, reason) values ($1, now(), 'test')", [suspended.userId]);
    expect(code(await preview(suspended, code1))).toBe("USER_SUSPENDED");
    expect(code(await accept(suspended, code1))).toBe("USER_SUSPENDED");
    expect(await useCount(code1.inviteId)).toBe(0);
    expect(await activeMembers(room.id)).toBe(1);
    await adminDb().query("insert into app.user_flags (user_id, suspended_at, reason) values ($1, now(), 'test')", [account.userId]);
    expect(code(await ownerBrowser.call("POST", `/api/v1/rooms/${room.id}/invites`, pairing))).toBe("USER_SUSPENDED");
    await adminDb().query("delete from app.user_flags where user_id = $1", [account.userId]);

    // The code still works for someone in good standing.
    expect((await accept(guest, code1)).status).toBe(200);
  });
});

describe("Realtime after pairing (§17.8.4)", () => {
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

  it("the room's channel admits a scanner only after Join; the owner hears the join; a refused scanner gets nothing", async () => {
    const { owner, room } = await ownerWithRoom();
    const code1 = await createPairing(owner.device, room.id);
    const guest = await Device.create(newNetwork().ip());
    const ownerRoom = await listen(owner.device, `room:${room.id}`);
    expect(ownerRoom.status).toBe("SUBSCRIBED");

    expect((await preview(guest, code1)).status).toBe(200);
    expect((await listen(guest, `room:${room.id}`)).status).toBe("CHANNEL_ERROR"); // a scan is not a membership
    await guest.supabase.removeAllChannels();
    const guestUser = await listen(guest, `user:${guest.userId}`);
    expect((await accept(guest, code1)).status).toBe(200);
    expect(await waitFor(() => guestUser.messages.some((m) => m.event === "membership.changed" && m.roomId === room.id && m.change === "joined"), 3_000)).toBe(true);
    expect(await waitFor(() => ownerRoom.messages.some((m) => m.event === "member.changed" && m.change === "joined"), 3_000)).toBe(true);
    expect((await listen(guest, `room:${room.id}`)).status).toBe("SUBSCRIBED");
    for (const m of [...guestUser.messages, ...ownerRoom.messages]) {
      expect(Object.keys(m).every((k) => ["event", "v", "type", "roomId", "change", "id", "shareId", "status"].includes(k))).toBe(true);
    }

    const late = await Device.create(newNetwork().ip());
    expect(code(await accept(late, code1))).toBe("INVITE_EXPIRED");
    expect((await listen(late, `room:${room.id}`)).status).toBe("CHANNEL_ERROR");
  });
});
