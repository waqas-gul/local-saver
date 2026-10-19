import { afterAll, describe, expect, it } from "vitest";
import { adminDb, api, closeAdminDb, Device, newNetwork, turnstilePass } from "./support/api";

/**
 * Retention jobs against data made through the API (phase 3 §17.6–§17.7): purge-tombstones with
 * the evidence exclusions (D-3), anonymous-user cleanup (T-045, D-9) and the storage-usage
 * reconciliation race (DEC-019). The jobs run through app.run_job, as pg_cron runs them.
 */

afterAll(closeAdminDb);

const runJob = (job: string) => adminDb().query("select app.run_job($1)", [job]);

async function heartbeat(job: string) {
  const { rows } = await adminDb().query("select last_succeeded_at, last_failed_at, last_error, last_result from app.job_heartbeats where job = $1", [job]);
  return rows[0];
}

describe("purge-tombstones (phase 3 §17.7, D-3)", () => {
  it("deletes an ended share past its purge date with its rows, and keeps a reported one", async () => {
    const net = newNetwork();
    const a = await Device.create(net.ip());
    const plain = await a.postText("to purge");
    const link = await a.createLink(plain.id);
    const reported = await a.postText("reported");
    const b = await Device.create(net.ip());
    expect(
      (await b.call("POST", "/api/v1/reports", { target: { type: "share", shareId: reported.id }, category: "spam", turnstileToken: turnstilePass() }))
        .status,
    ).toBe(201);
    for (const id of [plain.id, reported.id]) expect((await a.call("DELETE", `/api/v1/shares/${id}`)).status).toBe(204);
    await adminDb().query("update app.shares set metadata_purge_after = now() - interval '1 second' where id = any($1)", [[plain.id, reported.id]]);

    await runJob("purge-tombstones");
    const left = await adminDb().query("select id from app.shares where id = any($1)", [[plain.id, reported.id]]);
    expect(left.rows.map((r) => r.id)).toEqual([reported.id]);
    expect((await adminDb().query("select count(*)::int as n from app.share_links where id = $1", [link.id])).rows[0].n).toBe(0);
    expect((await adminDb().query("select count(*)::int as n from app.text_items where share_id = $1", [plain.id])).rows[0].n).toBe(0);
    // The report and its share stay together until the evidence policy is decided (Q-022).
    const report = await adminDb().query("select share_id from app.abuse_reports where share_id = $1", [reported.id]);
    expect(report.rows).toHaveLength(1);
    const hb = await heartbeat("purge-tombstones");
    expect(hb.last_succeeded_at).not.toBeNull();
    expect(hb.last_result.shares).toBeGreaterThanOrEqual(1);
    // The audit trail of the purged share outlives it (own retention date).
    const audit = await adminDb().query("select count(*)::int as n from app.audit_events where target_id = $1", [plain.id]);
    expect(audit.rows[0].n).toBeGreaterThan(0);
  });
});

describe("cleanup-anonymous-users (T-045, D-9)", () => {
  async function age(device: Device, options: { suspended?: boolean } = {}) {
    await adminDb().query(
      "update auth.users set created_at = now() - interval '40 days', last_sign_in_at = now() - interval '40 days' where id = $1",
      [device.userId],
    );
    await adminDb().query(
      "update auth.sessions set created_at = now() - interval '40 days', updated_at = now() - interval '40 days', refreshed_at = now() - interval '40 days' where user_id = $1",
      [device.userId],
    );
    await adminDb().query("update app.devices set last_seen_at = now() - interval '40 days' where user_id = $1", [device.userId]);
    if (options.suspended) {
      await adminDb().query("insert into app.user_flags (user_id, suspended_at, reason) values ($1, now() - interval '35 days', 'abuse')", [device.userId]);
    }
  }

  it("deletes inactive anonymous users with nothing open, and their sessions stop working; keeps the rest", async () => {
    const net = newNetwork();
    const gone = await Device.create(net.ip());
    const ended = await gone.postText("old post");
    expect((await gone.call("DELETE", `/api/v1/shares/${ended.id}`)).status).toBe(204);
    const withShare = await Device.create(net.ip());
    const open = await withShare.postText("still open");
    const suspended = await Device.create(net.ip());
    const active = await Device.create(net.ip());
    for (const d of [gone, withShare, suspended]) await age(d, { suspended: d === suspended });

    await runJob("cleanup-anonymous-users");
    const users = await adminDb().query("select id from auth.users where id = any($1)", [[gone.userId, withShare.userId, suspended.userId, active.userId]]);
    expect(users.rows.map((r) => r.id).sort()).toEqual([withShare.userId, suspended.userId, active.userId].sort());
    expect((await adminDb().query("select count(*)::int as n from app.devices where user_id = $1", [gone.userId])).rows[0].n).toBe(0);
    expect((await adminDb().query("select created_by_user_id from app.shares where id = $1", [ended.id])).rows[0].created_by_user_id).toBeNull();
    expect((await adminDb().query("select count(*)::int as n from app.user_flags where user_id = $1", [suspended.userId])).rows[0].n).toBe(1);
    expect((await gone.call("GET", "/api/v1/me/shares")).status).toBe(401);
    expect((await withShare.call("GET", `/api/v1/shares/${open.id}`)).status).toBe(200);
    expect((await heartbeat("cleanup-anonymous-users")).last_result.deleted).toBeGreaterThanOrEqual(1);
  });
});

