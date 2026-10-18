import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { claimsOf, createAccount, enrollTotp, signInByCode, stepUp } from "./support/accounts";
import { adminDb, api, type ApiResponse, closeAdminDb, Device, newNetwork, PNG_BYTES, Viewer } from "./support/api";
import { control, providerState, reconcile, subscriber, subscriptionRow } from "./support/billing";
import { grantOverride } from "./support/entitlements";
import { createInvite, createRoom, join, postRoomText } from "./support/rooms";

/**
 * The account-deletion flow (phase 4 §17.5.7, P4-22; D4-6 and D4-30 as recommended): T4-A5's request, grace and
 * schedule, and T4-A6. DELETE /me needs an account with a recent sign-in (aal2 with an authenticator) and schedules the
 * deletion seven days ahead, whatever the client sends; the grace is read-only and cancellable; after the date only
 * the hourly job deletes, through app.delete_due_accounts (what it deletes and keeps is P4-21's,
 * tests/integration/account-coverage.test.ts and supabase/tests/phase4_account_coverage.test.sql). Then the races:
 * repeated requests, request against cancel, and the job against a new sign-in, a merge and the account's room.
 */

afterAll(closeAdminDb);

const code = (response: ApiResponse) => response.body?.error?.code as string | undefined;
const DAY_MS = 86_400_000;

async function account(ip: string | null = newNetwork().ip()) {
  const created = await createAccount();
  const session = await signInByCode(created.email);
  const device = await Device.attach(session, ip);
  return { ...created, session, device };
}

const requestDeletion = (device: Device, body?: unknown) => device.call("DELETE", "/api/v1/me", body);
const cancelDeletion = (device: Device) => device.call("POST", "/api/v1/me/deletion/cancel", {});

async function deletionOf(userId: string): Promise<{ requestedAt: Date; scheduledFor: Date } | null> {
  const { rows } = await adminDb().query("select deletion_requested_at, deletion_scheduled_for from app.profiles where user_id = $1", [userId]);
  const row = rows[0];
  return row?.deletion_scheduled_for ? { requestedAt: row.deletion_requested_at, scheduledFor: row.deletion_scheduled_for } : null;
}

async function audits(userId: string, action: string): Promise<number> {
  const { rows } = await adminDb().query("select count(*)::int as n from app.audit_events where target_id = $1 and action = $2", [userId, action]);
  return rows[0].n;
}

async function userExists(userId: string): Promise<boolean> {
  const { rows } = await adminDb().query("select count(*)::int as n from auth.users where id = $1", [userId]);
  return rows[0].n === 1;
}

/** The grace ends now (the deletion date in the past), as seven days later. */
async function makeDue(userId: string): Promise<void> {
  await adminDb().query("update app.profiles set deletion_scheduled_for = now() - interval '1 second' where user_id = $1", [userId]);
}

/** What pg_cron runs every hour. */
async function runDeletionJob(): Promise<{ deleted: number }> {
  await adminDb().query("select app.run_job('delete-due-accounts')");
  const { rows } = await adminDb().query("select last_result, last_failed_at, last_succeeded_at from app.job_heartbeats where job = 'delete-due-accounts'");
  expect(rows[0].last_succeeded_at.getTime()).toBeGreaterThan(rows[0].last_failed_at?.getTime() ?? 0);
  return rows[0].last_result;
}

