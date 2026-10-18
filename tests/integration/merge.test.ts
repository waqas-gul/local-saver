import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createAccount, signInByCode } from "./support/accounts";
import { adminDb, api, closeAdminDb, Device, newNetwork, PNG_BYTES, setFlag, Viewer, type Session } from "./support/api";

/**
 * Merging an anonymous browser into an existing account (phase 4 §17.5.4; threat model §17.9,
 * RISK-024; T-053.2 … T-053.19). The anonymous session makes the intent; after signing in, the same
 * browser (its X-Device-Id) redeems it with the account's token and the one-time secret.
 */

afterAll(closeAdminDb);

type Intent = { intentId: string; secret: string; expiresAt: string };

async function anonymousWithData(ip = newNetwork().ip()) {
  const anon = await Device.create(ip);
  const text = await anon.postText(`merge ${randomBytes(3).toString("hex")}`);
  const file = await anon.uploadFile("merge.png", PNG_BYTES, "image/png", PNG_BYTES.length, "link_only");
  const link = await anon.createLink(file.init.body.share.id);
  return { anon, text, fileShare: file.init.body.share.id as string, link };
}

async function intentFor(anon: Device): Promise<Intent> {
  const created = await anon.call("POST", "/api/v1/account/merge-intents", {});
  expect(created.status).toBe(201);
  return created.body as Intent;
}

function redeem(session: Session, deviceId: string | undefined, intent: { intentId: string; secret: string }, extra: { origin?: string | null } = {}) {
  return api("POST", "/api/v1/account/merge-anonymous", { token: session.accessToken, deviceId, body: { intentId: intent.intentId, secret: intent.secret }, ...extra });
}

const userExists = async (id: string) => (await adminDb().query("select count(*)::int as n from auth.users where id = $1", [id])).rows[0].n === 1;

describe("merge intents (T-053.2)", () => {
  it("only an anonymous browser creates one; the secret is returned once and stored only as an HMAC", async () => {
    const { email } = await createAccount();
    const account = await Device.attach(await signInByCode(email), newNetwork().ip(), { observe: false });
    const refused = await account.call("POST", "/api/v1/account/merge-intents", {});
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("NOT_ANONYMOUS");

    const anon = await Device.create(newNetwork().ip(), { observe: false });
    const intent = await intentFor(anon);
    expect(intent.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(intent.expiresAt).getTime() - Date.now()).toBeGreaterThan(23.9 * 3600_000);
    const { rows } = await adminDb().query("select to_jsonb(i) as row from app.merge_intents i where id = $1", [intent.intentId]);
    expect(JSON.stringify(rows[0].row)).not.toContain(intent.secret);
    expect(JSON.stringify(rows[0].row)).not.toContain(Buffer.from(intent.secret, "base64url").toString("hex"));
  });

  it("a new intent replaces the old one", async () => {
    const anon = await Device.create(newNetwork().ip(), { observe: false });
    const first = await intentFor(anon);
    await intentFor(anon);
    const { email } = await createAccount();
    expect((await redeem(await signInByCode(email), anon.deviceId, first)).status).toBe(404);
  });

  it("needs this browser's device: a stolen token without the device ID can't make one (M1)", async () => {
    const anon = await Device.create(newNetwork().ip(), { observe: false });
    const response = await api("POST", "/api/v1/account/merge-intents", { token: anon.token, body: {} });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("DEVICE_REQUIRED");
  });
});

