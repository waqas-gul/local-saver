import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { adminDb, closeAdminDb, setFlag, stack } from "./support/api";
import { accountDevice, counter, proDevice, setStorageUsed } from "./support/entitlements";
import { drainJanitor, runNodeJanitor } from "./support/janitor";
import {
  all,
  BIG,
  BIG_PARTS,
  complete,
  expectedSha256,
  fileRow,
  filePath,
  GIB,
  MIB,
  objectSha256,
  openUploads,
  outbox,
  PART,
  partBytes,
  partUrls,
  putPart,
  rawPart,
  startBig,
  storageUsage,
  storedParts,
  uploadParts,
} from "./support/multipart";

/**
 * Multipart uploads (phase 4 §17.8.1, P4-14, AC-4.5): T4-M0 … T4-M13 against the real server, RustFS
 * standing in for R2 (P4-00 checked that it enforces signed part sizes, lists, completes and aborts as R2
 * does; it accepts unequal parts, which the server refuses itself) and the real storage-janitor Edge
 * Function, which alone aborts uploads (D-1). Files are 100 MiB + 1 byte: 7 parts of 16 MiB, the last
 * 4 MiB + 1 byte. T4-M6 (a wrong checksum) doesn't apply: Content-MD5 isn't adopted (§21).
 */

afterAll(closeAdminDb);

const HOUR = 3600;
const QUOTA = 100 * GIB; // Pro (D4-9)
const serverLog = () => readFileSync(stack().serverLog, "utf8");

async function reservation(fileId: string) {
  const { rows } = await adminDb().query(
    "select status, bytes, extract(epoch from expires_at - created_at)::int as ttl from app.storage_reservations where file_id = $1",
    [fileId],
  );
  return rows[0] as { status: string; bytes: string; ttl: number };
}

async function shareStatus(shareId: string): Promise<string> {
  return (await adminDb().query("select status from app.shares where id = $1", [shareId])).rows[0].status as string;
}

async function refunded(shareId: string): Promise<boolean> {
  return (await adminDb().query("select refunded_at is not null as r from app.upload_volume_charges where share_id = $1", [shareId])).rows[0].r as boolean;
}

