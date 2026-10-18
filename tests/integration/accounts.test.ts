import { randomBytes } from "node:crypto";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { authAdmin, browserClient, claimsOf, createAccount, currentSession, mailCode, newEmail, signInByCode } from "./support/accounts";
import { adminDb, api, closeAdminDb, Device, newNetwork, PNG_BYTES, Viewer } from "./support/api";

/**
 * Accounts (phase 4 §17.5; P4-05): sign-up and sign-in by email code, the anonymous → account
 * upgrade that keeps the user ID (T-053.1), GET /me and the profile, and the P4-00 finding: a
 * password someone set on an address before its owner signed up is removed and refused (D4-2).
 */

afterAll(closeAdminDb);

async function joins(client: Device["supabase"], topic: string): Promise<string> {
  const channel: RealtimeChannel = client.channel(topic, { config: { private: true } });
  const status = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve("TIMED_OUT"), 10_000);
    channel.subscribe((state) => {
      if (state === "SUBSCRIBED" || state === "CHANNEL_ERROR" || state === "TIMED_OUT" || state === "CLOSED") {
        clearTimeout(timer);
        resolve(state);
      }
    });
  });
  await client.removeChannel(channel);
  return status;
}

describe("sign-up and sign-in by email code (T4-A1)", () => {
  it("a new browser signs up with the code from the email: account, profile and device", async () => {
    const email = newEmail("signup");
    const client = browserClient();
    const since = new Date();
    expect((await client.auth.signInWithOtp({ email })).error).toBeNull();
    const verified = await client.auth.verifyOtp({ email, token: await mailCode(email, since), type: "email" });
    expect(verified.error).toBeNull();
    const device = await Device.attach(await currentSession(client), newNetwork().ip());

    const me = await device.call("GET", "/api/v1/me");
    expect(me.status).toBe(200);
    expect(me.body).toEqual({
      user: { id: device.userId, anonymous: false, email: `${email[0]}•••@example.com`, displayName: null },
      methods: ["email"],
      mfa: { enrolled: false, aal: "aal1" },
      plan: "free",
      deletion: null,
    });
    expect((await adminDb().query("select count(*)::int as n from app.profiles where user_id = $1", [device.userId])).rows[0].n).toBe(1);
  });

  it("signing in again on a second browser adds a device to the same account (T4-A1b)", async () => {
    const { email, userId } = await createAccount();
    const one = await Device.attach(await signInByCode(email), newNetwork().ip());
    const two = await Device.attach(await signInByCode(email), newNetwork().ip());
    expect([one.userId, two.userId]).toEqual([userId, userId]);
    expect(two.deviceId).not.toBe(one.deviceId);
    const listed = await two.call("GET", "/api/v1/me/devices");
    expect(listed.body.devices.map((d: { id: string }) => d.id).sort()).toEqual([one.deviceId, two.deviceId].sort());
  });

  it("an anonymous browser's /me says so, and /me needs this browser's device", async () => {
    const d = await Device.create(newNetwork().ip(), { observe: false });
    const me = await d.call("GET", "/api/v1/me");
    expect(me.body).toMatchObject({ user: { id: d.userId, anonymous: true, email: null, displayName: null }, methods: [], deletion: null });
    expect((await api("GET", "/api/v1/me", { token: d.token })).body.error.code).toBe("DEVICE_REQUIRED");
  });
});

describe("upgrade keeping the user ID (§17.5.3, T-053.1, AC-4.1)", () => {
  it("an anonymous browser confirms an email and keeps its shares, links and device", async () => {
    const home = newNetwork();
    const anon = await Device.create(home.ip());
    const text = await anon.postText("before the upgrade");
    const file = await anon.uploadFile("kept.png", PNG_BYTES, "image/png", PNG_BYTES.length, "link_only");
    const link = await anon.createLink(file.init.body.share.id);

    const email = newEmail("upgrade");
    const since = new Date();
    const requested = await anon.supabase.auth.updateUser({ email });
    expect(requested.error).toBeNull();
    expect(requested.data.user?.is_anonymous).toBe(true);
    const confirmed = await anon.supabase.auth.verifyOtp({ email, token: await mailCode(email, since), type: "email_change" });
    expect(confirmed.error).toBeNull();
    const upgraded = await currentSession(anon.supabase);
    const claims = claimsOf(upgraded.accessToken);
    expect(claims.sub).toBe(anon.userId);
    expect(claims.is_anonymous).toBe(false);

    // The browser registers at its next start with the device ID it has: the same device, rebound.
    const device = await Device.attach(upgraded, home.ip(), { deviceId: anon.deviceId });
    expect(device.deviceId).toBe(anon.deviceId);
    expect(device.label).toBe(anon.label);
    expect(await device.myShareIds()).toEqual(expect.arrayContaining([text.id, file.init.body.share.id]));
    const viewer = new Viewer();
    expect((await viewer.unlock(link.id, link.secret)).status).toBe(200);
    expect((await device.call("GET", "/api/v1/me")).body.user).toMatchObject({ id: anon.userId, anonymous: false });
  });

  it("an email that already has an account can't be added: the browser stays anonymous (merge instead)", async () => {
    const { email } = await createAccount();
    const anon = await Device.create(newNetwork().ip(), { observe: false });
    const refused = await anon.supabase.auth.updateUser({ email });
    expect(refused.error?.code).toBe("email_exists");
    expect((await anon.call("GET", "/api/v1/me")).body.user.anonymous).toBe(true);
  });
});

