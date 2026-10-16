import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LOCAL } from "../../scripts/local-stack.cjs";
import { adminDb, api, closeAdminDb, Device, newNetwork, setFlag, stack } from "./support/api";
import { startFaultProxy, type FaultProxy } from "./support/fault-proxy";
import { drainJanitor, outboxFor, runNodeJanitor, sdkStorage, setCronJobActive, triggerJanitor } from "./support/janitor";

/**
 * The storage janitor against the local stack (phase 3 §17.5, §17.15): guard rails (T-043),
 * reconciliation (T-044, T3-08), storage failures and backoff (T3-02, T3-03, T3-06), a crashed
 * run (T3-04), the janitor stopped (T3-05), dry run, legal hold (D-2) and its copies out of the R2
 * lifecycle rules' reach (RISK-031), and the function's database role (C-4). Deterministic runs use
 * the core in this process (runNodeJanitor) with the cron trigger paused; the end-to-end ones use
 * the real Edge Function (drainJanitor, triggerJanitor).
 */

let s3: S3Client;
beforeAll(() => {
  const { endpoint, accessKeyId, secretAccessKey } = stack().storage;
  s3 = new S3Client({ region: "auto", endpoint, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
});
afterAll(closeAdminDb);

const bucket = () => stack().storage.bucket;

async function stored(key: string): Promise<{ size: number; tombstone: boolean } | null> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { size: head.ContentLength ?? -1, tombstone: head.Metadata?.tombstone === "1" };
  } catch {
    return null;
  }
}

async function bytes(key: string): Promise<Uint8Array | null> {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    return (await object.Body?.transformToByteArray()) ?? null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function keyOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname).split("/").slice(2).join("/");
}

/** A deleted file share whose object is due for deletion now (no live upload URL, so no tombstone). */
async function dueDeletion(hold = false) {
  const a = await Device.create(newNetwork().ip());
  const { init, upload } = await a.uploadFile("j.txt", new TextEncoder().encode("janitor"), "text/plain");
  const key = keyOf(upload.url);
  if (!hold) await adminDb().query("update app.files set upload_url_expires_at = now() - interval '10 minutes' where id = $1", [upload.fileId]);
  expect((await a.call("DELETE", `/api/v1/shares/${init.body.share.id}`)).status).toBe(204);
  return { device: a, shareId: init.body.share.id as string, fileId: upload.fileId, key };
}

/** For deterministic runs in this process: stop pg_cron from triggering the Edge Function meanwhile. */
function withoutCronTrigger() {
  beforeAll(() => setCronJobActive("trigger-storage-janitor", false));
  afterAll(() => setCronJobActive("trigger-storage-janitor", true));
}

describe("guard rails (T-043)", () => {
  it("the Edge Function refuses an injected outbox row for an active share's object: parked, never deleted", async () => {
    const a = await Device.create(newNetwork().ip());
    const { upload } = await a.uploadFile("live.txt", new TextEncoder().encode("live"), "text/plain");
    const key = keyOf(upload.url);
    await adminDb().query("insert into app.object_deletions (object_key, reason, source_file_id) values ($1, 'share_ended', $2)", [key, upload.fileId]);
    try {
      expect(await drainJanitor(async () => (await outboxFor(key))?.last_error === "guard:share_open")).toBe(true);
      const row = await outboxFor(key);
      expect(row?.completed_at).toBeNull();
      expect(row!.not_before.getTime() - Date.now()).toBeGreaterThan(23 * 3600_000);
      expect(await stored(key)).toEqual({ size: 4, tombstone: false });
      expect((await a.call("POST", `/api/v1/files/${upload.fileId}/download-url`, {})).status).toBe(200);
      // An operator sees it on the health check (and must investigate, janitor runbook).
      expect((await api("GET", "/api/v1/health/cron")).body.checks.janitorFailures).toBe("guard_refused");
    } finally {
      await adminDb().query("delete from app.object_deletions where object_key = $1 and completed_at is null", [key]);
    }
  });

  it("the janitor role can't touch tables or call anything but its own functions", async () => {
    const role = new pg.Client({ connectionString: LOCAL.janitorDatabaseUrl });
    await role.connect();
    try {
      await expect(role.query("delete from app.object_deletions")).rejects.toThrow(/permission denied/);
      await expect(role.query("select count(*) from app.shares")).rejects.toThrow(/permission denied/);
      await expect(role.query("select app.end_share(gen_random_uuid(), 'expired')")).rejects.toThrow(/permission denied/);
      await expect(role.query("select app.trigger_storage_janitor('delete')")).rejects.toThrow(/permission denied/);
      await expect(role.query("select * from app.janitor_claim_deletions(1000)")).rejects.toThrow(/1 to 500/);
    } finally {
      await role.end();
    }
  });
});