describe("requesting the deletion (T4-A5)", () => {
  it("schedules it seven days ahead whatever the client sends; repeats get 409; only the caller's own account changes", async () => {
    const home = newNetwork();
    const leaving = await account(home.ip());
    const bystander = await account(home.ip());
    const before = Date.now();
    const accepted = await requestDeletion(leaving.device, { graceDays: 0, scheduledFor: new Date().toISOString(), userId: bystander.userId });
    expect(accepted.status, accepted.text).toBe(202);
    const scheduledFor = new Date(accepted.body.scheduledFor).getTime();
    expect(scheduledFor).toBeGreaterThanOrEqual(before + 7 * DAY_MS - 60_000);
    expect(scheduledFor).toBeLessThanOrEqual(Date.now() + 7 * DAY_MS + 60_000);
    const stored = await deletionOf(leaving.userId);
    expect(stored!.scheduledFor.getTime() - stored!.requestedAt.getTime()).toBe(7 * DAY_MS);
    expect((await leaving.device.call("GET", "/api/v1/me")).body.deletion).toEqual({ scheduledFor: accepted.body.scheduledFor });
    expect(await audits(leaving.userId, "account.deletion_requested")).toBe(1);

    // Again: refused with the date already set, which doesn't move; no second audit row.
    const again = await requestDeletion(leaving.device);
    expect([again.status, code(again), again.body.error.details]).toEqual([409, "DELETION_PENDING", { scheduledFor: accepted.body.scheduledFor }]);
    expect((await deletionOf(leaving.userId))!.scheduledFor.getTime()).toBe(scheduledFor);
    expect(await audits(leaving.userId, "account.deletion_requested")).toBe(1);

    // Another browser of the account sees it; the other account (named in the body) doesn't, and can't cancel it.
    const secondBrowser = await Device.attach(await signInByCode(leaving.email), home.ip());
    expect((await secondBrowser.call("GET", "/api/v1/me")).body.deletion).toEqual({ scheduledFor: accepted.body.scheduledFor });
    expect((await bystander.device.call("GET", "/api/v1/me")).body.deletion).toBeNull();
    expect(await deletionOf(bystander.userId)).toBeNull();
    expect((await cancelDeletion(bystander.device)).status).toBe(404);
    expect(await deletionOf(leaving.userId)).not.toBeNull();
  });

  it("needs an account, a sign-in within 10 minutes, aal2 with an authenticator, a live device and no suspension", async () => {
    const ip = newNetwork().ip();
    expect((await api("DELETE", "/api/v1/me", { ip })).status).toBe(401);
    const anonymous = await Device.create(ip);
    const notAnAccount = await requestDeletion(anonymous);
    expect([notAnAccount.status, code(notAnAccount)]).toEqual([403, "ACCOUNT_REQUIRED"]);
    expect((await cancelDeletion(anonymous)).status).toBe(403);

    // A session whose sign-in is 20 minutes old (its refreshed token says when Auth last verified the method).
    const stale = await account(ip);
    const sessionId = claimsOf(stale.session.accessToken).session_id as string;
    await adminDb().query(
      "update auth.mfa_amr_claims set created_at = now() - interval '20 minutes', updated_at = now() - interval '20 minutes' where session_id = $1",
      [sessionId],
    );
    const refreshed = await stale.session.client.auth.refreshSession();
    const oldToken = refreshed.data.session!.access_token;
    expect(claimsOf(oldToken).session_id).toBe(sessionId);
    const refused = await api("DELETE", "/api/v1/me", { token: oldToken, deviceId: stale.device.deviceId, ip });
    expect([refused.status, code(refused), refused.body.error.details]).toEqual([403, "REAUTH_REQUIRED", { withinSeconds: 600 }]);
    expect(await deletionOf(stale.userId)).toBeNull();
    // The UI's answer: a new code, which signs this browser in again (a new session; the device follows it).
    const fresh = await signInByCode(stale.email, stale.session.client);
    expect((await api("POST", "/api/v1/devices", { token: fresh.accessToken, deviceId: stale.device.deviceId, ip, body: {} })).status).toBe(200);
    expect((await api("DELETE", "/api/v1/me", { token: fresh.accessToken, deviceId: stale.device.deviceId, ip })).status).toBe(202);

    // An authenticator: an aal1 session gets MFA_REQUIRED until the authenticator steps it up. P4-24: an aal1 session of
    // an account with an authenticator can't register a device any more, so this browser registers before the factor
    // exists (Supabase Auth then ends its session, but its token stays valid until it expires); a new sign-in steps up.
    const guarded = await account(ip);
    const newcomerDevice = await Device.attach(await signInByCode(guarded.email), ip);
    const factor = await enrollTotp(guarded.session.client);
    expect(code(await requestDeletion(newcomerDevice))).toBe("MFA_REQUIRED");
    expect(await deletionOf(guarded.userId)).toBeNull();
    const stepped = await stepUp((await signInByCode(guarded.email)).client, factor.factorId, factor.secret);
    const steppedDevice = await Device.attach(stepped, ip);
    expect((await api("DELETE", "/api/v1/me", { token: stepped.accessToken, deviceId: steppedDevice.deviceId, ip })).status).toBe(202);

    // A revoked device: 401, for the request and the cancel.
    const revoked = await account(ip);
    const otherBrowser = await Device.attach(await signInByCode(revoked.email), ip);
    expect((await revoked.device.call("DELETE", `/api/v1/me/devices/${otherBrowser.deviceId}`)).status).toBe(204);
    expect(code(await requestDeletion(otherBrowser))).toBe("DEVICE_REVOKED");
    expect(code(await cancelDeletion(otherBrowser))).toBe("DEVICE_REVOKED");
    expect(await deletionOf(revoked.userId)).toBeNull();

    // A suspended account: 403 (an operator handles it, DV4-13), for the request and the cancel.
    const suspended = await account(ip);
    expect((await requestDeletion(suspended.device)).status).toBe(202);
    await adminDb().query("insert into app.user_flags (user_id, suspended_at, reason) values ($1, now(), 'test')", [suspended.userId]);
    expect(code(await cancelDeletion(suspended.device))).toBe("USER_SUSPENDED");
    expect(code(await requestDeletion(suspended.device))).toBe("USER_SUSPENDED");
    expect(await deletionOf(suspended.userId)).not.toBeNull();
  });
});

