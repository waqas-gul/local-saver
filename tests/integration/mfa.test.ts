import { readFileSync } from "node:fs";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { authAdmin, browserClient, claimsOf, createAccount, currentSession, enrollTotp, signInByCode, stepUp, totp } from "./support/accounts";
import { adminDb, api, closeAdminDb, Device, newNetwork, signInAnonymously, stack, Viewer, type Session } from "./support/api";

/**
 * MFA (phase 4 §17.5.9, P4-24; T4-A12, D4-30): an account with a verified authenticator (Supabase Auth's TOTP factor)
 * uses the app only at aal2. The API refuses an aal1 session of such an account on every route that takes a session,
 * with or without a device (403 MFA_REQUIRED), and Realtime refuses its topics. Enrolling, confirming, challenging and
 * removing are Supabase Auth's (the browser calls it directly); what Auth itself refuses is recorded here too.
 */

afterAll(closeAdminDb);

const code = (response: { body: { error?: { code?: string } } | null }) => response.body?.error?.code;

async function joins(client: SupabaseClient, topic: string): Promise<string> {
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

/** An account with one browser (a device bound to its session), signed in by code: aal1. */
async function accountBrowser(ip = newNetwork().ip()) {
  const { email, userId } = await createAccount();
  const session = await signInByCode(email);
  const device = await Device.attach(session, ip);
  return { email, userId, session, device, ip };
}

/** Every route that takes a session, through this device and session: their status codes. */
async function sampleRoutes(token: string, deviceId: string, ip: string) {
  const call = (method: string, path: string, body?: unknown) => api(method, path, { token, deviceId, ip, body });
  return {
    register: await call("POST", "/api/v1/devices", {}),
    me: await call("GET", "/api/v1/me"),
    shares: await call("GET", "/api/v1/me/shares"),
    text: await call("POST", "/api/v1/texts", { destination: "link_only", content: "behind the authenticator" }),
    entitlements: await call("GET", "/api/v1/me/entitlements"),
    devices: await call("GET", "/api/v1/me/devices"),
    revoke: await call("DELETE", "/api/v1/me/devices/00000000-0000-4000-8000-000000000000"),
    profile: await call("PATCH", "/api/v1/me/profile", { displayName: "Behind the authenticator" }),
  };
}

const codesOf = (routes: Record<string, { status: number; body: { error?: { code?: string } } }>) =>
  Object.fromEntries(Object.entries(routes).map(([name, r]) => [name, r.status === 403 ? code(r) : r.status]));

describe("T4-A12: with an authenticator, every route needs aal2", () => {
  it("enrolling ends the account's other sessions (Auth); until their tokens expire the API and Realtime refuse them, and they can't step up", { timeout: 60_000 }, async () => {
    const a = await accountBrowser();
    const other = await Device.attach(await signInByCode(a.email), newNetwork().ip());
    expect((await other.call("GET", "/api/v1/me")).status).toBe(200);
    expect(await joins(other.supabase, `user:${a.userId}`)).toBe("SUBSCRIBED");

    const factor = await enrollTotp(a.session.client);
    const enrolled = await currentSession(a.session.client);
    expect(claimsOf(enrolled.accessToken).aal).toBe("aal2");

    // Supabase Auth deleted the account's aal1 sessions when the factor was confirmed (§31.6, finding 2)...
    const otherSession = claimsOf(other.token).session_id;
    expect((await adminDb().query("select count(*)::int as n from auth.sessions where id = $1", [otherSession])).rows[0].n).toBe(0);
    // ...but an access token stays valid until it expires: the app refuses it everywhere, its device notwithstanding.
    const refused = codesOf(await sampleRoutes(other.token, other.deviceId, other.ip!));
    expect(refused).toEqual({
      register: "MFA_REQUIRED",
      me: "MFA_REQUIRED",
      shares: "MFA_REQUIRED",
      text: "MFA_REQUIRED",
      entitlements: "MFA_REQUIRED",
      devices: "MFA_REQUIRED",
      revoke: "MFA_REQUIRED",
      profile: "MFA_REQUIRED",
    });
    expect(await joins(other.supabase, `user:${a.userId}`)).toBe("CHANNEL_ERROR");
    expect((await adminDb().query("select count(*)::int as n from app.shares where created_by_user_id = $1", [a.userId])).rows[0].n).toBe(0);
    // It can't confirm either: its session is gone, so that browser signs in again (next test).
    expect((await other.supabase.auth.mfa.challenge({ factorId: factor.factorId })).error).not.toBeNull();

    // The browser that enrolled is aal2 and goes on.
    expect((await api("GET", "/api/v1/me", { token: enrolled.accessToken, deviceId: a.device.deviceId, ip: a.ip })).body.mfa).toEqual({ enrolled: true, aal: "aal2" });
    expect(await joins(a.session.client, `user:${a.userId}`)).toBe("SUBSCRIBED");
  });

  it("a new sign-in by email code can't register a device until it confirms with the authenticator; then everything works (sign in with aal2)", { timeout: 60_000 }, async () => {
    const a = await accountBrowser();
    const factor = await enrollTotp(a.session.client);
    const newcomer = await signInByCode(a.email);
    expect(claimsOf(newcomer.accessToken).aal).toBe("aal1");
    const ip = newNetwork().ip();
    const registered = await api("POST", "/api/v1/devices", { token: newcomer.accessToken, ip, body: {} });
    expect([registered.status, code(registered)]).toEqual([403, "MFA_REQUIRED"]);
    expect((await adminDb().query("select count(*)::int as n from app.devices where auth_session_id = $1", [claimsOf(newcomer.accessToken).session_id])).rows[0].n).toBe(0);
    expect(await joins(newcomer.client, `user:${a.userId}`)).toBe("CHANNEL_ERROR");

    // The same session, stepped up with the authenticator: a device, every route and Realtime.
    const stepped = await stepUp(newcomer.client, factor.factorId, factor.secret);
    expect(claimsOf(stepped.accessToken).session_id).toBe(claimsOf(newcomer.accessToken).session_id);
    const device = await Device.attach(stepped, ip);
    const allowed = codesOf(await sampleRoutes(stepped.accessToken, device.deviceId, ip));
    expect(allowed).toEqual({ register: 200, me: 200, shares: 200, text: 201, entitlements: 200, devices: 200, revoke: 404, profile: 200 });
    expect((await device.call("GET", "/api/v1/me")).body.mfa).toEqual({ enrolled: true, aal: "aal2" });
    expect(await joins(newcomer.client, `user:${a.userId}`)).toBe("SUBSCRIBED");
  });

  it("nothing the client sends stands in for aal2: no header, no body field, no edited token", async () => {
    const a = await accountBrowser();
    await enrollTotp(a.session.client);
    const newcomer = await signInByCode(a.email);
    const ip = newNetwork().ip();
    const claimed = await api("POST", "/api/v1/devices", {
      token: newcomer.accessToken,
      ip,
      headers: { "x-mfa-verified": "true", "x-aal": "aal2" },
      body: { mfaVerified: true, aal: "aal2" },
    });
    expect(code(claimed)).toBe("MFA_REQUIRED");

    // The token with its aal claim edited to aal2: the signature no longer matches.
    const [header, payload, signature] = newcomer.accessToken.split(".");
    const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), aal: "aal2" })).toString("base64url");
    const forged = await api("POST", "/api/v1/devices", { token: `${header}.${edited}.${signature}`, ip, body: {} });
    expect([forged.status, code(forged)]).toEqual([401, "UNAUTHENTICATED"]);
  });

  it("accounts without an authenticator, anonymous users and link viewers are unaffected", async () => {
    const plain = await accountBrowser();
    expect((await plain.device.call("GET", "/api/v1/me")).body.mfa).toEqual({ enrolled: false, aal: "aal1" });
    const anon = await Device.create(newNetwork().ip(), { observe: false });
    const note = await anon.postText("an anonymous note", undefined, "link_only");
    const link = await anon.createLink(note.id);
    expect((await new Viewer().unlock(link.id, link.secret)).status).toBe(200);
    // Supabase Auth refuses an authenticator for anonymous users.
    const refused = await anon.supabase.auth.mfa.enroll({ factorType: "totp" });
    expect(refused.error?.code).toBe("no_authorization");
  });
});