describe("storage failures (T3-02, T3-03, T3-06)", () => {
  withoutCronTrigger();
  let proxy: FaultProxy;
  beforeAll(async () => {
    proxy = await startFaultProxy();
  });
  afterAll(() => proxy.close());

  it("an R2 error backs off and is retried until it succeeds; the object stays unreachable meanwhile", async () => {
    const { device, fileId, key } = await dueDeletion();
    proxy.fail({ method: "DELETE", times: 1, kind: 503 });
    await runNodeJanitor("delete", { storage: sdkStorage(proxy.endpoint) });
    let row = await outboxFor(key);
    expect(row).toMatchObject({ attempts: 1, completed_at: null });
    expect(row?.last_error).toMatch(/^s3:503/);
    expect(row!.not_before.getTime() - Date.now()).toBeGreaterThan(50_000); // first backoff: 1 minute
    expect(await stored(key)).not.toBeNull();
    expect((await device.call("POST", `/api/v1/files/${fileId}/download-url`, {})).status).toBe(404);

    // A dropped connection counts the same way.
    await adminDb().query("update app.object_deletions set not_before = now() where id = $1", [row!.id]);
    proxy.fail({ method: "DELETE", times: 1, kind: "drop" });
    await runNodeJanitor("delete", { storage: sdkStorage(proxy.endpoint) });
    row = await outboxFor(key);
    expect(row?.attempts).toBe(2);
    expect(row!.not_before.getTime() - Date.now()).toBeGreaterThan(4 * 60_000); // second backoff: 5 minutes

    await adminDb().query("update app.object_deletions set not_before = now() where id = $1", [row!.id]);
    await runNodeJanitor("delete", { storage: sdkStorage(proxy.endpoint) });
    expect((await outboxFor(key))?.completed_at).not.toBeNull();
    expect(await stored(key)).toBeNull();
    expect(proxy.seen).toEqual(expect.arrayContaining(["DELETE 503", "DELETE DROP", "DELETE 204"]));
  });

  it("a failed tombstone write leaves the row open and retried, never completed", async () => {
    const { key } = await dueDeletion(true);
    proxy.fail({ method: "PUT", times: 1, kind: 500 });
    await runNodeJanitor("delete", { storage: sdkStorage(proxy.endpoint) });
    let row = await outboxFor(key);
    expect(row).toMatchObject({ attempts: 1, tombstoned_at: null, completed_at: null });
    expect(await stored(key)).toMatchObject({ tombstone: false });
    await adminDb().query("update app.object_deletions set not_before = now() where id = $1", [row!.id]);
    await runNodeJanitor("delete", { storage: sdkStorage(proxy.endpoint) });
    row = await outboxFor(key);
    expect(row?.tombstoned_at).not.toBeNull();
    expect(row?.completed_at).toBeNull();
    expect(await stored(key)).toEqual({ size: 0, tombstone: true });
  });

  it("five failures in a row: janitor.failing is logged and /health/cron answers 503 (T3-06)", async () => {
    const { key } = await dueDeletion();
    let logs: Awaited<ReturnType<typeof runNodeJanitor>> = [];
    try {
      for (let i = 0; i < 5; i++) {
        await adminDb().query("update app.object_deletions set not_before = now() where object_key = $1 and completed_at is null", [key]);
        proxy.fail({ method: "DELETE", times: 1, kind: 503 });
        logs = await runNodeJanitor("delete", { storage: sdkStorage(proxy.endpoint) });
      }
      expect((await outboxFor(key))?.attempts).toBe(5);
      expect(logs.find((l) => l.event === "janitor.failing")).toMatchObject({ level: "error", fields: { attempts: 5 } });
      expect(JSON.stringify(logs)).not.toContain(key);
      const health = await api("GET", "/api/v1/health/cron");
      expect(health.status).toBe(503);
      expect(health.body.checks.janitorFailures).toBe("failing");
    } finally {
      await adminDb().query("update app.object_deletions set not_before = now() where object_key = $1 and completed_at is null", [key]);
      await runNodeJanitor("delete");
    }
    expect((await outboxFor(key))?.completed_at).not.toBeNull();
  });
});

