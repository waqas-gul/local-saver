import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { adminDb, api, closeAdminDb, Device, newNetwork, stack, turnstilePass, Viewer } from "./support/api";

/**
 * Abuse reports and takedown (03 §7.6, T-036): anyone who can see a share may report it, with
 * Turnstile; an operator blocks the share or one link with the SQL functions (runbooks/takedown.md);
 * the share, its links and its local visibility end at once, its objects are queued for
 * deletion and everything is audited.
 */

afterAll(closeAdminDb);

async function sharedByLink(content = "something reportable") {
  const home = newNetwork();
  const creator = await Device.create(home.ip());
  const share = await creator.postText(content);
  const link = await creator.createLink(share.id, { shortCode: {} });
  const viewer = new Viewer();
  expect((await viewer.unlock(link.id, link.secret)).status).toBe(200);
  return { home, creator, share, link, viewer };
}

const report = (target: object, extra: object = {}) => ({ target, category: "phishing", turnstileToken: turnstilePass(), ...extra });

describe("reports (T-036, report intake)", () => {
  it("a link viewer reports the link's share: stored, audited and logged as a structured event", async () => {
    const { share, link, viewer } = await sharedByLink();
    const response = await viewer.call("POST", "/api/v1/reports", report({ type: "link", linkId: link.id }, {
      details: "asks for my bank password",
      email: "Reporter@Example.org",
    }));
    expect(response.status).toBe(201);
    const id = response.body.report.id;
    const { rows } = await adminDb().query("select * from app.abuse_reports where id = $1", [id]);
    expect(rows[0]).toMatchObject({
      link_id: link.id,
      share_id: share.id,
      category: "phishing",
      reporter_kind: "link_viewer",
      reporter_user_id: null,
      status: "open",
      details: "asks for my bank password",
    });
    const audit = await adminDb().query("select actor_kind from app.audit_events where action = 'report.created' and target_id = $1", [id]);
    expect(audit.rows).toEqual([{ actor_kind: "link_viewer" }]);
    // The structured log event a future operator alert will watch, with IDs only (08 §8, Q-022).
    await new Promise((resolve) => setTimeout(resolve, 200));
    const log = readFileSync(stack().serverLog, "utf8");
    const line = log.split("\n").find((l) => l.includes("abuse.report_received") && l.includes(id));
    expect(line).toBeDefined();
    expect(line).not.toContain("bank password");
    expect(line).not.toContain("Example.org");
  });

  it("a device on the share's network reports it; other networks, other links and no session can't", async () => {
    const { home, share, link } = await sharedByLink();
    const neighbour = await Device.create(home.ip());
    expect((await neighbour.call("POST", "/api/v1/reports", report({ type: "share", shareId: share.id }))).status).toBe(201);

    const stranger = await Device.create(newNetwork().ip());
    expect((await stranger.call("POST", "/api/v1/reports", report({ type: "share", shareId: share.id }))).status).toBe(404);
    expect((await new Viewer().call("POST", "/api/v1/reports", report({ type: "link", linkId: link.id }))).status).toBe(404);
    expect((await api("POST", "/api/v1/reports", { body: report({ type: "share", shareId: share.id }) })).status).toBe(401);
  });

  it("requires a Turnstile token, a category, and details for 'other'", async () => {
    const { link, viewer } = await sharedByLink();
    const target = { type: "link", linkId: link.id };
    const noToken = await viewer.call("POST", "/api/v1/reports", { target, category: "spam" });
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe("TURNSTILE_REQUIRED");
    for (const body of [
      { target, turnstileToken: turnstilePass() },
      { target, category: "boring", turnstileToken: turnstilePass() },
      { target, category: "other", details: "short", turnstileToken: turnstilePass() },
      { target, category: "spam", details: "x".repeat(2001), turnstileToken: turnstilePass() },
      { target, category: "spam", email: "not-an-email", turnstileToken: turnstilePass() },
      { target, category: "spam", turnstileToken: turnstilePass(), networkSpaceId: "anything" },
    ]) {
      const response = await viewer.call("POST", "/api/v1/reports", body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(response.text).not.toContain("x".repeat(50));
    }
    const other = await viewer.call("POST", "/api/v1/reports", { target, category: "other", details: "Something else is wrong here", turnstileToken: turnstilePass() });
    expect(other.status).toBe(201);
  });

  it("limits reports per reporter (429)", { timeout: 60_000 }, async () => {
    const { link, viewer } = await sharedByLink();
    for (let i = 0; i < 10; i++) {
      viewer.ip = newNetwork().ip();
      expect((await viewer.call("POST", "/api/v1/reports", report({ type: "link", linkId: link.id }))).status).toBe(201);
    }
    viewer.ip = newNetwork().ip();
    const limited = await viewer.call("POST", "/api/v1/reports", report({ type: "link", linkId: link.id }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("takedown by SQL function (T-036, runbooks/takedown.md)", () => {
  it("blocking a share ends every way in, queues its objects and audits the operator", async () => {
    const home = newNetwork();
    const creator = await Device.create(home.ip());
    const neighbour = await Device.create(home.ip());
    const file = await creator.uploadFile("bad.txt", Buffer.from("bad bytes"), "text/plain");
    const shareId = file.init.body.share.id as string;
    const link = await creator.createLink(shareId, { shortCode: {} });
    const viewer = new Viewer();
    await viewer.unlock(link.id, link.secret);
    const filed = await viewer.call("POST", "/api/v1/reports", report({ type: "link", linkId: link.id }, { category: "malware" }));

    const { rows } = await adminDb().query("select app.admin_block_share($1, $2, $3, $4) as result", [
      shareId, "malware reported and confirmed", "ops-test", filed.body.report.id,
    ]);
    expect(rows[0].result).toMatchObject({ status: "blocked", endedNow: true, reportsResolved: 1 });
    expect(rows[0].result.objects.map((o: { objectKey: string }) => o.objectKey)).toHaveLength(1);

    expect((await viewer.content(link.id)).status).toBe(410);
    expect((await viewer.fileUrl(link.id, file.upload.fileId)).status).toBe(410);
    expect((await new Viewer().unlock(link.id, link.secret)).status).toBe(410);
    expect((await new Viewer().resolve(link.shortCode!.code)).status).toBe(404);
    expect(await neighbour.feedIds()).not.toContain(shareId);
    expect((await neighbour.call("GET", `/api/v1/shares/${shareId}`)).status).toBe(404);
    expect(await creator.myShareIds()).not.toContain(shareId);

    const queued = await adminDb().query(
      "select count(*)::int as n from app.object_deletions od join app.files f on f.id = od.source_file_id where f.share_id = $1",
      [shareId],
    );
    expect(queued.rows[0].n).toBe(1);
    const audit = await adminDb().query("select actor_kind, metadata from app.audit_events where action = 'admin.block' and target_id = $1", [shareId]);
    expect(audit.rows[0]).toMatchObject({ actor_kind: "operator", metadata: { operator: "ops-test", reason: "malware reported and confirmed" } });
    const resolved = await adminDb().query("select status, resolved_by from app.abuse_reports where id = $1", [filed.body.report.id]);
    expect(resolved.rows[0]).toEqual({ status: "actioned", resolved_by: "ops-test" });
  });

  it("blocking one link leaves the share and its other links working", async () => {
    const { creator, share, link, viewer } = await sharedByLink();
    const second = await creator.createLink(share.id);
    await adminDb().query("select app.admin_block_link($1, 'phishing link', 'ops-test')", [link.id]);
    expect((await viewer.content(link.id)).status).toBe(410);
    expect((await new Viewer().unlock(second.id, second.secret)).status).toBe(200);
    expect(await creator.myShareIds()).toContain(share.id);
  });

  it("the app's own database role can't run a takedown", async () => {
    const { share } = await sharedByLink();
    const { LOCAL } = await import("../../scripts/local-stack.cjs");
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: LOCAL.appServerDatabaseUrl, max: 1 });
    try {
      await expect(pool.query("select app.admin_block_share($1, 'x', 'y')", [share.id])).rejects.toThrow(/permission denied/);
    } finally {
      await pool.end();
    }
  });
});