describe("starting a multipart upload (E1, E25)", () => {
  it("Free stays at one PUT's 100 MiB, with the upgrade hint; Pro gets parts above it", async () => {
    const free = await accountDevice();
    expect((await startBig(free.device, 100 * MIB)).target.method).toBe("PUT");
    const refused = await startBig(free.device, BIG);
    expect(refused.init.status).toBe(413);
    expect(refused.init.body.error).toMatchObject({ code: "FILE_TOO_LARGE", details: { maxFileBytes: 100 * MIB, requiredPlan: "pro" } });

    const pro = await proDevice();
    const single = await startBig(pro.device, 100 * MIB);
    expect(single.target).toMatchObject({ method: "PUT", sizeBytes: 100 * MIB });
    const big = await startBig(pro.device, BIG);
    expect(big.init.status).toBe(201);
    expect(big.target).toMatchObject({ method: "MULTIPART", fileId: big.fileId, sizeBytes: BIG, partSize: PART, partCount: BIG_PARTS });
    expect(big.target).not.toHaveProperty("url");
    expect(Date.parse(big.target.expiresAt) - Date.now()).toBeGreaterThan(23.9 * HOUR * 1000);

    const row = await fileRow(big.fileId);
    expect(row).toMatchObject({ upload_mode: "multipart", part_size: String(PART), part_count: BIG_PARTS, upload_status: "pending" });
    expect(row.multipart_upload_id).toMatch(/^[!-~]+$/);
    expect(row.upload_url_expires_at).toBeNull(); // no URL yet
    expect(await reservation(big.fileId)).toMatchObject({ status: "active", bytes: String(BIG), ttl: 26 * HOUR });
    // The upload exists in storage, and its ID never left the server.
    expect((await openUploads()).some((u) => u.key === row.object_key && u.uploadId === row.multipart_upload_id)).toBe(true);
    expect(JSON.stringify(big.init.body)).not.toContain(row.multipart_upload_id as string);
  });

  it("a share with a multipart file gives all its files the 24-hour deadline (all or nothing, DV1-10)", async () => {
    const pro = await proDevice();
    const mixed = await startBig(pro.device, BIG, { files: [{ name: "note.txt", size: 5 }] });
    const small = mixed.init.body.uploads[1];
    expect(small).toMatchObject({ method: "PUT", sizeBytes: 5 });
    expect((await fileRow(small.fileId)).deadline_seconds).toBeGreaterThan(23.9 * HOUR);
    expect((await reservation(small.fileId)).ttl).toBe(26 * HOUR);
    // Without a multipart file the deadline stays two hours (Phases 1–3).
    const plain = await pro.device.call("POST", "/api/v1/shares", { destination: "network", files: [{ name: "a.txt", size: 5, type: "text/plain" }] });
    expect((await fileRow(plain.body.uploads[0].fileId)).deadline_seconds).toBeLessThanOrEqual(2 * HOUR);
  });

  it("Pro's 5 GiB is 320 parts of 16 MiB; one byte more is refused without a hint", async () => {
    const pro = await proDevice();
    const five = await startBig(pro.device, 5 * GIB);
    expect(five.target).toMatchObject({ method: "MULTIPART", partSize: PART, partCount: 320 });
    const over = await startBig(pro.device, 5 * GIB + 1);
    expect(over.init.status).toBe(413);
    expect(over.init.body.error.details).toEqual({ maxFileBytes: 5 * GIB });
    expect((await pro.device.call("POST", `${filePath(five.shareId, five.fileId)}/multipart/abort`, {})).status).toBe(204);
  });

  it("refuses an init that wouldn't fit the storage quota before starting anything in storage (T4-M10)", async () => {
    const pro = await proDevice();
    await setStorageUsed(pro.userId, QUOTA - 50 * MIB);
    const before = (await openUploads()).length;
    const refused = await startBig(pro.device, BIG);
    expect(refused.init.status).toBe(409);
    expect(refused.init.body.error).toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED", details: { quotaBytes: QUOTA } });
    expect(refused.init.body.error.details).not.toHaveProperty("requiredPlan");
    expect((await openUploads()).length).toBe(before);
    expect((await adminDb().query("select count(*)::int as n from app.shares where created_by_user_id = $1", [pro.userId])).rows[0].n).toBe(0);
  });

  it("concurrent inits never reserve more than the quota: the declared size is reserved at once (T4-M10)", async () => {
    const pro = await proDevice();
    await setStorageUsed(pro.userId, QUOTA - 150 * MIB);
    const results = await Promise.all([startBig(pro.device, BIG), startBig(pro.device, BIG), startBig(pro.device, BIG)]);
    expect(results.map((r) => r.init.status).sort()).toEqual([201, 409, 409]);
    const usage = await storageUsage(pro.userId);
    expect(usage.committed + usage.reserved).toBeLessThanOrEqual(QUOTA);
    expect(usage.reserved).toBe(BIG);
  });
});

