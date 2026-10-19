import { createHash, randomBytes } from "node:crypto";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminDb, closeAdminDb, Device, newNetwork, stack, Viewer } from "./support/api";
import { accountDevice, DAY, proDevice, setCounter } from "./support/entitlements";
import { startFaultProxy, type FaultProxy } from "./support/fault-proxy";
import { drainJanitor, runNodeJanitor, sdkStorage, setCronJobActive } from "./support/janitor";
import { all, BIG, complete, expectedSha256, objectSha256, s3, startBig, uploadParts } from "./support/multipart";

/**
 * Expiry of 30 and 90 days and extend (phase 4 §17.8.2, P4-15, T4-X1 … T4-X6) against the real server, RustFS
 * standing in for R2 (P4-00 checked CopyObject: stored headers kept, a 5 GiB object in one request) and the
 * real storage-janitor Edge Function, which alone copies and deletes objects (D-1). Deterministic failure
 * runs use the same janitor core in this process behind a fault proxy, with the cron trigger paused.
 */

afterAll(closeAdminDb);

const HOUR = 3600;

type Stored = { fileId: string; key: string; bytes: Buffer };
type Uploaded = { shareId: string; files: Stored[] };

async function keyOf(fileId: string): Promise<string> {
  return (await adminDb().query("select object_key from app.files where id = $1", [fileId])).rows[0].object_key as string;
}

/** A completed share of `count` small files (single PUTs). */
async function upload(device: Device, count = 1, extra: Record<string, unknown> = {}): Promise<Uploaded> {
  const contents = Array.from({ length: count }, (_, i) => randomBytes(2048 + i));
  const init = await device.call("POST", "/api/v1/shares", {
    destination: "network",
    ...extra,
    files: contents.map((c, i) => ({ name: `f${i}.bin`, size: c.length, type: "application/octet-stream" })),
  });
  if (init.status !== 201) throw new Error(`init: ${init.status} ${init.text}`);
  const shareId = init.body.share.id as string;
  const files: Stored[] = [];
  for (const [i, target] of (init.body.uploads as { fileId: string; url: string; headers: Record<string, string> }[]).entries()) {
    const put = await fetch(target.url, { method: "PUT", headers: target.headers, body: contents[i] });
    if (!put.ok) throw new Error(`PUT: ${put.status}`);
    const done = await device.call("POST", `/api/v1/shares/${shareId}/files/${target.fileId}/complete`, {});
    if (done.status !== 200) throw new Error(`complete: ${done.status} ${done.text}`);
    files.push({ fileId: target.fileId, key: await keyOf(target.fileId), bytes: contents[i] as Buffer });
  }
  return { shareId, files };
}

const extend = (device: Device, shareId: string, expiresIn: unknown) => device.call("POST", `/api/v1/shares/${shareId}/extend`, { expiresIn });

async function dbNow(): Promise<number> {
  return ((await adminDb().query("select now() as now")).rows[0].now as Date).getTime();
}

async function share(shareId: string) {
  const { rows } = await adminDb().query(
    "select status, expires_at, retention_class, extension_pending, extension_failed_at from app.shares where id = $1",
    [shareId],
  );
  return rows[0] as { status: string; expires_at: Date; retention_class: string; extension_pending: boolean; extension_failed_at: Date | null } | undefined;
}

async function rows(shareId: string) {
  const { rows: found } = await adminDb().query(
    `select e.id, e.file_id, e.old_key, e.new_key, e.status, e.attempts, e.last_error, e.not_before, e.new_expires_at, e.new_retention_class
       from app.share_extension_files e where e.share_id = $1 order by e.id`,
    [shareId],
  );
  return found as {
    id: string;
    file_id: string;
    old_key: string;
    new_key: string;
    status: string;
    attempts: number;
    last_error: string | null;
    not_before: Date;
    new_expires_at: Date;
    new_retention_class: string;
  }[];
}