describe("enrolling, confirming and removing (Supabase Auth, as the browser calls it)", () => {
  it("removing needs aal2: refused at aal1, then allowed stepped up; afterwards aal1 sessions work again", async () => {
    const a = await accountBrowser();
    const factor = await enrollTotp(a.session.client);
    const newcomer = await signInByCode(a.email);
    const refused = await newcomer.client.auth.mfa.unenroll({ factorId: factor.factorId });
    expect(refused.error?.code).toBe("insufficient_aal");
    // Nor can an aal1 session add a second authenticator to an account that has one.
    expect((await newcomer.client.auth.mfa.enroll({ factorType: "totp", friendlyName: "second" })).error?.code).toBe("insufficient_aal");

    await stepUp(newcomer.client, factor.factorId, factor.secret);
    expect((await newcomer.client.auth.mfa.unenroll({ factorId: factor.factorId })).error).toBeNull();
    const plain = await signInByCode(a.email);
    expect((await api("POST", "/api/v1/devices", { token: plain.accessToken, ip: newNetwork().ip(), body: {} })).status).toBe(200);
    expect((await adminDb().query("select count(*)::int as n from auth.mfa_factors where user_id = $1", [a.userId])).rows[0].n).toBe(0);
  });

  it("codes: a wrong one, an expired challenge, another account's factor and a used challenge are refused", async () => {
    const a = await accountBrowser();
    const factor = await enrollTotp(a.session.client);
    const newcomer = await signInByCode(a.email);
    const mfa = newcomer.client.auth.mfa;

    const first = await mfa.challenge({ factorId: factor.factorId });
    expect((await mfa.verify({ factorId: factor.factorId, challengeId: first.data!.id, code: totp(factor.secret, Date.now() - 10 * 60_000) })).error?.code).toBe("mfa_verification_failed");

    const aged = await mfa.challenge({ factorId: factor.factorId });
    await adminDb().query("update auth.mfa_challenges set created_at = created_at - interval '10 minutes' where id = $1", [aged.data!.id]);
    expect((await mfa.verify({ factorId: factor.factorId, challengeId: aged.data!.id, code: totp(factor.secret) })).error?.code).toBe("mfa_challenge_expired");

    const stranger = await signInByCode((await createAccount()).email);
    expect((await stranger.client.auth.mfa.challenge({ factorId: factor.factorId })).error?.code).toBe("mfa_factor_not_found");
    const theirs = await mfa.challenge({ factorId: factor.factorId });
    expect((await stranger.client.auth.mfa.verify({ factorId: factor.factorId, challengeId: theirs.data!.id, code: totp(factor.secret) })).error?.code).toBe("mfa_factor_not_found");
    expect(claimsOf((await currentSession(newcomer.client)).accessToken).aal).toBe("aal1");

    const used = await mfa.challenge({ factorId: factor.factorId });
    expect((await mfa.verify({ factorId: factor.factorId, challengeId: used.data!.id, code: totp(factor.secret) })).error).toBeNull();
    expect((await mfa.verify({ factorId: factor.factorId, challengeId: used.data!.id, code: totp(factor.secret) })).error).not.toBeNull();

    // Recorded, Supabase Auth's behaviour (§31.6, finding 1): the same code with a new challenge is accepted again
    // within its 30-second window. If this starts failing, Auth closed the gap: update §31.
    const again = await mfa.challenge({ factorId: factor.factorId });
    expect((await mfa.verify({ factorId: factor.factorId, challengeId: again.data!.id, code: totp(factor.secret) })).error).toBeNull();
  });

  it("the app never receives the authenticator's secret: not in its log, not in its answers", async () => {
    const a = await accountBrowser();
    const factor = await enrollTotp(a.session.client);
    const stepped = await currentSession(a.session.client);
    const me = await api("GET", "/api/v1/me", { token: stepped.accessToken, deviceId: a.device.deviceId, ip: a.ip });
    expect(me.body.mfa).toEqual({ enrolled: true, aal: "aal2" });
    expect(me.text).not.toContain(factor.secret);
    expect(me.text).not.toContain(factor.factorId);
    expect(readFileSync(stack().serverLog, "utf8")).not.toContain(factor.secret);
  });
});