describe("part URLs", () => {
  it("each URL is signed for its part's exact size, for an hour at most and never past the share", async () => {
    const pro = await proDevice();
    const { shareId, fileId } = await startBig(pro.device, BIG, { expiresIn: HOUR });
    const shareExpiry = Date.parse((await pro.device.call("GET", `/api/v1/shares/${shareId}`)).body.share.expiresAt);
    const urls = await partUrls(pro.device, shareId, fileId, [7, 1]);
    expect(urls.status).toBe(200);
    expect(urls.body.parts.map((p: { partNumber: number; size: number }) => [p.partNumber, p.size])).toEqual([
      [7, 4 * MIB + 1],
      [1, PART],
    ]);
    for (const part of urls.body.parts as { url: string; expiresAt: string }[]) {
      expect(Date.parse(part.expiresAt)).toBeLessThanOrEqual(shareExpiry);
      expect(Date.parse(part.expiresAt) - Date.now()).toBeLessThanOrEqual(HOUR * 1000);
      expect(new URL(part.url).searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
    }
    // Recorded before handing out, as for single PUTs.
    expect((await fileRow(fileId)).upload_url_expires_at?.getTime()).toBeGreaterThanOrEqual(Date.parse(urls.body.parts[0].expiresAt) - 1000);
  });

  it("no URL for a part the plan doesn't have, and a URL edited for another part is refused by storage (T4-M4)", async () => {
    const pro = await proDevice();
    const { shareId, fileId } = await startBig(pro.device);
    const extra = await partUrls(pro.device, shareId, fileId, [BIG_PARTS + 1]);
    expect(extra.status).toBe(422);
    expect(extra.body.error).toMatchObject({ code: "MULTIPART_INVALID", details: { partCount: BIG_PARTS } });
    for (const bad of [[0], [1, 1], all(21), []]) expect((await partUrls(pro.device, shareId, fileId, bad)).status, JSON.stringify(bad)).toBe(400);

    const [last] = (await partUrls(pro.device, shareId, fileId, [BIG_PARTS])).body.parts;
    const forged = last.url.replace(`partNumber=${BIG_PARTS}`, `partNumber=${BIG_PARTS + 1}`);
    expect(await putPart(forged, partBytes(BIG_PARTS))).toEqual({ status: 403, code: "SignatureDoesNotMatch" });
    const row = await fileRow(fileId);
    expect(await storedParts(row.object_key, row.multipart_upload_id as string)).toEqual([]);
  });

  it("a part of the wrong size is refused by storage: the size is signed (T4-M5)", async () => {
    const pro = await proDevice();
    const { shareId, fileId } = await startBig(pro.device);
    const [first] = (await partUrls(pro.device, shareId, fileId, [1])).body.parts;
    expect(await putPart(first.url, Buffer.alloc(PART - 1, 1))).toEqual({ status: 403, code: "SignatureDoesNotMatch" });
    expect(await putPart(first.url, Buffer.alloc(PART + 1, 1))).toEqual({ status: 403, code: "SignatureDoesNotMatch" });
    expect((await putPart(first.url, partBytes(1))).status).toBe(200);
    const row = await fileRow(fileId);
    expect(await storedParts(row.object_key, row.multipart_upload_id as string)).toEqual([{ partNumber: 1, size: PART }]);
  });

  it("only for the creator's pending multipart file: other files, other accounts and the kill switch are refused", async () => {
    const pro = await proDevice();
    const { shareId, fileId, init } = await startBig(pro.device, BIG, { files: [{ name: "n.txt", size: 3 }] });
    const small = init.body.uploads[1].fileId as string;
    const stranger = await proDevice();
    const other = await startBig(pro.device);
    for (const [device, share, file] of [
      [stranger.device, shareId, fileId],
      [pro.device, shareId, small],
      [pro.device, other.shareId, fileId],
      [pro.device, shareId, "00000000-0000-4000-8000-000000000000"],
    ] as const) {
      expect((await partUrls(device, share, file, [1])).status).toBe(404);
      expect((await device.call("GET", `${filePath(share, file)}/multipart`)).status).toBe(404);
      expect((await device.call("POST", `${filePath(share, file)}/multipart/abort`, {})).status).toBe(404);
    }
    expect((await stranger.device.call("POST", `${filePath(shareId, small)}/upload-url`, {})).status).toBe(404);
    expect((await pro.device.call("POST", `${filePath(shareId, fileId)}/upload-url`, {})).status).toBe(404);

    await setFlag("uploads_enabled", false);
    try {
      expect((await partUrls(pro.device, shareId, fileId, [1])).body.error?.code).toBe("UPLOADS_DISABLED");
      expect((await pro.device.call("POST", `${filePath(shareId, small)}/upload-url`, {})).body.error?.code).toBe("UPLOADS_DISABLED");
    } finally {
      await setFlag("uploads_enabled", true);
    }
    expect((await partUrls(pro.device, shareId, fileId, [1])).status).toBe(200);
  });
});

describe("completing a multipart upload", () => {
  it("resumes from storage's part list after a reload, then assembles the exact file (T4-M2)", async () => {
    const pro = await proDevice();
    const before = await storageUsage(pro.userId);
    const { shareId, fileId } = await startBig(pro.device);
    await uploadParts(pro.device, shareId, fileId, [1, 2, 3, 4]);

    // A reload: the browser lost everything but the IDs; storage knows what arrived.
    const status = await pro.device.call("GET", `${filePath(shareId, fileId)}/multipart`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ partSize: PART, partCount: BIG_PARTS, uploaded: [1, 2, 3, 4].map((n) => ({ partNumber: n, size: PART })) });
    await uploadParts(pro.device, shareId, fileId, [5, 6, 7]);

    const done = await complete(pro.device, shareId, fileId);
    expect(done.status).toBe(200);
    expect(done.body.share).toMatchObject({ status: "active", totalBytes: BIG, files: [{ id: fileId, sizeBytes: BIG, status: "verified" }] });
    const row = await fileRow(fileId);
    expect(await objectSha256(row.object_key)).toEqual({ size: BIG, sha256: expectedSha256() });
    expect(await storedParts(row.object_key, row.multipart_upload_id as string)).toBe("gone");
    expect(await storageUsage(pro.userId)).toEqual({ committed: before.committed + BIG, reserved: before.reserved, files: before.files + 1 });
    expect((await reservation(fileId)).status).toBe("committed");

    // Downloads work as for any file; complete again is idempotent; the GET reports everything uploaded.
    const download = await pro.device.call("POST", `/api/v1/files/${fileId}/download-url`, {});
    expect(download.status).toBe(200);
    expect((await complete(pro.device, shareId, fileId)).status).toBe(200);
    expect((await pro.device.call("GET", `${filePath(shareId, fileId)}/multipart`)).body.uploaded).toHaveLength(BIG_PARTS);
  });

  it("a missing part refuses completion without rejecting; once sent, it completes (T4-M3)", async () => {
    const pro = await proDevice();
    const { shareId, fileId } = await startBig(pro.device);
    await uploadParts(pro.device, shareId, fileId, [1, 2, 3, 4, 5, 7]);
    const early = await complete(pro.device, shareId, fileId);
    expect(early.status).toBe(409);
    expect(early.body.error).toMatchObject({ code: "MULTIPART_INCOMPLETE", details: { missingParts: 1 } });
    expect((await fileRow(fileId)).upload_status).toBe("pending");
    await uploadParts(pro.device, shareId, fileId, [6]);
    expect((await complete(pro.device, shareId, fileId)).status).toBe(200);
  });

  it("ignores any part list or ETag the client offers: the body stays empty, storage's list is used (T4-M7)", async () => {
    const pro = await proDevice();
    const { shareId, fileId } = await startBig(pro.device);
    await uploadParts(pro.device, shareId, fileId, all());
    const offered = await complete(pro.device, shareId, fileId, { parts: [{ partNumber: 1, etag: '"00000000000000000000000000000000"' }] });
    expect(offered.status).toBe(400);
    expect((await fileRow(fileId)).upload_status).toBe("pending");
    expect((await complete(pro.device, shareId, fileId)).status).toBe(200);
    expect((await objectSha256((await fileRow(fileId)).object_key)).size).toBe(BIG);
  });

  it("two tabs uploading and completing the same file: one completion, one consistent object (T4-M8)", async () => {
    const pro = await proDevice();
    const before = await storageUsage(pro.userId);
    const { shareId, fileId } = await startBig(pro.device);
    await Promise.all([uploadParts(pro.device, shareId, fileId, all()), uploadParts(pro.device, shareId, fileId, all().reverse())]);
    const results = await Promise.all([complete(pro.device, shareId, fileId), complete(pro.device, shareId, fileId), complete(pro.device, shareId, fileId)]);
    for (const r of results) expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(await objectSha256((await fileRow(fileId)).object_key)).toEqual({ size: BIG, sha256: expectedSha256() });
    expect(await storageUsage(pro.userId)).toEqual({ committed: before.committed + BIG, reserved: before.reserved, files: before.files + 1 });
    expect(await shareStatus(shareId)).toBe("active");
  });

  it("a lying part (the wrong size, past a storage that ignored the signed length) is refused and the file rejected (T4-M12)", async () => {
    const pro = await proDevice();
    const used = await storageUsage(pro.userId);
    const { shareId, fileId } = await startBig(pro.device);
    const volume = await counter(`upload_kib:user:${pro.userId}`, "1 day");
    await uploadParts(pro.device, shareId, fileId, [1, 3, 4, 5, 6, 7]);
    const row = await fileRow(fileId);
    // Declared 100 MiB + 1; part 2 is 1 MiB instead of 16, so storage holds 85 MiB + 1 byte.
    await rawPart(row.object_key, row.multipart_upload_id as string, 2, Buffer.alloc(MIB, 2));

    const refused = await complete(pro.device, shareId, fileId);
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: "MULTIPART_INVALID", details: { reason: "multipart_invalid" } });
    expect(await fileRow(fileId)).toMatchObject({ upload_status: "rejected", rejection_reason: "multipart_invalid" });
    expect(await shareStatus(shareId)).toBe("failed");
    expect((await reservation(fileId)).status).toBe("released");
    expect(await storageUsage(pro.userId)).toMatchObject({ committed: used.committed, reserved: used.reserved });
    expect(await refunded(shareId)).toBe(true);
    expect(await counter(`upload_kib:user:${pro.userId}`, "1 day")).toBe(volume - Math.ceil(BIG / 1024));
    // Nothing was assembled; the janitor aborts the upload.
    expect(await outbox(fileId)).toMatchObject([{ reason: "upload_rejected", multipart_upload_id: row.multipart_upload_id }]);
    expect(await drainJanitor(async () => (await storedParts(row.object_key, row.multipart_upload_id as string)) === "gone")).toBe(true);
    expect((await outbox(fileId))[0]?.completed_at).not.toBeNull();
  });

  it("an upload begun on Pro may finish after a downgrade: the share's snapshot allowed it (T4-M13, D4-27)", async () => {
    const pro = await proDevice();
    const { shareId, fileId } = await startBig(pro.device);
    await uploadParts(pro.device, shareId, fileId, [1, 2, 3]);
    await pro.downgrade();
    expect((await startBig(pro.device)).init.status).toBe(413); // Free now
    await uploadParts(pro.device, shareId, fileId, [4, 5, 6, 7]);
    const done = await complete(pro.device, shareId, fileId);
    expect(done.status).toBe(200);
    expect(done.body.share.status).toBe("active");
  });
});

