import { afterAll, describe, expect, it } from "vitest";
import { createAccount, enrollTotp, signInByCode, stepUp } from "./support/accounts";
import { adminDb, api, closeAdminDb, Device, newNetwork, signInAnonymously } from "./support/api";

/**
 * Devices of accounts (phase 4 §17.5.6; P4-02, P4-07): the device-session binding (C4-2),
 * registration hygiene and revocation (C4-3), the device cap (D4-5) and the MFA rule for revoking
 * from a session without a device (D4-30). T4-A7 … T4-A9. P4-26: a revoked or signed-out browser's still-valid token
 * can't list or revoke devices.
 */

afterAll(closeAdminDb);

async function accountWithDevices(count: number) {
  const account = await createAccount();
  const devices: Device[] = [];
  for (let i = 0; i < count; i++) devices.push(await Device.attach(await signInByCode(account.email), newNetwork().ip(), { observe: false }));
  return { ...account, devices };
}

describe("device-session binding (C4-2)", () => {
  it("a device works only with the session it is bound to", async () => {
    const { devices: [one, two] } = await accountWithDevices(2);
    expect((await one!.call("GET", "/api/v1/me/shares")).status).toBe(200);
    const crossed = await api("GET", "/api/v1/me/shares", { token: two!.token, deviceId: one!.deviceId, ip: two!.ip });
    expect(crossed.status).toBe(401);
    expect(crossed.body.error.code).toBe("DEVICE_UNKNOWN");
  });

  it("one session has one device: registering again returns it, whatever the header says", async () => {
    const session = await signInAnonymously();
    const other = await Device.create(newNetwork().ip(), { observe: false });
    const first = await api("POST", "/api/v1/devices", { token: session.accessToken, body: {} });
    const again = await api("POST", "/api/v1/devices", { token: session.accessToken, body: {} });
    const foreign = await api("POST", "/api/v1/devices", { token: session.accessToken, deviceId: other.deviceId, body: {} });
    expect(again.body.device.id).toBe(first.body.device.id);
    expect(foreign.body.device.id).toBe(first.body.device.id);
    const { rows } = await adminDb().query("select user_id from app.devices where id = $1", [other.deviceId]);
    expect(rows[0].user_id).toBe(other.userId);
  });

  it("an own device named by a new session is rebound to it, and its presence ends", async () => {
    const account = await createAccount();
    const home = newNetwork();
    const first = await Device.attach(await signInByCode(account.email), home.ip());
    expect((await adminDb().query("select count(*)::int as n from app.network_presence where device_id = $1 and present_until > now()", [first.deviceId])).rows[0].n).toBe(1);

    const later = await Device.attach(await signInByCode(account.email), newNetwork().ip(), { deviceId: first.deviceId, observe: false });
    expect(later.deviceId).toBe(first.deviceId);
    expect((await first.call("GET", "/api/v1/me/shares")).body.error.code).toBe("DEVICE_UNKNOWN");
    expect((await later.call("GET", "/api/v1/me/shares")).status).toBe(200);
    expect((await adminDb().query("select count(*)::int as n from app.network_presence where device_id = $1 and present_until > now()", [first.deviceId])).rows[0].n).toBe(0);
  });

  it("a suspended user cannot register a device (403 USER_SUSPENDED)", async () => {
    const account = await createAccount();
    await adminDb().query("insert into app.user_flags (user_id, suspended_at, reason) values ($1, now(), 'test')", [account.userId]);
    const session = await signInByCode(account.email);
    const registered = await api("POST", "/api/v1/devices", { token: session.accessToken, body: {} });
    expect(registered.status).toBe(403);
    expect(registered.body.error.code).toBe("USER_SUSPENDED");
    expect((await adminDb().query("select count(*)::int as n from app.devices where user_id = $1", [account.userId])).rows[0].n).toBe(0);
  });

  it("a signed-out session cannot register, even while its access token is still valid", async () => {
    const account = await createAccount();
    const session = await signInByCode(account.email);
    const token = session.accessToken;
    await session.client.auth.signOut({ scope: "local" });
    const registered = await api("POST", "/api/v1/devices", { token, body: {} });
    expect(registered.status).toBe(401);
    expect(registered.body.error.code).toBe("UNAUTHENTICATED");
  });
});