describe("the grace (T4-A5, T4-A6)", () => {
  it("is read-only, keeps existing content working, and cancelling restores writes", async () => {
    const home = newNetwork();
    const owner = await account(home.ip());
    await grantOverride(owner.userId);
    const note = await owner.device.postText(`kept ${randomBytes(3).toString("hex")}`);
    const link = await owner.device.createLink(note.id);
    const room = await createRoom(owner.device);
    const member = await Device.create(home.ip());
    await join(member, await createInvite(owner.device, room.id));
    const memberPost = await postRoomText(member, room.id);

    expect((await requestDeletion(owner.device)).status).toBe(202);
    const refusals = [
      await owner.device.call("POST", "/api/v1/texts", { destination: "network", content: "new" }),
      await owner.device.call("POST", `/api/v1/shares/${note.id}/links`, {}),
      await owner.device.call("POST", "/api/v1/rooms", {}),
      await owner.device.call("POST", `/api/v1/rooms/${room.id}/invites`, { kind: "invite_link", expiresIn: 86_400 }),
    ];
    expect(refusals.map((r) => [r.status, code(r)])).toEqual(Array(4).fill([403, "ACCOUNT_DELETION_PENDING"]));
    // What exists keeps working for everyone, the account included.
    const viewer = new Viewer();
    expect((await viewer.unlock(link.id, link.secret)).status).toBe(200);
    expect((await viewer.content(link.id)).status).toBe(200);
    const feed = (await member.call("GET", `/api/v1/rooms/${room.id}/shares`)).body.shares as { id: string }[];
    expect(feed.map((s) => s.id)).toContain(memberPost.id);
    expect(await owner.device.myShareIds()).toContain(note.id);

    expect((await cancelDeletion(owner.device)).status).toBe(204);
    expect((await owner.device.call("GET", "/api/v1/me")).body.deletion).toBeNull();
    expect(await audits(owner.userId, "account.deletion_cancelled")).toBe(1);
    expect((await owner.device.call("POST", "/api/v1/texts", { destination: "network", content: "back" })).status).toBe(201);
    expect((await owner.device.call("POST", `/api/v1/shares/${note.id}/links`, {})).status).toBe(201);
    expect((await owner.device.call("POST", "/api/v1/rooms", {})).status).toBe(201);
    // Nothing to cancel any more.
    expect((await cancelDeletion(owner.device)).status).toBe(404);
    expect(await audits(owner.userId, "account.deletion_cancelled")).toBe(1);
  });

  it("stops the subscription renewing at the request; a provider failure is left to reconciliation", async () => {
    const paying = await subscriber();
    expect((await requestDeletion(paying.device)).status).toBe(202);
    expect((await providerState()).subscriptions.find((s) => s.id === paying.subscriptionId)!.cancel_at_period_end).toBe(true);
    expect((await subscriptionRow(paying.subscriptionId)).cancel_at_period_end).toBe(true);
    // Pro lasts until the period ends.
    expect((await paying.device.call("GET", "/api/v1/me/entitlements")).body.plan).toBe("pro");

    const unlucky = await subscriber();
    await control("/fail-api", { count: 1 });
    expect((await requestDeletion(unlucky.device)).status).toBe(202);
    expect((await providerState()).subscriptions.find((s) => s.id === unlucky.subscriptionId)!.cancel_at_period_end).toBe(false);
    expect((await reconcile()).last_result.deletionCancels).toBeGreaterThanOrEqual(1);
    expect((await providerState()).subscriptions.find((s) => s.id === unlucky.subscriptionId)!.cancel_at_period_end).toBe(true);
  });
});