describe("runs that stop part-way (T3-04, T3-05) and dry run", () => {
  withoutCronTrigger();

  it("a janitor that dies after claiming leaves its rows locked for 2 minutes; the next run then takes them", async () => {
    const { key } = await dueDeletion();
    const role = new pg.Client({ connectionString: LOCAL.janitorDatabaseUrl });
    await role.connect();
    try {
      const claimed = await role.query("select id from app.janitor_claim_deletions(500)");
      expect(claimed.rows.length).toBeGreaterThan(0);
    } finally {
      await role.end(); // dies without finishing anything
    }
    await runNodeJanitor("delete");
    expect((await outboxFor(key))?.completed_at).toBeNull(); // still locked: nobody takes it over mid-batch
    await adminDb().query("update app.object_deletions set locked_until = now() - interval '1 second' where object_key = $1", [key]);
    await runNodeJanitor("delete");
    expect((await outboxFor(key))?.completed_at).not.toBeNull();
    expect(await stored(key)).toBeNull();
  });

  it("with the janitor switched off, access is still denied and the bytes wait; switched on, they go (T3-05)", async () => {
    await setFlag("storage_janitor_enabled", false);
    let pending: Awaited<ReturnType<typeof dueDeletion>>;
    try {
      pending = await dueDeletion();
      const logs = await runNodeJanitor("delete");
      expect(logs.map((l) => l.event)).toContain("janitor.disabled");
      expect(await triggerJanitor()).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(await stored(pending.key)).not.toBeNull();
      expect((await outboxFor(pending.key))?.completed_at).toBeNull();
      expect((await pending.device.call("GET", `/api/v1/shares/${pending.shareId}`)).status).toBe(404);
      expect((await pending.device.call("POST", `/api/v1/files/${pending.fileId}/download-url`, {})).status).toBe(404);
      const trigger = await adminDb().query("select app.trigger_storage_janitor('delete') as r");
      expect(trigger.rows[0].r).toEqual({ posted: false, reason: "disabled" });
    } finally {
      await setFlag("storage_janitor_enabled", true);
    }
    await runNodeJanitor("delete");
    expect(await stored(pending!.key)).toBeNull();
  });

  it("dry run claims and logs, then releases the rows without touching storage", async () => {
    const { key } = await dueDeletion();
    const logs = await runNodeJanitor("delete", { dryRun: true });
    expect(logs.some((l) => l.event === "janitor.would_delete")).toBe(true);
    const row = await outboxFor(key);
    expect(row).toMatchObject({ completed_at: null, locked_until: null, attempts: 0 });
    expect(await stored(key)).not.toBeNull();
    await runNodeJanitor("delete");
    expect(await stored(key)).toBeNull();
  });
});