describe("MFA with devices, suspension, deletion and the merge", () => {
  it("a revoked device stays revoked at aal2; a suspended account is refused at aal2, and at aal1 learns only that it must confirm", async () => {
    const a = await accountBrowser();
    const factor = await enrollTotp(a.session.client);
    const owner = await currentSession(a.session.client);

    const other = await stepUp((await signInByCode(a.email)).client, factor.factorId, factor.secret);
    const otherDevice = await Device.attach(other, newNetwork().ip());
    expect((await api("DELETE", `/api/v1/me/devices/${otherDevice.deviceId}`, { token: owner.accessToken, deviceId: a.device.deviceId, ip: a.ip })).status).toBe(204);
    expect(code(await otherDevice.call("GET", "/api/v1/me"))).toBe("DEVICE_REVOKED");
    // Its Auth session is gone: it can't step up again either.
    expect((await other.client.auth.mfa.challenge({ factorId: factor.factorId })).error).not.toBeNull();

    const aal1 = await signInByCode(a.email);
    await adminDb().query("insert into app.user_flags (user_id, suspended_at, reason) values ($1, now(), 'test')", [a.userId]);
    expect(code(await api("GET", "/api/v1/me", { token: owner.accessToken, deviceId: a.device.deviceId, ip: a.ip }))).toBe("USER_SUSPENDED");
    expect(code(await api("POST", "/api/v1/devices", { token: aal1.accessToken, ip: newNetwork().ip(), body: {} }))).toBe("MFA_REQUIRED");
  });

  it("a pending deletion is cancelled only at aal2; an account deleted by the job takes its authenticator with it", { timeout: 60_000 }, async () => {
    const a = await accountBrowser();
    const other = await Device.attach(await signInByCode(a.email), newNetwork().ip());
    const factor = await enrollTotp(a.session.client);
    const owner = await currentSession(a.session.client);
    expect((await api("DELETE", "/api/v1/me", { token: owner.accessToken, deviceId: a.device.deviceId, ip: a.ip })).status).toBe(202);

    // The other browser's session (ended by Auth at enrolment, its token still valid): refused.
    expect(code(await other.call("POST", "/api/v1/me/deletion/cancel", {}))).toBe("MFA_REQUIRED");
    // Signed in again and stepped up, it cancels.
    const stepped = await stepUp((await signInByCode(a.email)).client, factor.factorId, factor.secret);
    const again = await Device.attach(stepped, other.ip);
    expect((await again.call("POST", "/api/v1/me/deletion/cancel", {})).status).toBe(204);

    expect((await api("DELETE", "/api/v1/me", { token: owner.accessToken, deviceId: a.device.deviceId, ip: a.ip })).status).toBe(202);
    await adminDb().query("update app.profiles set deletion_scheduled_for = now() - interval '1 minute' where user_id = $1", [a.userId]);
    await adminDb().query("select app.run_job('delete-due-accounts')");
    expect((await authAdmin().auth.admin.getUserById(a.userId)).data.user ?? null).toBeNull();
    expect((await adminDb().query("select count(*)::int as n from auth.mfa_factors where user_id = $1", [a.userId])).rows[0].n).toBe(0);
  });

  it("a merge into an account with an authenticator waits for aal2, and its intent is kept until then", async () => {
    const a = await accountBrowser();
    const factor = await enrollTotp(a.session.client);
    const ip = newNetwork().ip();
    const anon = await Device.attach(await signInAnonymously(), ip);
    const note = await anon.postText("moves after the authenticator", undefined, "link_only");
    const created = (await anon.call("POST", "/api/v1/account/merge-intents", {})).body as { intentId: string; secret: string };
    const intent = { intentId: created.intentId, secret: created.secret };

    // This browser signs in to the account by code (aal1), then redeems: refused, and the intent stays open.
    const client = browserClient();
    const signedIn: Session = await signInByCode(a.email, client);
    const redeem = (token: string) => api("POST", "/api/v1/account/merge-anonymous", { token, deviceId: anon.deviceId, ip, body: intent });
    expect(code(await redeem(signedIn.accessToken))).toBe("MFA_REQUIRED");
    const open = await adminDb().query("select status from app.merge_intents where id = $1", [intent.intentId]);
    expect(open.rows[0].status).toBe("open");
    expect((await adminDb().query("select created_by_user_id from app.shares where id = $1", [note.id])).rows[0].created_by_user_id).toBe(anon.userId);

    const stepped = await stepUp(client, factor.factorId, factor.secret);
    const merged = await redeem(stepped.accessToken);
    expect(merged.status).toBe(200);
    expect((await adminDb().query("select created_by_user_id from app.shares where id = $1", [note.id])).rows[0].created_by_user_id).toBe(a.userId);
  });
});