describe("device cap (D4-5: 10 for every account)", () => {
  it("the 11th device of an account is refused with 409 DEVICE_LIMIT", async () => {
    const { email } = await accountWithDevices(10);
    const eleventh = await signInByCode(email);
    const refused = await api("POST", "/api/v1/devices", { token: eleventh.accessToken, body: {} });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: "DEVICE_LIMIT", details: { maxDevices: 10, activeDevices: 10 } });
  }, 60_000);

  it("concurrent registrations never exceed the cap", async () => {
    const { email, userId } = await accountWithDevices(7);
    // Signed in one after another (a new code replaces the previous one); registered all at once.
    const sessions = [];
    for (let i = 0; i < 8; i++) sessions.push(await signInByCode(email));
    const results = await Promise.all(sessions.map((s) => api("POST", "/api/v1/devices", { token: s.accessToken, body: {} })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect((await adminDb().query("select count(*)::int as n from app.devices where user_id = $1 and revoked_at is null", [userId])).rows[0].n).toBe(10);
  }, 60_000);

  it("a browser at the cap lists and revokes a device with its token alone, then registers", async () => {
    const { email, devices } = await accountWithDevices(10);
    const newcomer = await signInByCode(email);
    const listed = await api("GET", "/api/v1/me/devices", { token: newcomer.accessToken });
    expect(listed.status).toBe(200);
    expect(listed.body.maxDevices).toBe(10);
    expect(listed.body.devices).toHaveLength(10);
    expect(listed.body.devices.every((d: { current: boolean }) => !d.current)).toBe(true);
    expect((await api("DELETE", `/api/v1/me/devices/${devices[0]!.deviceId}`, { token: newcomer.accessToken })).status).toBe(204);
    const registered = await api("POST", "/api/v1/devices", { token: newcomer.accessToken, body: {} });
    expect(registered.status).toBe(200);
  }, 60_000);
});