describe("legal hold (D-2)", () => {
  it("a takedown holds the objects: the janitor leaves them until an operator releases the hold", async () => {
    const a = await Device.create(newNetwork().ip());
    const { init, upload } = await a.uploadFile("evidence.txt", new TextEncoder().encode("evidence"), "text/plain");
    const key = keyOf(upload.url);
    await adminDb().query("update app.files set upload_url_expires_at = now() - interval '10 minutes' where id = $1", [upload.fileId]);
    const block = await adminDb().query("select app.admin_block_share($1, 'csam report', 'Op One') as r", [init.body.share.id]);
    expect(block.rows[0].r.objects).toEqual([expect.objectContaining({ objectKey: key, legalHold: true })]);
    expect((await a.call("GET", `/api/v1/shares/${init.body.share.id}`)).status).toBe(404);

    await triggerJanitor();
    await runNodeJanitor("delete");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await stored(key)).toEqual({ size: 8, tombstone: false });
    expect(await outboxFor(key)).toMatchObject({ legal_hold: true, hold_reason: "takedown", completed_at: null });
    expect((await api("GET", "/api/v1/health/cron")).body.checks.janitorBacklog).not.toBe("backlog");

    await adminDb().query("select app.admin_release_hold($1, 'legal review: delete', 'Op One')", [init.body.share.id]);
    expect(await drainJanitor(async () => (await stored(key)) === null)).toBe(true);
  });

  it("the Edge Function copies a held object to hold/; it outlives the lifecycle backstop until release, then both go (RISK-031)", async () => {
    const a = await Device.create(newNetwork().ip());
    const content = new TextEncoder().encode(`evidence ${randomUUID()}`);
    const { init, upload } = await a.uploadFile("evidence.bin", content, "application/octet-stream");
    const key = keyOf(upload.url);
    const copy = `hold/${key}`;
    const shareId = init.body.share.id as string;
    await adminDb().query("update app.files set upload_url_expires_at = now() - interval '10 minutes' where id = $1", [upload.fileId]);
    await adminDb().query("select app.admin_block_share($1, 'csam report', 'Op One')", [shareId]);

    expect(await drainJanitor(async () => (await outboxFor(key))?.hold_copy === "copied")).toBe(true);
    expect(await bytes(copy)).toEqual(content);
    expect(await outboxFor(key)).toMatchObject({ legal_hold: true, completed_at: null, attempts: 0 });

    // R2's d7/ rule deletes the original 8 days after upload whatever the database says. Do what it does.
    await s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
    expect(await triggerJanitor()).toBe(202);
    await sleep(1500);
    expect(await bytes(copy)).toEqual(content);
    expect(await outboxFor(key)).toMatchObject({ legal_hold: true, hold_copy: "copied", completed_at: null });
    // Nothing a user can reach points at the copy.
    expect((await adminDb().query("select count(*)::int as n from app.files where object_key like 'hold/%'")).rows[0].n).toBe(0);

    await adminDb().query("select app.admin_release_hold($1, 'legal review: delete', 'Op One')", [shareId]);
    expect(await drainJanitor(async () => (await outboxFor(key))?.completed_at !== null)).toBe(true);
    expect(await stored(copy)).toBeNull();
    expect(await stored(key)).toBeNull();
  });

  it("a held object already gone before its copy is recorded as unavailable, and reported", async () => {
    const a = await Device.create(newNetwork().ip());
    const { init, upload } = await a.uploadFile("gone.txt", new TextEncoder().encode("gone"), "text/plain");
    const key = keyOf(upload.url);
    await adminDb().query("update app.files set upload_url_expires_at = now() - interval '10 minutes' where id = $1", [upload.fileId]);
    await s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
    await adminDb().query("select app.admin_block_share($1, 'report', 'Op One')", [init.body.share.id]);

    expect(await drainJanitor(async () => (await outboxFor(key))?.hold_copy === "unavailable")).toBe(true);
    expect(await outboxFor(key)).toMatchObject({ legal_hold: true, last_error: "hold:source_missing", completed_at: null });
    expect(await stored(`hold/${key}`)).toBeNull();
    await adminDb().query("select app.admin_release_hold($1, 'test cleanup', 'Op One')", [init.body.share.id]);
    expect(await drainJanitor(async () => (await outboxFor(key))?.completed_at !== null)).toBe(true);
  });
});

describe("the Edge Function's database role (C-4, RISK-036)", () => {
  it("works only through app_janitor: with that role unable to connect nothing happens; restored, the row goes", async () => {
    // Supabase injects SUPABASE_DB_URL (the postgres role) into the function too. If the function
    // used it, blocking app_janitor would change nothing.
    const { key } = await dueDeletion();
    await adminDb().query("alter role app_janitor connection limit 0");
    try {
      expect(await triggerJanitor()).toBe(202);
      await sleep(3000);
      expect(await outboxFor(key)).toMatchObject({ completed_at: null, attempts: 0 });
      expect(await stored(key)).not.toBeNull();
    } finally {
      await adminDb().query("alter role app_janitor connection limit -1");
    }
    expect(await drainJanitor(async () => (await outboxFor(key))?.completed_at !== null)).toBe(true);
    expect(await stored(key)).toBeNull();
  });
});