describe("the merge (T-053.3)", () => {
  it("moves every object to the account in one step and removes the anonymous user", async () => {
    const home = newNetwork();
    const { anon, text, fileShare, link } = await anonymousWithData(home.ip());
    const intent = await intentFor(anon);
    const { email, userId } = await createAccount();
    const session = await signInByCode(email);

    const merged = await redeem(session, anon.deviceId, intent);
    expect(merged.status).toBe(200);
    expect(merged.body.merged).toEqual({ shares: 2, links: 1, devices: 1, memberships: 0, bytes: PNG_BYTES.length });

    // The browser registers under the account: the same device and label, bound to the new session.
    const device = await Device.attach(session, home.ip(), { deviceId: anon.deviceId });
    expect([device.deviceId, device.label, device.userId]).toEqual([anon.deviceId, anon.label, userId]);
    expect(await device.myShareIds()).toEqual(expect.arrayContaining([text.id, fileShare]));
    expect((await new Viewer().unlock(link.id, link.secret)).status).toBe(200);
    expect(await userExists(anon.userId)).toBe(false);

    // The anonymous token is still valid for up to an hour, but has nothing left to act on.
    expect((await anon.call("GET", "/api/v1/me/shares")).body.error.code).toBe("DEVICE_UNKNOWN");
    expect((await api("POST", "/api/v1/devices", { token: anon.token, body: {} })).status).toBe(401);

    const audit = await adminDb().query("select metadata from app.audit_events where action = 'account.merged' and actor_user_id = $1", [userId]);
    expect(audit.rows[0].metadata).toMatchObject({ anonUserId: anon.userId, shares: 2, links: 1 });
    const ledger = await adminDb().query(
      `select u.bytes_committed::bigint as committed,
              (select coalesce(sum(f.size_bytes), 0) from app.files f join app.shares s on s.id = f.share_id
                where s.billing_subject_id = $1 and f.upload_status = 'verified')::bigint as counted
         from app.storage_usage u where u.subject_type = 'user' and u.subject_id = $1`,
      [userId],
    );
    expect(ledger.rows[0].committed).toBe(ledger.rows[0].counted);
  });

  it("a replay for the same account returns the same result; for another account it is a conflict (M4)", async () => {
    const { anon } = await anonymousWithData();
    const intent = await intentFor(anon);
    const owner = await signInByCode((await createAccount()).email);
    const first = await redeem(owner, anon.deviceId, intent);
    const again = await redeem(owner, anon.deviceId, intent);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    const other = await signInByCode((await createAccount()).email);
    const conflict = await redeem(other, anon.deviceId, intent);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("MERGE_CONFLICT");
  });

  it("an in-flight upload completes against the account after the merge, and the ledger adds up (M8)", async () => {
    const anon = await Device.create(newNetwork().ip());
    const init = await anon.call("POST", "/api/v1/shares", { destination: "network", files: [{ name: "late.png", size: PNG_BYTES.length, type: "image/png" }] });
    const upload = init.body.uploads[0];
    expect((await fetch(upload.url, { method: "PUT", headers: upload.headers, body: Buffer.from(PNG_BYTES) })).ok).toBe(true);

    const intent = await intentFor(anon);
    const { email, userId } = await createAccount();
    const session = await signInByCode(email);
    expect((await redeem(session, anon.deviceId, intent)).status).toBe(200);
    const device = await Device.attach(session, anon.ip, { deviceId: anon.deviceId });
    const completed = await device.call("POST", `/api/v1/shares/${init.body.share.id}/files/${upload.fileId}/complete`, {});
    expect(completed.status).toBe(200);
    const { rows } = await adminDb().query(
      "select bytes_committed::bigint as committed, bytes_reserved::bigint as reserved, files_committed as files from app.storage_usage where subject_type = 'user' and subject_id = $1",
      [userId],
    );
    expect(rows[0]).toEqual({ committed: String(PNG_BYTES.length), reserved: "0", files: 1 });
  });

  it("a burn claim moves with its device: the claimant keeps it (M15)", async () => {
    await setFlag("free_burn_after_download", true);
    try {
      const home = newNetwork();
      const creator = await Device.create(home.ip());
      const burn = await creator.postBurnText("for the claimant");
      const anon = await Device.create(home.ip());
      expect((await anon.call("POST", `/api/v1/shares/${burn.id}/reveal`, { confirm: true })).status).toBe(200);
      const intent = await intentFor(anon);
      const session = await signInByCode((await createAccount()).email);
      expect((await redeem(session, anon.deviceId, intent)).status).toBe(200);
      const device = await Device.attach(session, home.ip(), { deviceId: anon.deviceId });
      expect((await device.call("POST", `/api/v1/shares/${burn.id}/reveal`, { confirm: true })).status).toBe(200);
      expect((await device.call("POST", `/api/v1/shares/${burn.id}/confirm-received`, {})).status).toBe(204);
    } finally {
      await setFlag("free_burn_after_download", false);
    }
  });
});