describe("after the grace", () => {
  it("can't be cancelled; the hourly job deletes the account and leaves accounts in their grace or cancelled", async () => {
    const ip = newNetwork().ip();
    const due = await account(ip);
    const waiting = await account(ip);
    const changedMind = await account(ip);
    for (const a of [due, waiting, changedMind]) expect((await requestDeletion(a.device)).status).toBe(202);
    expect((await cancelDeletion(changedMind.device)).status).toBe(204);
    await makeDue(due.userId);

    const late = await cancelDeletion(due.device);
    expect([late.status, code(late)]).toEqual([409, "DELETION_DUE"]);
    expect(await deletionOf(due.userId)).not.toBeNull();
    // Directly, too: the function refuses a due deletion.
    expect((await adminDb().query("select app.cancel_account_deletion($1) as ok", [due.userId])).rows[0].ok).toBe(false);

    expect((await runDeletionJob()).deleted).toBeGreaterThanOrEqual(1);
    expect(await userExists(due.userId)).toBe(false);
    expect(await audits(due.userId, "account.deleted")).toBe(1);
    expect((await deletionOf(waiting.userId))?.scheduledFor.getTime()).toBeGreaterThan(Date.now());
    expect(await userExists(changedMind.userId)).toBe(true);
    expect(await deletionOf(changedMind.userId)).toBeNull();

    // The deleted account's browser: its requests, a new registration and its refresh token all fail.
    expect((await due.device.call("GET", "/api/v1/me")).status).toBe(401);
    expect(code(await api("POST", "/api/v1/devices", { token: due.session.accessToken, ip, body: {} }))).toBe("UNAUTHENTICATED");
    expect((await due.session.client.auth.refreshSession()).error).not.toBeNull();
  });
});