describe("cancelling and abandoning", () => {
  it("cancel: the file is rejected, the share fails, storage and volume come back, and the janitor aborts (T4-M9)", async () => {
    const pro = await proDevice();
    const used = await storageUsage(pro.userId);
    const { shareId, fileId } = await startBig(pro.device, BIG, { files: [{ name: "n.txt", size: 3 }] });
    const volume = await counter(`upload_kib:user:${pro.userId}`, "1 day");
    await uploadParts(pro.device, shareId, fileId, [1, 2]);
    const row = await fileRow(fileId);
    const [late] = (await partUrls(pro.device, shareId, fileId, [3])).body.parts;

    const cancelled = await pro.device.call("POST", `${filePath(shareId, fileId)}/multipart/abort`, {});
    expect(cancelled.status).toBe(204);
    expect(await fileRow(fileId)).toMatchObject({ upload_status: "rejected", rejection_reason: "cancelled" });
    expect(await shareStatus(shareId)).toBe("failed");
    expect(await storageUsage(pro.userId)).toMatchObject({ committed: used.committed, reserved: used.reserved });
    expect(await refunded(shareId)).toBe(true);
    expect(await counter(`upload_kib:user:${pro.userId}`, "1 day")).toBe(volume - Math.ceil((BIG + 3) / 1024));
    expect(await outbox(fileId)).toMatchObject([{ reason: "multipart_abort", multipart_upload_id: row.multipart_upload_id, completed_at: null }]);
    const audit = await adminDb().query("select count(*)::int as n from app.audit_events where action = 'share.upload_cancelled' and target_id = $1", [shareId]);
    expect(audit.rows[0].n).toBe(1);

    // The web tier aborted nothing: storage still has the upload until the janitor runs.
    expect(await storedParts(row.object_key, row.multipart_upload_id as string)).toHaveLength(2);
    expect(await drainJanitor(async () => (await storedParts(row.object_key, row.multipart_upload_id as string)) === "gone")).toBe(true);
    expect(await putPart(late.url, partBytes(3))).toEqual({ status: 404, code: "NoSuchUpload" });
    expect((await outbox(fileId))[0]?.completed_at).not.toBeNull();
    // It is over: every route answers as for a share that doesn't exist.
    expect((await pro.device.call("POST", `${filePath(shareId, fileId)}/multipart/abort`, {})).status).toBe(404);
    expect((await pro.device.call("GET", `${filePath(shareId, fileId)}/multipart`)).status).toBe(404);
  });

  it("a share ending mid-upload for any reason queues its open upload for the janitor (here: its creator deletes it)", async () => {
    const pro = await proDevice();
    const { shareId, fileId } = await startBig(pro.device);
    await uploadParts(pro.device, shareId, fileId, [1]);
    const row = await fileRow(fileId);
    expect((await pro.device.call("DELETE", `/api/v1/shares/${shareId}`)).status).toBe(204);
    expect(await outbox(fileId)).toMatchObject([{ reason: "share_ended", multipart_upload_id: row.multipart_upload_id }]);
    expect(await drainJanitor(async () => (await storedParts(row.object_key, row.multipart_upload_id as string)) === "gone")).toBe(true);
  });

  it("an abandoned upload fails at its deadline and the janitor aborts it; reconciliation leaves young uploads alone (T4-M11)", async () => {
    const pro = await proDevice();
    const young = await startBig(pro.device);
    const youngRow = await fileRow(young.fileId);
    const { shareId, fileId } = await startBig(pro.device);
    await uploadParts(pro.device, shareId, fileId, [1]);
    const row = await fileRow(fileId);

    await adminDb().query("update app.files set upload_expires_at = now() - interval '1 minute' where id = $1", [fileId]);
    expect((await partUrls(pro.device, shareId, fileId, [2])).body.error?.code).toBe("UPLOAD_EXPIRED");
    await adminDb().query("select app.fail_stale_uploads(500)");
    expect(await fileRow(fileId)).toMatchObject({ upload_status: "rejected", rejection_reason: "upload_timeout" });
    expect(await shareStatus(shareId)).toBe("failed");
    expect(await outbox(fileId)).toMatchObject([{ reason: "multipart_abort", multipart_upload_id: row.multipart_upload_id }]);
    expect(await drainJanitor(async () => (await storedParts(row.object_key, row.multipart_upload_id as string)) === "gone")).toBe(true);

    // The weekly reconciliation's multipart step: an upload younger than the 24-hour deadline stays.
    const closeRuns = () => adminDb().query("update app.storage_reconcile_runs set status = 'finished', finished_at = now() where status = 'running'");
    await closeRuns();
    await adminDb().query("insert into app.storage_reconcile_runs default values");
    try {
      await runNodeJanitor("reconcile", { overrides: { maxPages: 0 } });
    } finally {
      await closeRuns();
    }
    expect((await openUploads()).some((u) => u.key === youngRow.object_key && u.uploadId === youngRow.multipart_upload_id)).toBe(true);
  });
});

