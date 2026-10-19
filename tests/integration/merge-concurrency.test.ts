import { afterAll, describe, expect, it } from "vitest";
import { createAccount, signInByCode } from "./support/accounts";
import { adminDb, api, closeAdminDb, Device, newNetwork, PNG_BYTES } from "./support/api";

/**
 * Merges under concurrency (phase 4 §17.9: M6, M7, M8; T-053.9, T-053.10). The intent's row lock
 * serializes redemptions of one intent; both users' rows, locked in UUID order, serialize merges
 * into one account; the ledger stays exact.
 */

afterAll(closeAdminDb);

async function anonymousWithFile() {
  const anon = await Device.create(newNetwork().ip());
  await anon.uploadFile("c.png", PNG_BYTES, "image/png");
  await anon.postText("concurrent");
  const created = await anon.call("POST", "/api/v1/account/merge-intents", {});
  expect(created.status).toBe(201);
  return { anon, intent: { intentId: created.body.intentId as string, secret: created.body.secret as string } };
}

function redeem(token: string, deviceId: string, intent: { intentId: string; secret: string }) {
  return api("POST", "/api/v1/account/merge-anonymous", { token, deviceId, body: intent });
}

async function ledger(userId: string) {
  const { rows } = await adminDb().query(
    `select coalesce((select bytes_committed from app.storage_usage where subject_type = 'user' and subject_id = $1), 0)::bigint as committed,
            (select coalesce(sum(f.size_bytes), 0) from app.files f join app.shares s on s.id = f.share_id
              where s.billing_subject_id = $1 and f.upload_status = 'verified')::bigint as counted`,
    [userId],
  );
  return rows[0] as { committed: string; counted: string };
}

describe("concurrent merges", () => {
  it("10 parallel redemptions of one intent have one effect and the same answer (M6)", async () => {
    const { anon, intent } = await anonymousWithFile();
    const { email, userId } = await createAccount();
    const session = await signInByCode(email);
    const results = await Promise.all(Array.from({ length: 10 }, () => redeem(session.accessToken, anon.deviceId, intent)));
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(new Set(results.map((r) => JSON.stringify(r.body))).size).toBe(1);
    const audits = await adminDb().query("select count(*)::int as n from app.audit_events where action = 'account.merged' and actor_user_id = $1", [userId]);
    expect(audits.rows[0].n).toBe(1);
    const l = await ledger(userId);
    expect(l.committed).toBe(l.counted);
    expect(Number(l.counted)).toBe(PNG_BYTES.length);
  }, 60_000);

  it("two anonymous browsers merging into one account at once both arrive, the ledger exact (M7, M8)", async () => {
    const a = await anonymousWithFile();
    const b = await anonymousWithFile();
    const { email, userId } = await createAccount();
    // Two browsers signed in one after another (a new code replaces the previous one); merged at once.
    const sa = await signInByCode(email);
    const sb = await signInByCode(email);
    const [ra, rb] = await Promise.all([redeem(sa.accessToken, a.anon.deviceId, a.intent), redeem(sb.accessToken, b.anon.deviceId, b.intent)]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    const l = await ledger(userId);
    expect(l.committed).toBe(l.counted);
    expect(Number(l.counted)).toBe(2 * PNG_BYTES.length);
    const { rows } = await adminDb().query("select count(*)::int as n from app.shares where created_by_user_id = $1", [userId]);
    expect(rows[0].n).toBe(4);
  }, 60_000);

  it("one intent raced by two accounts goes to exactly one of them (M7)", async () => {
    const { anon, intent } = await anonymousWithFile();
    const one = await signInByCode((await createAccount()).email);
    const two = await signInByCode((await createAccount()).email);
    const results = await Promise.all([redeem(one.accessToken, anon.deviceId, intent), redeem(two.accessToken, anon.deviceId, intent)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const { rows } = await adminDb().query("select count(*)::int as n from app.shares where created_by_user_id in ($1, $2)", [one.userId, two.userId]);
    expect(rows[0].n).toBe(2);
  }, 60_000);
});