describe("reconciliation (T-044, T3-08, T3-09)", () => {
  withoutCronTrigger();
  const put = (key: string, body = "x") => s3.send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body }));

  const closeRuns = () => adminDb().query("update app.storage_reconcile_runs set status = 'finished', finished_at = now() where status = 'running'");
  beforeEach(closeRuns);
  afterEach(closeRuns);

  it("queues old orphans, keeps young ones and live files, reports unknown keys and resumes across invocations", async () => {
    const day = "2026/09/01";
    const orphanOld = `d30/${day}/${randomUUID()}`;
    const orphanYoung = `d30/${day}/${randomUUID()}`;
    const unknown = `zz-notes/${randomUUID()}.txt`;
    await Promise.all([put(orphanOld), put(orphanYoung), put(unknown)]);
    const a = await Device.create(newNetwork().ip());
    const live = keyOf((await a.uploadFile("live.txt", new TextEncoder().encode("live"), "text/plain")).upload.url);

    // Only these keys are listed, two per page, and the old ones look 3 days old. The run "began"
    // in 2000, so no other file's missing object is in play (that is the next test).
    const fixtures = [orphanOld, orphanYoung, unknown, live].sort();
    const real = sdkStorage();
    const storage = {
      ...real,
      async listObjects(startAfter: string | null) {
        const keys = fixtures.filter((k) => startAfter === null || k > startAfter);
        return {
          truncated: keys.length > 2,
          keys: keys.slice(0, 2).map((key) => ({
            key,
            lastModified: key === orphanYoung ? new Date() : new Date(Date.now() - 3 * 86_400_000),
          })),
        };
      },
    };
    const { rows } = await adminDb().query("insert into app.storage_reconcile_runs (started_at) values ('2000-01-01') returning id");
    const runId = rows[0].id as string;

    // One page per invocation: the cursor is saved, and the next invocation continues from it (T3-09).
    await runNodeJanitor("reconcile", { storage, overrides: { maxPages: 1 } });
    let run = (await adminDb().query("select status, last_key, counts from app.storage_reconcile_runs where id = $1", [runId])).rows[0];
    expect(run.status).toBe("running");
    expect(run.last_key).toBe(fixtures[1]);
    await runNodeJanitor("reconcile", { storage, overrides: { maxPages: 1 } });
    run = (await adminDb().query("select status, counts from app.storage_reconcile_runs where id = $1", [runId])).rows[0];
    expect(run.status).toBe("finished");
    expect(run.counts).toMatchObject({ listed: 4, orphansQueued: 1, unknownKeys: 1, pages: 2 });

    expect(await outboxFor(orphanOld)).toMatchObject({ reason: "orphan", completed_at: null });
    expect(await outboxFor(orphanYoung)).toBeUndefined();
    expect(await outboxFor(live)).toBeUndefined();
    expect(await outboxFor(unknown)).toBeUndefined();

    // Queued orphans go through the normal janitor path, with every guard rail.
    await runNodeJanitor("delete");
    expect(await stored(orphanOld)).toBeNull();
    expect(await stored(orphanYoung)).not.toBeNull();
    expect(await stored(live)).not.toBeNull();
    expect(await stored(unknown)).not.toBeNull();
    await Promise.all([orphanYoung, unknown].map((Key) => s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key }))));
  });

  it("the Edge Function reconciles the real bucket and marks a verified file whose object is gone (T3-08)", async () => {
    const a = await Device.create(newNetwork().ip());
    const { upload } = await a.uploadFile("lost.txt", new TextEncoder().encode("lost"), "text/plain");
    const lost = keyOf(upload.url);
    await s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: lost }));
    await adminDb().query("update app.files set verified_at = now() - interval '2 hours' where id = $1", [upload.fileId]);
    const { rows } = await adminDb().query("insert into app.storage_reconcile_runs default values returning id");
    const runId = rows[0].id as string;

    const finished = await drainJanitor(
      async () => (await adminDb().query("select status from app.storage_reconcile_runs where id = $1", [runId])).rows[0].status === "finished",
      { mode: "reconcile", timeoutMs: 90_000 },
    );
    expect(finished).toBe(true);
    const file = await adminDb().query("select object_missing_at from app.files where id = $1", [upload.fileId]);
    expect(file.rows[0].object_missing_at).not.toBeNull();
    const run = (await adminDb().query("select counts from app.storage_reconcile_runs where id = $1", [runId])).rows[0];
    expect(run.counts.missingObjects).toBeGreaterThanOrEqual(1);
    expect(run.counts.listed).toBeGreaterThan(0);
    expect(run.counts).toHaveProperty("multipartInProgress");
  });
});