describe("revocation (C4-3)", () => {
  it("a revoked device answers 401 DEVICE_REVOKED, its refresh token dies, and it is never re-created", async () => {
    const { devices: [victim, keeper] } = await accountWithDevices(2);
    expect((await keeper!.call("DELETE", `/api/v1/me/devices/${victim!.deviceId}`)).status).toBe(204);

    const next = await victim!.call("GET", "/api/v1/me/shares");
    expect(next.status).toBe(401);
    expect(next.body.error.code).toBe("DEVICE_REVOKED");
    for (const deviceId of [undefined, victim!.deviceId]) {
      const again = await api("POST", "/api/v1/devices", { token: victim!.token, deviceId, body: {} });
      expect(again.status).toBe(401);
      expect(again.body.error.code).toBe("DEVICE_REVOKED");
    }
    const refreshed = await victim!.supabase.auth.refreshSession();
    expect(refreshed.error).not.toBeNull();
    expect((await keeper!.call("GET", "/api/v1/me/shares")).status).toBe(200);
  });

  it("revoking ends the device's presence on its network", async () => {
    const account = await createAccount();
    const home = newNetwork();
    const leaving = await Device.attach(await signInByCode(account.email), home.ip());
    const keeper = await Device.attach(await signInByCode(account.email), newNetwork().ip(), { observe: false });
    expect((await keeper.call("DELETE", `/api/v1/me/devices/${leaving.deviceId}`)).status).toBe(204);
    const { rows } = await adminDb().query("select count(*)::int as n from app.network_presence where device_id = $1 and present_until > now()", [leaving.deviceId]);
    expect(rows[0].n).toBe(0);
  });

  it("another user's device, an unknown ID and a malformed ID all answer 404", async () => {
    const { devices: [mine] } = await accountWithDevices(1);
    const { devices: [theirs] } = await accountWithDevices(1);
    for (const id of [theirs!.deviceId, "00000000-0000-4000-8000-000000000000", "not-a-device"]) {
      expect((await mine!.call("DELETE", `/api/v1/me/devices/${id}`)).status, id).toBe(404);
    }
    expect((await theirs!.call("GET", "/api/v1/me/shares")).status).toBe(200);
  });

  it("the list shows the caller's devices only, marks this one, and keeps revoked ones visible", async () => {
    const { devices: [one, two, three] } = await accountWithDevices(3);
    const stranger = await Device.create(newNetwork().ip(), { observe: false });
    await one!.call("DELETE", `/api/v1/me/devices/${three!.deviceId}`);
    const listed = await one!.call("GET", "/api/v1/me/devices");
    const byId = Object.fromEntries(listed.body.devices.map((d: { id: string }) => [d.id, d]));
    expect(Object.keys(byId).sort()).toEqual([one!.deviceId, two!.deviceId, three!.deviceId].sort());
    expect(byId[one!.deviceId]).toMatchObject({ current: true, revokedAt: null });
    expect(byId[two!.deviceId]).toMatchObject({ current: false, revokedAt: null });
    expect(byId[three!.deviceId].revokedAt).toEqual(expect.any(String));
    expect(Object.keys(byId)).not.toContain(stranger.deviceId);
    expect(listed.body.devices.at(-1).id).toBe(three!.deviceId);
  });

  it("from a session without a device, an account with MFA must be at aal2 (D4-30)", async () => {
    const { email, devices: [one, two] } = await accountWithDevices(2);
    const factor = await enrollTotp(one!.supabase);
    const newcomer = await signInByCode(email);
    const refused = await api("DELETE", `/api/v1/me/devices/${two!.deviceId}`, { token: newcomer.accessToken });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("MFA_REQUIRED");
    // Device two wasn't revoked. P4-24: its own session is aal1 (Supabase Auth ended it at enrolment; its token is still
    // valid), so it gets MFA_REQUIRED too instead of its shares; the device row shows it is still active.
    expect((await adminDb().query("select revoked_at from app.devices where id = $1", [two!.deviceId])).rows[0].revoked_at).toBeNull();
    expect((await two!.call("GET", "/api/v1/me/shares")).body.error.code).toBe("MFA_REQUIRED");

    const stepped = await stepUp(newcomer.client, factor.factorId, factor.secret);
    expect((await api("DELETE", `/api/v1/me/devices/${two!.deviceId}`, { token: stepped.accessToken })).status).toBe(204);
  });

  it("anonymous and link-viewer callers can't list or revoke without a session", async () => {
    expect((await api("GET", "/api/v1/me/devices")).status).toBe(401);
    expect((await api("DELETE", "/api/v1/me/devices/00000000-0000-4000-8000-000000000000")).status).toBe(401);
  });

  // P4-26: list and revoke take the token alone, so they ask whether its Auth session still exists, as registration does.
  it("a revoked browser can't list the devices or revoke another one while its access token is still valid", async () => {
    const { devices: [victim, keeper] } = await accountWithDevices(2);
    expect((await keeper!.call("DELETE", `/api/v1/me/devices/${victim!.deviceId}`)).status).toBe(204);
    for (const [method, path] of [["GET", "/api/v1/me/devices"], ["DELETE", `/api/v1/me/devices/${keeper!.deviceId}`]] as const) {
      for (const deviceId of [undefined, victim!.deviceId]) {
        const refused = await api(method, path, { token: victim!.token, deviceId });
        expect(refused.status, `${method} ${deviceId ?? "token only"}`).toBe(401);
        expect(refused.body.error.code).toBe("DEVICE_REVOKED");
      }
    }
    expect((await adminDb().query("select revoked_at from app.devices where id = $1", [keeper!.deviceId])).rows[0].revoked_at).toBeNull();
    expect((await keeper!.call("GET", "/api/v1/me/devices")).status).toBe(200);
  });

  it("a signed-out browser, with a device or without one, can't list the devices or revoke one", async () => {
    const { email, devices: [leaving, keeper] } = await accountWithDevices(2);
    const deviceless = await signInByCode(email);
    await leaving!.supabase.auth.signOut({ scope: "local" });
    await deviceless.client.auth.signOut({ scope: "local" });
    for (const token of [leaving!.token, deviceless.accessToken]) {
      const listed = await api("GET", "/api/v1/me/devices", { token });
      expect(listed.status).toBe(401);
      expect(listed.body.error.code).toBe("UNAUTHENTICATED");
      const revoked = await api("DELETE", `/api/v1/me/devices/${keeper!.deviceId}`, { token });
      expect(revoked.status).toBe(401);
      expect(revoked.body.error.code).toBe("UNAUTHENTICATED");
    }
    expect((await adminDb().query("select revoked_at from app.devices where id = $1", [keeper!.deviceId])).rows[0].revoked_at).toBeNull();
    expect((await keeper!.call("GET", "/api/v1/me/devices")).status).toBe(200);
  });
});
