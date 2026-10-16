import { afterAll, describe, expect, it } from "vitest";
import { adminDb, api, closeAdminDb, Device, newNetwork, setFlag } from "./support/api";
import { setCronJobActive } from "./support/janitor";

/**
 * GET /api/v1/health/cron (phase 3 §17.12, D-5) and the cron-failure test (T3-07): with pg_cron
 * stopped, access stays denied through request-time checks, and the health check fails once the
 * heartbeat is stale, which is what an external uptime monitor alerts on.
 */

afterAll(closeAdminDb);

const PHASE_JOBS = ["expire-shares", "finalize-burn-claims", "trigger-storage-janitor", "cron-heartbeat", "fail-stale-uploads"];

describe("GET /api/v1/health/cron", () => {
  it("answers what app.cron_health says, 200 when ok and 503 when not, without caching or numbers", async () => {
    await adminDb().query("select app.run_job('cron-heartbeat')");
    const health = await api("GET", "/api/v1/health/cron");
    const expected = (await adminDb().query("select app.cron_health(false) as h")).rows[0].h;
    expect(health.body).toEqual(expected);
    expect(health.status).toBe(expected.status === "ok" ? 200 : 503);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(health.body.checks).sort()).toEqual(
      ["burnFinalize", "egressLists", "heartbeat", "janitorBacklog", "janitorFailures", "janitorVolume", "jobs", "reconcile", "storageDrift"],
    );
    expect(health.text).not.toMatch(/[0-9]/);
    // Not an egress-list deployment (APP_ENV=test): the lists aren't required here.
    expect(health.body.checks.egressLists).toBe("not_required");
  });

  it("fails with a stale heartbeat (pg_cron stopped) and recovers with the next one", async () => {
    await adminDb().query("update app.job_heartbeats set last_succeeded_at = now() - interval '11 minutes' where job = 'cron-heartbeat'");
    const stale = await api("GET", "/api/v1/health/cron");
    expect(stale.status).toBe(503);
    expect(stale.body).toMatchObject({ status: "degraded", checks: { heartbeat: "stale" } });
    await adminDb().query("select app.run_job('cron-heartbeat')");
    expect((await api("GET", "/api/v1/health/cron")).body.checks.heartbeat).toBe("ok");
  });

  it("reports a job whose last run failed", async () => {
    await adminDb().query("select app.record_job_run('purge-tombstones', false, '{}', 'XX000 test failure')");
    try {
      const health = await api("GET", "/api/v1/health/cron");
      expect(health.status).toBe(503);
      expect(health.body.checks.jobs).toBe("failing");
      expect(health.text).not.toContain("test failure");
    } finally {
      await adminDb().query("select app.record_job_run('purge-tombstones', true, '{}')");
    }
  });
});

describe("pg_cron stopped (T3-07)", () => {
  it("access stays denied for expired and past-grace shares while no job runs", async () => {
    await setFlag("free_burn_after_download", true);
    for (const job of PHASE_JOBS) await setCronJobActive(job, false);
    try {
      const net = newNetwork();
      const a = await Device.create(net.ip());
      const b = await Device.create(net.ip());
      const expired = await a.postText("expires");
      await adminDb().query("update app.shares set expires_at = now() - interval '1 second' where id = $1", [expired.id]);
      const burn = await a.postBurnText("burns");
      expect((await b.call("POST", `/api/v1/shares/${burn.id}/reveal`, { confirm: true })).status).toBe(200);
      await adminDb().query(
        "update app.shares set claimed_at = now() - interval '1 hour', claim_grace_until = now() - interval '1 second' where id = $1",
        [burn.id],
      );

      expect((await b.call("GET", `/api/v1/shares/${expired.id}`)).status).toBe(404);
      expect(await b.feedIds()).not.toContain(expired.id);
      expect((await b.call("POST", `/api/v1/shares/${burn.id}/reveal`, { confirm: true })).status).toBe(410);
      // The rows are still "open": no job has ended them.
      const rows = await adminDb().query("select id, status from app.shares where id = any($1) order by status", [[expired.id, burn.id]]);
      expect(rows.rows.map((r) => r.status).sort()).toEqual(["active", "claimed"]);

      // Ten minutes without a heartbeat: the monitor's check fails.
      await adminDb().query("update app.job_heartbeats set last_succeeded_at = now() - interval '11 minutes' where job = 'cron-heartbeat'");
      expect((await api("GET", "/api/v1/health/cron")).status).toBe(503);
      expect((await adminDb().query("select app.cron_health(false) -> 'checks' ->> 'burnFinalize' as c")).rows[0].c).toBe("ok");
      await adminDb().query("update app.shares set claim_grace_until = now() - interval '11 minutes', claimed_at = now() - interval '1 hour' where id = $1", [burn.id]);
      expect((await adminDb().query("select app.cron_health(false) -> 'checks' ->> 'burnFinalize' as c")).rows[0].c).toBe("late");
    } finally {
      for (const job of PHASE_JOBS) await setCronJobActive(job, true);
      await adminDb().query("select app.run_job('cron-heartbeat')");
      await adminDb().query("select app.run_job('finalize-burn-claims')");
      await setFlag("free_burn_after_download", false);
    }
  });
});