/** A single PUT's upload URL is live 15 minutes, and its copy waits for it: end that wait. */
async function expireUploadUrls(shareId: string, fileId?: string) {
  await adminDb().query(
    "update app.files set upload_url_expires_at = now() - interval '10 minutes' where share_id = $1 and ($2::uuid is null or id = $2)",
    [shareId, fileId ?? null],
  );
  await adminDb().query(
    "update app.share_extension_files set not_before = now() where share_id = $1 and status = 'pending' and ($2::uuid is null or file_id = $2)",
    [shareId, fileId ?? null],
  );
}

async function stored(key: string) {
  try {
    const head = await s3().send(new HeadObjectCommand({ Bucket: stack().storage.bucket, Key: key }));
    return { size: head.ContentLength, type: head.ContentType, disposition: head.ContentDisposition, cache: head.CacheControl };
  } catch {
    return null;
  }
}

async function outboxFor(key: string) {
  const { rows: found } = await adminDb().query(
    "select reason, source_file_id, not_before, completed_at, legal_hold, last_error from app.object_deletions where object_key = $1 order by id desc",
    [key],
  );
  return found as { reason: string; source_file_id: string | null; not_before: Date; completed_at: Date | null; legal_hold: boolean; last_error: string | null }[];
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function download(device: Device, fileId: string): Promise<{ url: string; bytes: Buffer }> {
  const issued = await device.call("POST", `/api/v1/files/${fileId}/download-url`, {});
  if (issued.status !== 200) throw new Error(`download-url: ${issued.status} ${issued.text}`);
  const response = await fetch(issued.body.url as string);
  if (!response.ok) throw new Error(`GET: ${response.status}`);
  return { url: issued.body.url as string, bytes: Buffer.from(await response.arrayBuffer()) };
}

const pathOf = (url: string) => decodeURIComponent(new URL(url).pathname).split("/").slice(2).join("/");

describe("30 and 90 days at creation (T4-X1, E5)", () => {
  it("Pro shares of 30 and 90 days get d30 and d90 keys; Free is refused 30 days with the Pro hint", async () => {
    const pro = await proDevice();
    const month = await upload(pro.device, 1, { expiresIn: 30 * DAY });
    const quarter = await upload(pro.device, 1, { expiresIn: 90 * DAY });
    expect(month.files[0]!.key).toMatch(/^d30\//);
    expect(quarter.files[0]!.key).toMatch(/^d90\//);
    expect((await share(quarter.shareId))!.expires_at.getTime() - (await dbNow())).toBeGreaterThan(90 * DAY * 1000 - 60_000);

    const free = await accountDevice();
    const refused = await free.device.call("POST", "/api/v1/shares", { destination: "network", expiresIn: 30 * DAY, files: [{ name: "a", size: 1, type: "text/plain" }] });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: "EXPIRY_NOT_ALLOWED", details: { requiredPlan: "pro" } });
  });
});

describe("extend in place (T4-X2)", () => {
  it("within the class from the upload date: the expiry and the links that follow it move, other links stay, nothing is copied", async () => {
    const pro = await proDevice();
    const { shareId, files } = await upload(pro.device, 1, { expiresIn: HOUR });
    const follows = await pro.device.createLink(shareId);
    const own = await pro.device.createLink(shareId);
    // A link with its own, shorter expiry (no option is shorter than the share's hour).
    await adminDb().query("update app.share_links set expires_at = now() + interval '30 minutes', follows_share_expiry = false where id = $1", [own.id]);

    const response = await extend(pro.device, shareId, DAY);
    expect(response.status).toBe(200);
    const now = await dbNow();
    expect(Math.abs(new Date(response.body.share.expiresAt).getTime() - (now + DAY * 1000))).toBeLessThan(10_000);
    expect(response.body.share.expiry).toEqual({ extendable: true, extensionPending: false, extensionFailed: false });
    expect(await keyOf(files[0]!.fileId)).toBe(files[0]!.key);
    expect(await rows(shareId)).toEqual([]);

    const links = (await pro.device.call("GET", `/api/v1/shares/${shareId}/links`)).body.links as { id: string; expiresAt: string; followsShareExpiry: boolean }[];
    const byId = Object.fromEntries(links.map((l) => [l.id, l]));
    expect(byId[follows.id]).toMatchObject({ followsShareExpiry: true, expiresAt: response.body.share.expiresAt });
    expect(byId[own.id]!.followsShareExpiry).toBe(false);
    expect(new Date(byId[own.id]!.expiresAt).getTime()).toBeLessThan(now + 31 * 60_000);

    const audit = await adminDb().query("select actor_kind, actor_device_id, metadata from app.audit_events where action = 'share.extended' and target_id = $1", [shareId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_kind: "device", actor_device_id: pro.device.deviceId, metadata: { mode: "in_place" } });
    expect(new Date(audit.rows[0].metadata.to as string).toISOString()).toBe(response.body.share.expiresAt);
  });

  it("a text has no object: it extends in place to 90 days", async () => {
    const pro = await proDevice();
    const text = await pro.device.postText("keep me", HOUR);
    const response = await extend(pro.device, text.id, 90 * DAY);
    expect(response.status).toBe(200);
    expect(new Date(response.body.share.expiresAt).getTime() - (await dbNow())).toBeGreaterThan(90 * DAY * 1000 - 60_000);
    expect(response.body.share.text.content).toBe("keep me");
  });
});

describe("extend by copy (T4-X3)", () => {
  it("a longer class: 202, downloads keep working from the old keys, the janitor copies and swaps, then deletes the old keys", async () => {
    const pro = await proDevice();
    const { shareId, files } = await upload(pro.device, 2, { expiresIn: DAY });
    const link = await pro.device.createLink(shareId);
    const viewer = new Viewer();
    expect((await viewer.unlock(link.id, link.secret)).status).toBe(200);
    const usageBefore = (await adminDb().query("select bytes_committed from app.storage_usage where subject_id = $1", [pro.userId])).rows[0].bytes_committed;
    const expiresBefore = (await share(shareId))!.expires_at.getTime();

    const response = await extend(pro.device, shareId, 30 * DAY);
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ extension: { status: "pending" } });
    const pending = await pro.device.call("GET", `/api/v1/shares/${shareId}`);
    expect(pending.body.share.expiry).toEqual({ extendable: false, extensionPending: true, extensionFailed: false });
    expect(new Date(pending.body.share.expiresAt).getTime()).toBe(expiresBefore);
    const queued = await rows(shareId);
    expect(queued.map((r) => [r.status, r.new_retention_class])).toEqual([["pending", "d30"], ["pending", "d30"]]);
    expect(queued.map((r) => r.old_key).sort()).toEqual(files.map((f) => f.key).sort());

    // The upload URLs (15 minutes) are still live: no copy yet, whatever the janitor does.
    expect(await drainJanitor(async () => (await rows(shareId)).some((r) => r.status !== "pending"), { timeoutMs: 3000 })).toBe(false);
    for (const r of queued) expect(r.not_before.getTime()).toBeGreaterThan((await dbNow()) + 14 * 60_000);
    await expireUploadUrls(shareId);

    // During the copy, downloads (and link viewers) use the old keys.
    const before = await download(pro.device, files[0]!.fileId);
    expect(pathOf(before.url)).toBe(files[0]!.key);
    expect(sha(before.bytes)).toBe(sha(files[0]!.bytes));

    expect(await drainJanitor(async () => (await share(shareId))!.extension_pending === false, { timeoutMs: 60_000 })).toBe(true);
    const done = await rows(shareId);
    expect(done.map((r) => r.status)).toEqual(["swapped", "swapped"]);
    const after = await share(shareId);
    expect(after).toMatchObject({ status: "active", retention_class: "d30", extension_pending: false, extension_failed_at: null });
    expect(after!.expires_at.getTime()).toBe(done[0]!.new_expires_at.getTime());
    expect(after!.expires_at.getTime() - (await dbNow())).toBeGreaterThan(30 * DAY * 1000 - 120_000);

    for (const file of files) {
      const row = done.find((r) => r.file_id === file.fileId)!;
      expect(await keyOf(file.fileId)).toBe(row.new_key);
      expect(row.new_key).toMatch(/^d30\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}$/);
      expect(row.new_key.endsWith(file.fileId)).toBe(false);
      // The copy keeps the stored headers: the same name and type for downloads.
      expect(await stored(row.new_key)).toEqual(await stored(file.key));
      const now = await download(pro.device, file.fileId);
      expect(pathOf(now.url)).toBe(row.new_key);
      expect(sha(now.bytes)).toBe(sha(file.bytes));
      const old = await outboxFor(file.key);
      expect(old[0]).toMatchObject({ reason: "superseded", source_file_id: null, completed_at: null });
      expect(old[0]!.not_before.getTime()).toBeGreaterThan((await dbNow()) + 4 * 60_000);
    }
    // A URL issued before the swap still works for its 5 minutes.
    expect((await fetch(before.url)).status).toBe(200);
    // The link followed the share; its viewer downloads the new object.
    const content = await viewer.content(link.id);
    expect(content.body.share.expiresAt).toBe(after!.expires_at.toISOString());
    const viewed = await viewer.fileUrl(link.id, files[1]!.fileId);
    expect(viewed.status).toBe(200);
    expect(sha(Buffer.from(await (await fetch(viewed.body.url as string)).arrayBuffer()))).toBe(sha(files[1]!.bytes));
    // One set of bytes is charged (the duplicate is an operator cost, RISK-049).
    expect((await adminDb().query("select bytes_committed from app.storage_usage where subject_id = $1", [pro.userId])).rows[0].bytes_committed).toBe(usageBefore);
    const audit = await adminDb().query("select actor_kind, metadata from app.audit_events where action in ('share.extension_requested', 'share.extended') and target_id = $1 order by id", [shareId]);
    expect(audit.rows.map((r) => [r.actor_kind, r.metadata.mode ?? r.metadata.retentionClass])).toEqual([["device", "d30"], ["system", "copy"]]);

    // After the margin the janitor deletes the old keys (through the outbox), and only them.
    await adminDb().query("update app.object_deletions set not_before = now() where object_key = any($1) and completed_at is null", [files.map((f) => f.key)]);
    expect(await drainJanitor(async () => (await Promise.all(files.map((f) => stored(f.key)))).every((s) => s === null), { timeoutMs: 60_000 })).toBe(true);
    for (const row of done) expect(await stored(row.new_key)).not.toBeNull();
    expect(sha((await download(pro.device, files[0]!.fileId)).bytes)).toBe(sha(files[0]!.bytes));
  }, 180_000);

  it("a completed multipart file is copied at once (its part URLs can no longer write), whole and byte for byte", async () => {
    const pro = await proDevice();
    const big = await startBig(pro.device, BIG, { expiresIn: DAY });
    await uploadParts(pro.device, big.shareId, big.fileId, all());
    expect((await complete(pro.device, big.shareId, big.fileId)).status).toBe(200);
    expect((await extend(pro.device, big.shareId, 90 * DAY)).status).toBe(202);
    const [row] = await rows(big.shareId);
    expect(row!.new_retention_class).toBe("d90");
    expect(row!.not_before.getTime()).toBeLessThanOrEqual(await dbNow());
    expect(await drainJanitor(async () => (await share(big.shareId))!.extension_pending === false, { timeoutMs: 120_000 })).toBe(true);
    const key = await keyOf(big.fileId);
    expect(key).toBe(row!.new_key);
    expect(await objectSha256(key)).toEqual({ size: BIG, sha256: expectedSha256(BIG) });
  }, 180_000);

  it("extends again and again: in place, then into d30, then into d90", async () => {
    const pro = await proDevice();
    const { shareId, files } = await upload(pro.device, 1, { expiresIn: HOUR });
    expect((await extend(pro.device, shareId, DAY)).status).toBe(200);
    expect((await extend(pro.device, shareId, DAY)).status).toBe(200);
    expect((await extend(pro.device, shareId, 30 * DAY)).status).toBe(202);
    await expireUploadUrls(shareId);
    expect(await drainJanitor(async () => (await share(shareId))!.extension_pending === false, { timeoutMs: 60_000 })).toBe(true);
    const month = await keyOf(files[0]!.fileId);
    expect(month).toMatch(/^d30\//);
    expect((await extend(pro.device, shareId, 90 * DAY)).status).toBe(202);
    expect(await drainJanitor(async () => (await share(shareId))!.extension_pending === false, { timeoutMs: 60_000 })).toBe(true);
    expect(await keyOf(files[0]!.fileId)).toMatch(/^d90\//);
    expect((await share(shareId))!.retention_class).toBe("d90");
    expect((await outboxFor(month))[0]).toMatchObject({ reason: "superseded" });
    expect(sha((await download(pro.device, files[0]!.fileId)).bytes)).toBe(sha(files[0]!.bytes));
  }, 180_000);
});