describe("races", () => {
  it("parallel requests: one 202 and one audit row; the rest are refused", async () => {
    const leaving = await account();
    const responses = await Promise.all(Array.from({ length: 6 }, () => requestDeletion(leaving.device)));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 202)).toHaveLength(1);
    expect(statuses.every((s) => s === 202 || s === 409 || s === 429)).toBe(true);
    expect(await audits(leaving.userId, "account.deletion_requested")).toBe(1);
  });

  it("a cancel against a repeated request: the outcome always matches the stored state (5 rounds)", async () => {
    for (let round = 0; round < 5; round++) {
      const leaving = await account();
      expect((await requestDeletion(leaving.device)).status).toBe(202);
      const [cancelled, requested] = await Promise.all([cancelDeletion(leaving.device), requestDeletion(leaving.device)]);
      expect(cancelled.status).toBe(204);
      expect([202, 409]).toContain(requested.status);
      // 202: the request ran after the cancel, so a new deletion is pending; 409: it ran before, and the cancel won.
      expect(Boolean(await deletionOf(leaving.userId))).toBe(requested.status === 202);
      expect(await audits(leaving.userId, "account.deletion_requested")).toBe(requested.status === 202 ? 2 : 1);
    }
  });

  it("the job against the account signing in again: never a 500, and nothing of the account is left (4 rounds)", async () => {
    const ip = newNetwork().ip();
    for (let round = 0; round < 4; round++) {
      const leaving = await account(ip);
      expect((await requestDeletion(leaving.device)).status).toBe(202);
      await makeDue(leaving.userId);
      const [signedIn] = await Promise.all([
        signInByCode(leaving.email)
          .then((s) => api("POST", "/api/v1/devices", { token: s.accessToken, ip, body: {} }))
          .catch(() => null),
        adminDb().query("select app.delete_due_accounts(100)"),
      ]);
      if (signedIn) expect([200, 401]).toContain(signedIn.status);
      expect(await userExists(leaving.userId)).toBe(false);
      const { rows } = await adminDb().query("select count(*)::int as n from app.devices where user_id = $1", [leaving.userId]);
      expect(rows[0].n).toBe(0);
    }
  });

  it("the job against a merge into the account: the anonymous browser's things are merged and deleted, or stay its own (4 rounds)", async () => {
    const ip = newNetwork().ip();
    for (let round = 0; round < 4; round++) {
      const target = await account(ip);
      expect((await requestDeletion(target.device)).status).toBe(202);
      const anon = await Device.create(ip);
      const anonNote = await anon.postText(`anon ${randomBytes(3).toString("hex")}`);
      const { intentId, secret } = (await anon.call("POST", "/api/v1/account/merge-intents", {})).body as { intentId: string; secret: string };
      const merging = await signInByCode(target.email);
      await makeDue(target.userId);
      const [merged] = await Promise.all([
        api("POST", "/api/v1/account/merge-anonymous", { token: merging.accessToken, deviceId: anon.deviceId, body: { intentId, secret } }),
        adminDb().query("select app.delete_due_accounts(100)"),
      ]);
      expect([200, 401, 404, 409]).toContain(merged.status);
      expect(await userExists(target.userId)).toBe(false);
      const { rows } = await adminDb().query("select ended_at, end_reason, created_by_user_id from app.shares where id = $1", [anonNote.id]);
      if (merged.status === 200) {
        // Merged first: the note became the account's and ended with it; the anonymous user went with the merge.
        expect(await userExists(anon.userId)).toBe(false);
        expect([rows[0].end_reason, rows[0].created_by_user_id]).toEqual(["account_deleted", null]);
      } else {
        // Deleted first: the merge found no account; the anonymous browser keeps its note.
        expect(await userExists(anon.userId)).toBe(true);
        expect([rows[0].ended_at, rows[0].created_by_user_id]).toEqual([null, anon.userId]);
      }
    }
  });

  it("the job against its room's activity: never a 500; the room, its posts and the account's links all end (4 rounds)", async () => {
    for (let round = 0; round < 4; round++) {
      const home = newNetwork();
      const owner = await account(home.ip());
      await grantOverride(owner.userId);
      const note = await owner.device.postText(`owner ${randomBytes(3).toString("hex")}`);
      const link = await owner.device.createLink(note.id);
      const room = await createRoom(owner.device);
      const member = await Device.create(home.ip());
      await join(member, await createInvite(owner.device, room.id));
      const viewer = new Viewer();
      expect((await viewer.unlock(link.id, link.secret)).status).toBe(200);
      expect((await requestDeletion(owner.device)).status).toBe(202);
      await makeDue(owner.userId);

      const [responses] = await Promise.all([
        Promise.all([
          member.call("POST", "/api/v1/texts", { destination: { room: room.id }, content: `racing ${round}` }),
          member.call("POST", "/api/v1/shares", { destination: { room: room.id }, files: [{ name: "racing.png", size: PNG_BYTES.length, type: "image/png" }] }),
          member.call("GET", `/api/v1/rooms/${room.id}/shares`),
          viewer.content(link.id),
          owner.device.call("GET", "/api/v1/me"),
        ]),
        adminDb().query("select app.delete_due_accounts(100)"),
      ]);
      for (const response of responses) expect(response.status, response.text).toBeLessThan(500);

      expect(await userExists(owner.userId)).toBe(false);
      const open = await adminDb().query(
        "select count(*)::int as n from app.shares where (room_id = $1 or created_by_user_id = $2 or id = $3) and ended_at is null",
        [room.id, owner.userId, note.id],
      );
      expect(open.rows[0].n).toBe(0);
      expect(code(await viewer.content(link.id))).toBe("LINK_EXPIRED");
      expect((await member.call("GET", `/api/v1/rooms/${room.id}`)).status).toBe(404);
    }
  });
});