describe("reconcile-storage-usage (DEC-019)", () => {
  it("corrects a drifted counter with an audit event", async () => {
    const a = await Device.create(newNetwork().ip());
    await a.uploadFile("c.txt", new TextEncoder().encode("counted"), "text/plain");
    await adminDb().query("update app.storage_usage set bytes_committed = bytes_committed + 5242880 where subject_id = $1", [a.userId]);
    await adminDb().query("update app.job_heartbeats set last_result = '{}' where job = 'reconcile-storage-usage'");
    await runJob("reconcile-storage-usage");
    const usage = await adminDb().query("select bytes_committed, files_committed from app.storage_usage where subject_id = $1", [a.userId]);
    expect(usage.rows[0]).toEqual({ bytes_committed: "7", files_committed: 1 });
    const audit = await adminDb().query("select metadata from app.audit_events where action = 'storage.drift_corrected' and target_id = $1", [a.userId]);
    expect(audit.rows[0].metadata).toMatchObject({ committedAfter: 7 });
    expect((await heartbeat("reconcile-storage-usage")).last_result.drift).toBeGreaterThanOrEqual(1);
  });

  it("reconciling while 20 uploads complete never makes a false correction (race test)", { timeout: 120_000 }, async () => {
    const a = await Device.create(newNetwork().ip());
    const init = await a.call("POST", "/api/v1/shares", {
      destination: "network",
      files: Array.from({ length: 20 }, (_, i) => ({ name: `f${i}.txt`, size: 4, type: "text/plain" })),
    });
    expect(init.status).toBe(201);
    const uploads = init.body.uploads as { fileId: string; url: string; headers: Record<string, string> }[];
    for (const u of uploads) expect((await fetch(u.url, { method: "PUT", headers: u.headers, body: Buffer.from("data") })).status).toBe(200);

    let reconciling = true;
    const passes: unknown[] = [];
    const reconcile = (async () => {
      while (reconciling) passes.push((await adminDb().query("select app.reconcile_storage_usage(100000) as r")).rows[0].r);
    })();
    const completions = await Promise.all(
      uploads.map((u) => a.call("POST", `/api/v1/shares/${init.body.share.id}/files/${u.fileId}/complete`, {})),
    );
    reconciling = false;
    await reconcile;
    expect(completions.every((c) => c.status === 200)).toBe(true);
    expect(passes.length).toBeGreaterThan(1);
    const usage = await adminDb().query("select bytes_committed, bytes_reserved, files_committed from app.storage_usage where subject_id = $1", [a.userId]);
    expect(usage.rows[0]).toEqual({ bytes_committed: "80", bytes_reserved: "0", files_committed: 20 });
    const corrections = await adminDb().query("select count(*)::int as n from app.audit_events where action = 'storage.drift_corrected' and target_id = $1", [a.userId]);
    expect(corrections.rows[0].n).toBe(0);
    // A last pass agrees with the counters the uploads left.
    await adminDb().query("select app.reconcile_storage_usage(100000)");
    expect((await adminDb().query("select bytes_committed from app.storage_usage where subject_id = $1", [a.userId])).rows[0].bytes_committed).toBe("80");
  });
});

describe("jobs are not reachable from the API", () => {
  it("no route runs a job, and the app role can't", async () => {
    expect((await api("POST", "/api/v1/jobs/purge-tombstones", { body: {} })).status).toBe(404);
    const { rows } = await adminDb().query(
      "select has_function_privilege('app_server', 'app.run_job(text)', 'EXECUTE') as run, has_function_privilege('app_server', 'app.cleanup_anonymous_users(integer)', 'EXECUTE') as cleanup",
    );
    expect(rows[0]).toEqual({ run: false, cleanup: false });
  });
});