describe("while an extension is pending", () => {
  it("one at a time: concurrent requests make exactly one extension, later ones get 409 EXTENSION_PENDING", async () => {
    const pro = await proDevice();
    const { shareId } = await upload(pro.device, 2, { expiresIn: DAY });
    const results = await Promise.all(Array.from({ length: 5 }, () => extend(pro.device, shareId, 30 * DAY)));
    expect(results.map((r) => r.status).sort()).toEqual([202, 409, 409, 409, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe("EXTENSION_PENDING");
    expect(await rows(shareId)).toHaveLength(2);
    const again = await extend(pro.device, shareId, 90 * DAY);
    expect(again.status).toBe(409);
  });

  it("concurrent in-place requests leave one consistent expiry, each success audited", async () => {
    const pro = await proDevice();
    const { shareId } = await upload(pro.device, 1, { expiresIn: HOUR });
    const results = await Promise.all(Array.from({ length: 5 }, () => extend(pro.device, shareId, DAY)));
    const ok = results.filter((r) => r.status === 200);
    expect(ok.length).toBeGreaterThan(0);
    // A request whose transaction began before an earlier one's committed asks for nothing later: refused.
    for (const r of results.filter((x) => x.status !== 200)) expect(r.body.error).toMatchObject({ code: "EXPIRY_NOT_ALLOWED", details: { reason: "not_later" } });
    const latest = Math.max(...ok.map((r) => new Date(r.body.share.expiresAt).getTime()));
    expect((await share(shareId))!.expires_at.getTime()).toBe(latest);
    expect((await adminDb().query("select count(*)::int as n from app.audit_events where action = 'share.extended' and target_id = $1", [shareId])).rows[0].n).toBe(ok.length);
  });

  it("the creator deletes the share after one copy is made: the extension is cancelled and both copies' keys go", async () => {
    const pro = await proDevice();
    const { shareId, files } = await upload(pro.device, 2, { expiresIn: DAY });
    expect((await extend(pro.device, shareId, 30 * DAY)).status).toBe(202);
    await expireUploadUrls(shareId, files[0]!.fileId);
    expect(await drainJanitor(async () => (await rows(shareId)).some((r) => r.status === "copied"), { timeoutMs: 60_000 })).toBe(true);
    const made = (await rows(shareId)).find((r) => r.status === "copied")!;
    expect(await stored(made.new_key)).not.toBeNull();
    // The second file's upload URL dies too (its copy stays not due), so its old key is deleted, not tombstoned.
    await adminDb().query("update app.files set upload_url_expires_at = now() - interval '10 minutes' where id = $1", [files[1]!.fileId]);

    expect((await pro.device.call("DELETE", `/api/v1/shares/${shareId}`)).status).toBe(204);
    const cancelled = await rows(shareId);
    expect(cancelled.map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
    for (const r of cancelled) expect((await outboxFor(r.new_key))[0]).toMatchObject({ reason: "extension_cancelled", source_file_id: null });
    for (const f of files) expect((await outboxFor(f.key))[0]).toMatchObject({ reason: "share_ended", source_file_id: f.fileId });
    const keys = [...cancelled.map((r) => r.new_key), ...files.map((f) => f.key)];
    expect(await drainJanitor(async () => (await Promise.all(keys.map(stored))).every((s) => s === null), { timeoutMs: 60_000 })).toBe(true);
    expect((await pro.device.call("GET", `/api/v1/shares/${shareId}`)).status).toBe(404);
  }, 180_000);

  it("the share expires mid-copy: the expiry job cancels the extension", async () => {
    const pro = await proDevice();
    const { shareId } = await upload(pro.device, 1, { expiresIn: DAY });
    expect((await extend(pro.device, shareId, 30 * DAY)).status).toBe(202);
    await adminDb().query("update app.shares set expires_at = now() - interval '1 second' where id = $1", [shareId]);
    // Past its expiry the share is gone for its creator too, before the job runs.
    expect((await extend(pro.device, shareId, 90 * DAY)).status).toBe(404);
    await adminDb().query("select app.expire_due_shares(500)");
    expect((await share(shareId))!.status).toBe("expired");
    expect((await rows(shareId)).map((r) => r.status)).toEqual(["cancelled"]);
  });

  it("a takedown mid-copy holds the old and the new keys; the janitor deletes neither", async () => {
    const pro = await proDevice();
    const { shareId, files } = await upload(pro.device, 1, { expiresIn: DAY });
    expect((await extend(pro.device, shareId, 30 * DAY)).status).toBe(202);
    const [row] = await rows(shareId);
    await adminDb().query("select app.admin_block_share($1, 'report', 'Op One')", [shareId]);
    expect((await outboxFor(files[0]!.key))[0]).toMatchObject({ legal_hold: true });
    expect((await outboxFor(row!.new_key))[0]).toMatchObject({ legal_hold: true });
    await drainJanitor(async () => false, { timeoutMs: 3000 });
    expect(await stored(files[0]!.key)).not.toBeNull();
    expect((await outboxFor(files[0]!.key))[0]!.completed_at).toBeNull();
    await adminDb().query("select app.admin_release_hold($1, 'cleared', 'Op One')", [shareId]);
  }, 180_000);
});

describe("failures, with the janitor in this process behind a fault proxy", () => {
  let proxy: FaultProxy;
  beforeAll(async () => {
    await setCronJobActive("trigger-storage-janitor", false);
    proxy = await startFaultProxy();
  });
  afterAll(async () => {
    await proxy.close();
    await setCronJobActive("trigger-storage-janitor", true);
  });

  it("a storage error backs off and the copy is retried", async () => {
    const pro = await proDevice();
    const { shareId } = await upload(pro.device, 1, { expiresIn: DAY });
    expect((await extend(pro.device, shareId, 30 * DAY)).status).toBe(202);
    await expireUploadUrls(shareId);
    proxy.fail({ method: "PUT", times: 1, kind: 500, header: "x-amz-copy-source" });
    await runNodeJanitor("delete", { storage: sdkStorage(proxy.endpoint) });
    const [failed] = await rows(shareId);
    expect(failed).toMatchObject({ status: "pending", attempts: 1, last_error: "s3:500:InternalError" });
    expect(failed!.not_before.getTime() - (await dbNow())).toBeGreaterThan(50_000);
    await expireUploadUrls(shareId);
    await runNodeJanitor("delete", { storage: sdkStorage(proxy.endpoint) });
    expect((await rows(shareId))[0]!.status).toBe("swapped");
  });

  it("a partial copy whose other copy keeps failing fails the extension: the share keeps its expiry and keys, the copy made is deleted, the creator may retry", async () => {
    const pro = await proDevice();
    const { shareId, files } = await upload(pro.device, 2, { expiresIn: DAY });
    const expiresBefore = (await share(shareId))!.expires_at.getTime();
    expect((await extend(pro.device, shareId, 30 * DAY)).status).toBe(202);
    // The first file is copied; the second fails for the fifth time.
    await expireUploadUrls(shareId, files[0]!.fileId);
    await runNodeJanitor("delete", { storage: sdkStorage(proxy.endpoint) });
    const firstCopy = (await rows(shareId)).find((r) => r.file_id === files[0]!.fileId)!;
    expect(firstCopy.status).toBe("copied");
    expect(await stored(firstCopy.new_key)).not.toBeNull();
    await adminDb().query("update app.share_extension_files set attempts = 4 where share_id = $1 and file_id = $2", [shareId, files[1]!.fileId]);
    await expireUploadUrls(shareId, files[1]!.fileId);
    proxy.fail({ method: "PUT", times: 1, kind: 500, header: "x-amz-copy-source" });
    const logs = await runNodeJanitor("delete", { storage: sdkStorage(proxy.endpoint) });
    expect(logs.find((l) => l.event === "janitor.extension_failed")).toMatchObject({ level: "error" });

    expect((await rows(shareId)).map((r) => r.status).sort()).toEqual(["cancelled", "failed"]);
    expect(await share(shareId)).toMatchObject({ status: "active", retention_class: "d7", extension_pending: false });
    expect((await share(shareId))!.expires_at.getTime()).toBe(expiresBefore);
    for (const f of files) expect(await keyOf(f.fileId)).toBe(f.key);
    const seen = await pro.device.call("GET", `/api/v1/shares/${shareId}`);
    expect(seen.body.share.expiry).toEqual({ extendable: true, extensionPending: false, extensionFailed: true });
    expect(sha((await download(pro.device, files[1]!.fileId)).bytes)).toBe(sha(files[1]!.bytes));

    // The copy that was made goes through the outbox.
    expect((await outboxFor(firstCopy.new_key))[0]).toMatchObject({ reason: "extension_cancelled", source_file_id: null });
    await runNodeJanitor("delete");
    expect(await stored(firstCopy.new_key)).toBeNull();
    for (const f of files) expect(await stored(f.key)).not.toBeNull();

    const retry = await extend(pro.device, shareId, 30 * DAY);
    expect(retry.status).toBe(202);
    expect((await pro.device.call("GET", `/api/v1/shares/${shareId}`)).body.share.expiry.extensionFailed).toBe(false);
    expect(new Set((await rows(shareId)).map((r) => r.new_key)).size).toBe(4);
  });
});

describe("the janitor's guard rails while an extension is pending", () => {
  it("never deletes the old key (share_open) or the new key (extension_pending)", async () => {
    const pro = await proDevice();
    const { shareId, files } = await upload(pro.device, 1, { expiresIn: DAY });
    expect((await extend(pro.device, shareId, 30 * DAY)).status).toBe(202);
    const [row] = await rows(shareId);
    await adminDb().query(
      "insert into app.object_deletions (object_key, reason, source_file_id) values ($1, 'orphan', $2), ($3, 'orphan', null)",
      [files[0]!.key, files[0]!.fileId, row!.new_key],
    );
    try {
      expect(
        await drainJanitor(async () => (await outboxFor(row!.new_key))[0]?.last_error === "guard:extension_pending" && (await outboxFor(files[0]!.key))[0]?.last_error === "guard:share_open", {
          timeoutMs: 30_000,
        }),
      ).toBe(true);
      expect(await stored(files[0]!.key)).not.toBeNull();
    } finally {
      await adminDb().query("delete from app.object_deletions where object_key = any($1) and completed_at is null", [[files[0]!.key, row!.new_key]]);
    }
  }, 180_000);
});

describe("authorization and entitlements (T4-X6, E6)", () => {
  it("Free and anonymous creators are refused with the Pro hint, whatever they ask for", async () => {
    const free = await accountDevice();
    const { shareId } = await upload(free.device, 1, { expiresIn: DAY });
    for (const expiresIn of [DAY, 30 * DAY]) {
      const refused = await extend(free.device, shareId, expiresIn);
      expect(refused.status).toBe(403);
      expect(refused.body.error).toMatchObject({ code: "FEATURE_NOT_IN_PLAN", details: { feature: "extendExpiry", requiredPlan: "pro" } });
    }
    const anonymous = await Device.create(newNetwork().ip());
    const text = await anonymous.postText();
    expect((await extend(anonymous, text.id, DAY)).status).toBe(403);
    expect(await rows(shareId)).toEqual([]);
  });

  it("client-side spoofing: extra fields, a plan, a class, an expiry date, a string or a non-option are refused", async () => {
    const pro = await proDevice();
    const { shareId } = await upload(pro.device, 1, { expiresIn: DAY });
    const before = (await share(shareId))!.expires_at.getTime();
    for (const body of [
      { expiresIn: 30 * DAY, plan: "pro" },
      { expiresIn: 30 * DAY, retentionClass: "d90" },
      { expiresAt: new Date(Date.now() + 365 * DAY * 1000).toISOString() },
      { expiresIn: String(30 * DAY) },
      {},
    ]) {
      expect((await pro.device.call("POST", `/api/v1/shares/${shareId}/extend`, body)).status).toBe(400);
    }
    for (const expiresIn of [29 * DAY, 91 * DAY, 365 * DAY]) {
      const refused = await extend(pro.device, shareId, expiresIn);
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe("EXPIRY_NOT_ALLOWED");
    }
    const shorter = await extend(pro.device, shareId, HOUR);
    expect(shorter.status).toBe(422);
    expect(shorter.body.error).toMatchObject({ code: "EXPIRY_NOT_ALLOWED", details: { reason: "not_later" } });
    expect((await share(shareId))!.expires_at.getTime()).toBe(before);
    expect(await rows(shareId)).toEqual([]);
  });

  it("IDOR: another user on the same network gets 403 NOT_CREATOR, elsewhere 404; unknown and malformed IDs 404", async () => {
    const network = newNetwork();
    const owner = await proDevice(network.ip());
    const { shareId } = await upload(owner.device, 1, { expiresIn: DAY });
    const before = (await share(shareId))!.expires_at.getTime();
    const neighbour = await proDevice(network.ip());
    const elsewhere = await proDevice();
    expect((await extend(neighbour.device, shareId, 30 * DAY)).body.error.code).toBe("NOT_CREATOR");
    expect((await extend(elsewhere.device, shareId, 30 * DAY)).status).toBe(404);
    expect((await extend(owner.device, "6f1d3a52-0000-4000-8000-000000000000", 30 * DAY)).status).toBe(404);
    expect((await extend(owner.device, "not-a-share", 30 * DAY)).status).toBe(404);
    expect((await share(shareId))!.expires_at.getTime()).toBe(before);
    expect(await rows(shareId)).toEqual([]);
  });

  it("refused for burn shares, shares still uploading, deleted shares", async () => {
    const pro = await proDevice();
    const burn = await pro.device.postBurnText();
    const burnRefused = await extend(pro.device, burn.id, 30 * DAY);
    expect(burnRefused.status).toBe(422);
    expect(burnRefused.body.error).toMatchObject({ code: "EXTEND_NOT_ALLOWED", details: { reason: "burn" } });

    const uploading = await pro.device.call("POST", "/api/v1/shares", { destination: "network", files: [{ name: "a", size: 10, type: "text/plain" }] });
    const pending = await extend(pro.device, uploading.body.share.id, 30 * DAY);
    expect(pending.status).toBe(422);
    expect(pending.body.error).toMatchObject({ code: "EXTEND_NOT_ALLOWED", details: { reason: "not_active" } });

    const text = await pro.device.postText();
    expect((await pro.device.call("DELETE", `/api/v1/shares/${text.id}`)).status).toBe(204);
    expect((await extend(pro.device, text.id, 30 * DAY)).status).toBe(404);
  });

  it("after a downgrade extend is refused, and an extension already pending finishes (D4-13)", async () => {
    const pro = await proDevice();
    const { shareId } = await upload(pro.device, 1, { expiresIn: DAY });
    expect((await extend(pro.device, shareId, 30 * DAY)).status).toBe(202);
    await pro.downgrade();
    expect((await extend(pro.device, shareId, 90 * DAY)).body.error.code).toBe("FEATURE_NOT_IN_PLAN");
    await expireUploadUrls(shareId);
    expect(await drainJanitor(async () => (await share(shareId))!.extension_pending === false, { timeoutMs: 60_000 })).toBe(true);
    expect((await share(shareId))!.retention_class).toBe("d30");
  }, 180_000);

  it("an upload-restricted account can't extend, and the limit is 30 an hour", async () => {
    const pro = await proDevice();
    const { shareId } = await upload(pro.device, 1, { expiresIn: HOUR });
    await adminDb().query(
      "insert into app.user_flags (user_id, upload_restricted) values ($1, true) on conflict (user_id) do update set upload_restricted = true",
      [pro.userId],
    );
    expect((await extend(pro.device, shareId, DAY)).body.error.code).toBe("UPLOADS_RESTRICTED");
    await adminDb().query("update app.user_flags set upload_restricted = false where user_id = $1", [pro.userId]);
    await setCounter(`extendShare:${pro.userId}`, "1 hour", 30);
    const limited = await extend(pro.device, shareId, DAY);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});