describe("refusals (§17.9)", () => {
  it("a stolen secret is useless from another browser or without a device ID (M1)", async () => {
    const { anon } = await anonymousWithData();
    const intent = await intentFor(anon);
    const thief = await Device.attach(await signInByCode((await createAccount()).email), newNetwork().ip(), { observe: false });
    const session = { userId: thief.userId, accessToken: thief.token, client: thief.supabase };
    for (const deviceId of [thief.deviceId, undefined]) {
      const response = await redeem(session, deviceId, intent);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("MERGE_UNAVAILABLE");
    }
    expect(await userExists(anon.userId)).toBe(true);
  });

  it("an unknown intent, a wrong secret and an expired intent look the same (M2, M14)", async () => {
    const anon = await Device.create(newNetwork().ip(), { observe: false });
    const intent = await intentFor(anon);
    const session = await signInByCode((await createAccount()).email);
    const unknown = await redeem(session, anon.deviceId, { intentId: randomUUID(), secret: intent.secret });
    const wrong = await redeem(session, anon.deviceId, { intentId: intent.intentId, secret: randomBytes(32).toString("base64url") });
    await adminDb().query("update app.merge_intents set created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' where id = $1", [intent.intentId]);
    const expired = await redeem(session, anon.deviceId, intent);
    for (const response of [unknown, wrong, expired]) {
      expect(response.status).toBe(404);
      expect(response.body.error).toMatchObject({ code: "MERGE_UNAVAILABLE", message: "This merge isn't available" });
    }
    expect(await userExists(anon.userId)).toBe(true);
  });

  it("refuses another site's origin and non-JSON bodies (M3)", async () => {
    const anon = await Device.create(newNetwork().ip(), { observe: false });
    const intent = await intentFor(anon);
    const session = await signInByCode((await createAccount()).email);
    expect((await redeem(session, anon.deviceId, intent, { origin: "https://evil.example" })).status).toBe(403);
    const form = await api("POST", "/api/v1/account/merge-anonymous", {
      token: session.accessToken, deviceId: anon.deviceId, rawBody: `intentId=${intent.intentId}`, headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(form.status).toBe(415);
    expect(await userExists(anon.userId)).toBe(true);
  });

  it("an anonymous session can't redeem: the target must be an account (M13)", async () => {
    const anon = await Device.create(newNetwork().ip(), { observe: false });
    const intent = await intentFor(anon);
    const other = await Device.create(newNetwork().ip(), { observe: false });
    const response = await redeem({ userId: other.userId, accessToken: other.token, client: other.supabase }, anon.deviceId, intent);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("ACCOUNT_REQUIRED");
  });

  it("a suspended anonymous user can't be merged; an upload restriction carries over (M11)", async () => {
    const suspended = await Device.create(newNetwork().ip(), { observe: false });
    const intent = await intentFor(suspended);
    await adminDb().query("insert into app.user_flags (user_id, suspended_at, reason) values ($1, now(), 'test')", [suspended.userId]);
    const session = await signInByCode((await createAccount()).email);
    const refused = await redeem(session, suspended.deviceId, intent);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("USER_SUSPENDED");
    expect(await userExists(suspended.userId)).toBe(true);

    const restricted = await Device.create(newNetwork().ip(), { observe: false });
    const intent2 = await intentFor(restricted);
    await adminDb().query("insert into app.user_flags (user_id, upload_restricted) values ($1, true)", [restricted.userId]);
    const { email, userId } = await createAccount();
    expect((await redeem(await signInByCode(email), restricted.deviceId, intent2)).status).toBe(200);
    expect((await adminDb().query("select upload_restricted from app.user_flags where user_id = $1", [userId])).rows[0].upload_restricted).toBe(true);
  });

  it("the device cap applies; the intent stays open until a device is revoked (M12)", async () => {
    const { email } = await createAccount();
    const devices: Device[] = [];
    for (let i = 0; i < 10; i++) devices.push(await Device.attach(await signInByCode(email), newNetwork().ip(), { observe: false }));
    const anon = await Device.create(newNetwork().ip(), { observe: false });
    const intent = await intentFor(anon);
    const session = await signInByCode(email);
    const refused = await redeem(session, anon.deviceId, intent);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: "DEVICE_LIMIT", details: { maxDevices: 10, activeDevices: 10 } });
    expect(await userExists(anon.userId)).toBe(true);

    expect((await devices[0]!.call("DELETE", `/api/v1/me/devices/${devices[1]!.deviceId}`)).status).toBe(204);
    expect((await redeem(session, anon.deviceId, intent)).status).toBe(200);
  }, 60_000);

  it("the redemption is rate limited per account (10 per 10 minutes)", async () => {
    const session = await signInByCode((await createAccount()).email);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await redeem(session, randomUUID(), { intentId: randomUUID(), secret: randomBytes(32).toString("base64url") })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