describe("profile (§17.5.5)", () => {
  it("only accounts have a display name; it is cleaned like device labels and never logged", async () => {
    const anon = await Device.create(newNetwork().ip(), { observe: false });
    const refused = await anon.call("PATCH", "/api/v1/me/profile", { displayName: "Anon" });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("ACCOUNT_REQUIRED");

    const { email } = await createAccount();
    const d = await Device.attach(await signInByCode(email), newNetwork().ip(), { observe: false });
    const name = `Ada‮  Lovelace ${randomBytes(2).toString("hex")}`;
    const set = await d.call("PATCH", "/api/v1/me/profile", { displayName: name });
    expect(set.status).toBe(200);
    expect(set.body.user.displayName).toBe(name.replace("‮", "").replace(/\s+/g, " "));
    expect((await d.call("PATCH", "/api/v1/me/profile", { displayName: " ‮ " })).status).toBe(400);
    expect((await d.call("PATCH", "/api/v1/me/profile", { displayName: "x".repeat(201) })).status).toBe(400);
    expect((await d.call("PATCH", "/api/v1/me/profile", { displayName: "x", extra: 1 })).status).toBe(400);
    expect((await d.call("PATCH", "/api/v1/me/profile", { displayName: null })).body.user.displayName).toBeNull();
    const { rows } = await adminDb().query("select metadata from app.audit_events where action = 'profile.updated' and actor_user_id = $1", [d.userId]);
    expect(JSON.stringify(rows)).not.toContain("Lovelace");
  });
});

describe("no passwords (D4-2): a pre-hijack password is removed and refused (P4-00)", () => {
  it("someone who signed the address up with a password first can't use it once the owner signs in", async () => {
    const email = newEmail("victim");
    const password = `attacker-${randomBytes(8).toString("hex")}`;
    const attacker = browserClient();
    expect((await attacker.auth.signUp({ email, password })).error).toBeNull();

    // The owner signs in by code (that confirms the address), then the attacker tries the password.
    const owner = await signInByCode(email);
    const stolen = await attacker.auth.signInWithPassword({ email, password });
    expect(stolen.error).toBeNull();
    const attackerToken = stolen.data.session!.access_token;
    await attacker.realtime.setAuth(attackerToken);

    // The app refuses password sessions outright, Realtime too.
    expect((await api("GET", "/api/v1/me/devices", { token: attackerToken })).status).toBe(401);
    expect((await api("POST", "/api/v1/devices", { token: attackerToken, body: {} })).status).toBe(401);
    expect(await joins(attacker, `user:${owner.userId}`)).toBe("CHANNEL_ERROR");

    // The owner's browser starts the app: the password and its session are gone.
    const device = await Device.attach(owner, newNetwork().ip(), { observe: false });
    expect((await device.call("GET", "/api/v1/me")).status).toBe(200);
    expect((await attacker.auth.refreshSession()).error).not.toBeNull();
    expect((await browserClient().auth.signInWithPassword({ email, password })).error?.code).toBe("invalid_credentials");
    const audit = await adminDb().query("select metadata from app.audit_events where action = 'account.password_removed' and target_id = $1", [owner.userId]);
    expect(audit.rows[0]?.metadata).toEqual({ sessionsEnded: 1 });
  });

  it("an account made by code sign-up has no password anyone knows: nothing is audited", async () => {
    const email = newEmail("nopassword");
    const client = browserClient();
    const since = new Date();
    await client.auth.signInWithOtp({ email });
    await client.auth.verifyOtp({ email, token: await mailCode(email, since), type: "email" });
    const device = await Device.attach(await currentSession(client), newNetwork().ip(), { observe: false });
    const audit = await adminDb().query("select count(*)::int as n from app.audit_events where action = 'account.password_removed' and target_id = $1", [device.userId]);
    expect(audit.rows[0].n).toBe(0);
    expect((await authAdmin().auth.admin.getUserById(device.userId)).data.user?.email).toBe(email);
  });
});