describe("a fresh PUT URL per file (C4-13, T4-M0)", () => {
  it("a 100-file batch gets each URL just before its turn, so none has expired", async () => {
    const pro = await proDevice();
    const files = Array.from({ length: 100 }, (_, i) => ({ name: `f${i}.txt`, size: 1, type: "text/plain" }));
    const init = await pro.device.call("POST", "/api/v1/shares", { destination: "network", files });
    expect(init.status).toBe(201);
    const shareId = init.body.share.id as string;
    for (const target of init.body.uploads as { fileId: string }[]) {
      const fresh = await pro.device.call("POST", `${filePath(shareId, target.fileId)}/upload-url`, {});
      expect(fresh.status).toBe(200);
      expect(fresh.body.upload).toMatchObject({ fileId: target.fileId, method: "PUT", sizeBytes: 1 });
      expect(Date.parse(fresh.body.upload.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
      const put = await fetch(fresh.body.upload.url, { method: "PUT", headers: fresh.body.upload.headers, body: Buffer.from("x") });
      expect(put.status).toBe(200);
      expect((await complete(pro.device, shareId, target.fileId)).status).toBe(200);
    }
    expect(await shareStatus(shareId)).toBe("active");
  });

  it("only while the file awaits its bytes, in time", async () => {
    const pro = await proDevice();
    const init = await pro.device.call("POST", "/api/v1/shares", {
      destination: "network",
      files: [{ name: "a.txt", size: 1, type: "text/plain" }, { name: "b.txt", size: 1, type: "text/plain" }],
    });
    const [a, b] = init.body.uploads as { fileId: string; url: string; headers: Record<string, string> }[];
    const shareId = init.body.share.id as string;
    await fetch(a!.url, { method: "PUT", headers: a!.headers, body: Buffer.from("a") });
    expect((await complete(pro.device, shareId, a!.fileId)).status).toBe(200);
    expect((await pro.device.call("POST", `${filePath(shareId, a!.fileId)}/upload-url`, {})).body.error?.code).toBe("UPLOAD_COMPLETE");
    await adminDb().query("update app.files set upload_expires_at = now() - interval '1 minute' where id = $1", [b!.fileId]);
    expect((await pro.device.call("POST", `${filePath(shareId, b!.fileId)}/upload-url`, {})).body.error?.code).toBe("UPLOAD_EXPIRED");
  });
});

describe("logs", () => {
  it("never carry a part URL's signature or an upload ID", async () => {
    const { rows } = await adminDb().query("select multipart_upload_id from app.files where multipart_upload_id is not null order by created_at desc limit 20");
    const log = serverLog();
    expect(log).not.toMatch(/X-Amz-Signature/i);
    for (const row of rows) expect(log).not.toContain(row.multipart_upload_id as string);
  });
});

