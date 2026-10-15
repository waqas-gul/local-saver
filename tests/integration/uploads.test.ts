import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { LOCAL } from "../../scripts/local-stack.cjs";
import { adminDb, closeAdminDb, Device, newNetwork, PNG_BYTES, setFlag, stack } from "./support/api";

/** Uploads, storage and downloads (09 §4.4–§4.5). Storage is RustFS standing in for R2 (DV1-4). */

const MB = 1024 * 1024;

afterAll(closeAdminDb);

function s3() {
  const { endpoint, accessKeyId, secretAccessKey } = stack().storage;
  return new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
}

async function objectExists(key: string): Promise<boolean> {
  return (await storedObject(key)) !== null;
}

async function storedObject(key: string): Promise<{ size: number; tombstone: boolean } | null> {
  try {
    const head = await s3().send(new HeadObjectCommand({ Bucket: stack().storage.bucket, Key: key }));
    return { size: head.ContentLength ?? -1, tombstone: head.Metadata?.tombstone === "1" };
  } catch {
    return null;
  }
}

/** The uploaded bytes are gone: no object, or the empty tombstone that holds the key. */
async function contentGone(key: string): Promise<boolean> {
  const stored = await storedObject(key);
  return stored === null || (stored.tombstone && stored.size === 0);
}

async function outboxRow(key: string) {
  const { rows } = await adminDb().query(
    "select completed_at, tombstoned_at, not_before from app.object_deletions where object_key = $1 order by id desc limit 1",
    [key],
  );
  return rows[0] as { completed_at: Date | null; tombstoned_at: Date | null; not_before: Date } | undefined;
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return condition();
}

function objectKeyOf(url: string): string {
  const path = decodeURIComponent(new URL(url).pathname);
  return path.slice(path.indexOf("/", 1) + 1);
}

describe("upload → verify → download (single PUT, DEC-026)", () => {
  it("uploads, verifies and lets another device on the network download it (T-002, T-027)", async () => {
    const net = newNetwork();
    const a = await Device.create(net.ip());
    const content = new TextEncoder().encode("Grüße from device A");
    const { init, upload, complete } = await a.uploadFile("Grüße.txt", content, "text/plain");

    expect(init.status).toBe(201);
    expect(init.body.share.status).toBe("pending_upload");
    expect(upload.headers).toMatchObject({
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="Gr__e.txt"; filename*=UTF-8''Gr%C3%BC%C3%9Fe.txt`,
      "cache-control": "private, no-cache",
    });

    expect(complete.status).toBe(200);
    expect(complete.body.share).toMatchObject({ status: "active", fileCount: 1, totalBytes: content.length });
    expect(complete.body.share.files[0]).toMatchObject({
      name: "Grüße.txt",
      sizeBytes: content.length,
      status: "verified",
      previewable: false,
      riskFlags: [],
    });

    const b = await Device.create(net.ip());
    expect(await b.feedIds()).toContain(init.body.share.id);
    const issued = await b.call("POST", `/api/v1/files/${upload.fileId}/download-url`, {});
    expect(issued.status).toBe(200);
    expect(issued.body).toMatchObject({ fileName: "Grüße.txt", sizeBytes: content.length });
    expect(new URL(issued.body.url).searchParams.get("X-Amz-Expires")).toBe("60");

    const download = await fetch(issued.body.url);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(content);

    const log = await adminDb().query("select actor_kind, event from app.downloads where file_id = $1", [upload.fileId]);
    expect(log.rows).toEqual([{ actor_kind: "network_device", event: "url_issued" }]);
  });

  it("returns upload targets and files in the order they were listed", async () => {
    const a = await Device.create(newNetwork().ip());
    const names = ["c.txt", "a.txt", "b.txt", "e.txt", "d.txt"];
    const init = await a.call("POST", "/api/v1/shares", {
      destination: "network",
      files: names.map((name, i) => ({ name, size: i + 1, type: "text/plain" })),
    });
    expect(init.status).toBe(201);
    expect(init.body.uploads.map((u: { name: string }) => u.name)).toEqual(names);
    expect(init.body.uploads.map((u: { sizeBytes: number }) => u.sizeBytes)).toEqual([1, 2, 3, 4, 5]);
    expect(init.body.share.files.map((f: { name: string }) => f.name)).toEqual(names);
  });

  it("replays a creation with the same Idempotency-Key, and re-checks the posting rules first", async () => {
    const a = await Device.create(newNetwork().ip());
    const body = { destination: "network", files: [{ name: "once.txt", size: 4, type: "text/plain" }] };
    const headers = { "idempotency-key": crypto.randomUUID() };
    const first = await a.call("POST", "/api/v1/shares", body, { headers });
    const again = await a.call("POST", "/api/v1/shares", body, { headers });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body.share.id).toBe(first.body.share.id);
    expect(again.body.uploads[0].fileId).toBe(first.body.uploads[0].fileId);

    await setFlag("uploads_enabled", false);
    try {
      const blocked = await a.call("POST", "/api/v1/shares", body, { headers });
      expect(blocked.status).toBe(503);
    } finally {
      await setFlag("uploads_enabled", true);
    }
  });

  it("keeps file names out of object keys (T-024)", async () => {
    const a = await Device.create(newNetwork().ip());
    const init = await a.call("POST", "/api/v1/shares", {
      destination: "network",
      files: [{ name: "secret-plans.pdf", size: 10, type: "application/pdf" }],
    });
    const key = objectKeyOf(init.body.uploads[0].url);
    expect(key).toMatch(/^d7\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}$/);
    expect(init.body.uploads[0].url).not.toContain("secret");
  });

  it("refuses a completion before the bytes arrive, then accepts it", async () => {
    const a = await Device.create(newNetwork().ip());
    const init = await a.call("POST", "/api/v1/shares", {
      destination: "network",
      files: [{ name: "late.bin", size: 4, type: "application/octet-stream" }],
    });
    const upload = init.body.uploads[0];
    const early = await a.call("POST", `/api/v1/shares/${init.body.share.id}/files/${upload.fileId}/complete`, {});
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("UPLOAD_INCOMPLETE");

    await fetch(upload.url, { method: "PUT", headers: upload.headers, body: Buffer.from([1, 2, 3, 4]) });
    const done = await a.call("POST", `/api/v1/shares/${init.body.share.id}/files/${upload.fileId}/complete`, {});
    expect(done.status).toBe(200);
    const again = await a.call("POST", `/api/v1/shares/${init.body.share.id}/files/${upload.fileId}/complete`, {});
    expect(again.status).toBe(200);
  });
});

describe("limits (07 §3)", () => {
  it("refuses a declared size above 100 MB (T-019) and more than 20 files", async () => {
    const a = await Device.create(newNetwork().ip());
    const big = await a.call("POST", "/api/v1/shares", {
      destination: "network",
      files: [{ name: "big.iso", size: 100 * MB + 1, type: "application/octet-stream" }],
    });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe("FILE_TOO_LARGE");

    const exact = await a.call("POST", "/api/v1/shares", {
      destination: "network",
      files: [{ name: "max.bin", size: 100 * MB, type: "application/octet-stream" }],
    });
    expect(exact.status).toBe(201);

    const many = await a.call("POST", "/api/v1/shares", {
      destination: "network",
      files: Array.from({ length: 21 }, (_, i) => ({ name: `f${i}.txt`, size: 1, type: "text/plain" })),
    });
    expect(many.status).toBe(413);
    expect(many.body.error.code).toBe("TOO_MANY_FILES");
  });

  it("uploads exactly 100 MB through one presigned PUT (AC-1.6, DEC-026)", { timeout: 120_000 }, async () => {
    const net = newNetwork();
    const a = await Device.create(net.ip());
    const bytes = new Uint8Array(100 * MB);
    const { complete, upload } = await a.uploadFile("hundred.bin", bytes, "application/octet-stream");
    expect(complete.status).toBe(200);
    expect(complete.body.share.files[0]).toMatchObject({ sizeBytes: 100 * MB, status: "verified" });

    const b = await Device.create(net.ip());
    const issued = await b.call("POST", `/api/v1/files/${upload.fileId}/download-url`, {});
    const head = await fetch(issued.body.url, { method: "GET", headers: { range: "bytes=0-0" } });
    expect(head.status).toBe(206);
    expect(head.headers.get("content-range")).toBe(`bytes 0-0/${100 * MB}`);
  });

  it("refuses an upload above the active storage quota with the 07 §4 error contract", async () => {
    const a = await Device.create(newNetwork().ip());
    const quota = 2 * 1024 * MB;
    await adminDb().query(
      `insert into app.storage_usage (subject_type, subject_id, bytes_committed, files_committed)
       values ('user', $1, $2, 1)
       on conflict (subject_type, subject_id) do update set bytes_committed = excluded.bytes_committed`,
      [a.userId, quota - 10],
    );
    const init = await a.call("POST", "/api/v1/shares", {
      destination: "network",
      files: [{ name: "one-too-many.bin", size: 11, type: "application/octet-stream" }],
    });
    expect(init.status).toBe(409);
    expect(init.body.error).toMatchObject({
      code: "STORAGE_QUOTA_EXCEEDED",
      details: { usedBytes: quota - 10, quotaBytes: quota },
    });
  });

  it("the anonymous_uploads_enabled kill switch refuses posts by anonymous users", async () => {
    const a = await Device.create(newNetwork().ip());
    await setFlag("anonymous_uploads_enabled", false);
    try {
      const text = await a.call("POST", "/api/v1/texts", { destination: "network", content: "x" });
      expect(text.status).toBe(503);
      expect(text.body.error.code).toBe("UPLOADS_DISABLED");
    } finally {
      await setFlag("anonymous_uploads_enabled", true);
    }
  });

  it("refuses text above 100 KB", async () => {
    const a = await Device.create(newNetwork().ip());
    const response = await a.call("POST", "/api/v1/texts", { destination: "network", content: "x".repeat(100 * 1024 + 1) });
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe("TEXT_TOO_LARGE");
  });

  it("the uploads_enabled kill switch refuses new uploads", async () => {
    const a = await Device.create(newNetwork().ip());
    await setFlag("uploads_enabled", false);
    try {
      const response = await a.call("POST", "/api/v1/shares", {
        destination: "network",
        files: [{ name: "a.txt", size: 1, type: "text/plain" }],
      });
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("UPLOADS_DISABLED");
    } finally {
      await setFlag("uploads_enabled", true);
    }
  });
});

describe("lying clients (RISK-010)", () => {
  async function initOne(a: Device, size: number) {
    const init = await a.call("POST", "/api/v1/shares", {
      destination: "network",
      files: [{ name: "sized.bin", size, type: "application/octet-stream" }],
    });
    expect(init.status).toBe(201);
    return { shareId: init.body.share.id as string, upload: init.body.uploads[0] as { fileId: string; url: string; headers: Record<string, string> } };
  }

  it("storage refuses a PUT whose size differs from the declared size (signed Content-Length, T-020)", async () => {
    const a = await Device.create(newNetwork().ip());
    const { upload } = await initOne(a, 100);
    expect(new URL(upload.url).searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
    expect(upload.headers).not.toHaveProperty("content-length");
    for (const size of [50, 200]) {
      const put = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: Buffer.alloc(size) });
      expect(put.status, `${size} bytes`).toBe(403);
    }
    expect(await objectExists(objectKeyOf(upload.url))).toBe(false);
  });

  it("objects are write-once: a verified file can't be replaced through its upload URL", async () => {
    const a = await Device.create(newNetwork().ip());
    const { shareId, upload } = await initOne(a, 4);
    expect(upload.headers["if-none-match"]).toBe("*");
    expect((await fetch(upload.url, { method: "PUT", headers: upload.headers, body: Buffer.from("good") })).status).toBe(200);
    expect((await a.call("POST", `/api/v1/shares/${shareId}/files/${upload.fileId}/complete`, {})).status).toBe(200);
    const swap = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: Buffer.from("evil") });
    expect(swap.status).toBe(412);
  });

  it("completion rejects an object stored with headers that were not signed, such as Content-Encoding", async () => {
    const a = await Device.create(newNetwork().ip());
    const { shareId, upload } = await initOne(a, 4);
    const put = await fetch(upload.url, {
      method: "PUT",
      headers: { ...upload.headers, "content-encoding": "gzip" },
      body: Buffer.from("abcd"),
    });
    expect(put.status).toBe(200); // storage accepts the unsigned header; the server must not
    const complete = await a.call("POST", `/api/v1/shares/${shareId}/files/${upload.fileId}/complete`, {});
    expect(complete.status).toBe(422);
    expect(complete.body.error).toMatchObject({ code: "UPLOAD_REJECTED", details: { reason: "metadata_mismatch" } });
    expect(await contentGone(objectKeyOf(upload.url))).toBe(true);
  });

  it("completion still rejects a wrong-sized object: deleted, reservation released, share failed (T-020)", async () => {
    // Defense in depth for storage that does not enforce the signed length: write the object
    // directly with the wrong size, then complete.
    const a = await Device.create(newNetwork().ip());
    const { shareId, upload } = await initOne(a, 100);
    await s3().send(
      new PutObjectCommand({ Bucket: stack().storage.bucket, Key: objectKeyOf(upload.url), Body: Buffer.alloc(50) }),
    );
    const complete = await a.call("POST", `/api/v1/shares/${shareId}/files/${upload.fileId}/complete`, {});
    expect(complete.status).toBe(422);
    expect(complete.body.error).toMatchObject({ code: "UPLOAD_REJECTED", details: { reason: "size_mismatch" } });

    expect(await contentGone(objectKeyOf(upload.url))).toBe(true);
    const usage = await adminDb().query(
      "select bytes_reserved, bytes_committed from app.storage_usage where subject_id = $1",
      [a.userId],
    );
    expect(usage.rows[0]).toEqual({ bytes_reserved: "0", bytes_committed: "0" });
    const share = await adminDb().query("select status from app.shares where id = $1", [shareId]);
    expect(share.rows[0].status).toBe("failed");
  });

  it("storage refuses a PUT whose Content-Type differs from the signed one (T-021)", async () => {
    const a = await Device.create(newNetwork().ip());
    const init = await a.call("POST", "/api/v1/shares", {
      destination: "network",
      files: [{ name: "a.png", size: 8, type: "image/png" }],
    });
    const upload = init.body.uploads[0];
    const put = await fetch(upload.url, {
      method: "PUT",
      headers: { ...upload.headers, "content-type": "text/html" },
      body: Buffer.from(PNG_BYTES.slice(0, 8)),
    });
    expect(put.status).toBe(403);
  });

  it("flags an executable named .png and gives it no preview (T-025)", async () => {
    const pe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, ...new Array(60).fill(0)]);
    const a = await Device.create(newNetwork().ip());
    const { upload, complete } = await a.uploadFile("photo.png", pe, "image/png");
    expect(complete.status).toBe(200);
    expect(complete.body.share.files[0]).toMatchObject({ previewable: false, riskFlags: ["executable"] });
    const preview = await a.call("POST", `/api/v1/files/${upload.fileId}/preview-url`, {});
    expect(preview.status).toBe(422);
    expect(preview.body.error.code).toBe("PREVIEW_UNAVAILABLE");
  });

  it("gives HTML declared as image/png no preview (T-025)", async () => {
    const a = await Device.create(newNetwork().ip());
    const { complete } = await a.uploadFile("x.png", new TextEncoder().encode("<!DOCTYPE html><script>alert(1)</script>"), "image/png");
    expect(complete.body.share.files[0].previewable).toBe(false);
  });

  it("flags double extensions at init", async () => {
    const a = await Device.create(newNetwork().ip());
    const init = await a.call("POST", "/api/v1/shares", {
      destination: "network",
      files: [{ name: "invoice.pdf.exe", size: 2, type: "application/pdf" }],
    });
    expect(init.body.share.files[0].riskFlags).toEqual(["executable", "double_extension"]);
  });
});

describe("previews (T-028, preview part)", () => {
  it("issues 300 s preview URLs for verified raster images only", async () => {
    const net = newNetwork();
    const a = await Device.create(net.ip());
    const { upload, complete } = await a.uploadFile("pic.png", PNG_BYTES, "image/png");
    expect(complete.body.share.files[0].previewable).toBe(true);

    const b = await Device.create(net.ip());
    const preview = await b.call("POST", `/api/v1/files/${upload.fileId}/preview-url`, {});
    expect(preview.status).toBe(200);
    expect(new URL(preview.body.url).searchParams.get("X-Amz-Expires")).toBe("300");
    const image = await fetch(preview.body.url);
    expect(image.headers.get("content-type")).toBe("image/png");

    const text = await a.uploadFile("a.txt", new TextEncoder().encode("hi"), "text/plain");
    const notImage = await a.call("POST", `/api/v1/files/${text.upload.fileId}/preview-url`, {});
    expect(notImage.status).toBe(422);
  });
});

describe("deleting a file share", () => {
  it("removes the content at once and holds the key until the upload URL has expired", async () => {
    const a = await Device.create(newNetwork().ip());
    const { init, upload } = await a.uploadFile("bye.txt", new TextEncoder().encode("bye"), "text/plain");
    const key = objectKeyOf(upload.url);
    expect(await storedObject(key)).toEqual({ size: 3, tombstone: false });

    expect((await a.call("DELETE", `/api/v1/shares/${init.body.share.id}`)).status).toBe(204);
    expect(await storedObject(key)).toEqual({ size: 0, tombstone: true });
    const outbox = await outboxRow(key);
    expect(outbox?.completed_at).toBeNull();
    expect(outbox?.tombstoned_at).not.toBeNull();
    // Held until the URL's expiry plus the clock-skew grace (5 min).
    const file = await adminDb().query("select upload_url_expires_at, object_deleted_at from app.files where id = $1", [upload.fileId]);
    expect(outbox!.not_before.getTime()).toBe(file.rows[0].upload_url_expires_at.getTime() + 5 * 60_000);
    expect(file.rows[0].object_deleted_at).not.toBeNull();
    const usage = await adminDb().query("select bytes_committed from app.storage_usage where subject_id = $1", [a.userId]);
    expect(usage.rows[0].bytes_committed).toBe("0");
  });

  it("deletes the object outright when no upload URL can still be used", async () => {
    const a = await Device.create(newNetwork().ip());
    const { init, upload } = await a.uploadFile("old.txt", new TextEncoder().encode("old"), "text/plain");
    const key = objectKeyOf(upload.url);
    await adminDb().query("update app.files set upload_url_expires_at = now() - interval '10 minutes' where id = $1", [upload.fileId]);

    expect((await a.call("DELETE", `/api/v1/shares/${init.body.share.id}`)).status).toBe(204);
    expect(await storedObject(key)).toBeNull();
    expect((await outboxRow(key))?.completed_at).not.toBeNull();
  });
});

describe("upload URLs after a share ends (review M1 residual)", () => {
  async function initOne(a: Device, size = 4, extraHeaders: Record<string, string> = {}) {
    const init = await a.call(
      "POST",
      "/api/v1/shares",
      { destination: "network", files: [{ name: "late.bin", size, type: "application/octet-stream" }] },
      { headers: extraHeaders },
    );
    expect(init.status).toBe(201);
    return { shareId: init.body.share.id as string, upload: init.body.uploads[0] as { fileId: string; url: string; headers: Record<string, string> } };
  }

  it("a deleted share's upload URL can't put bytes back into storage", async () => {
    const a = await Device.create(newNetwork().ip());
    const { init, upload } = await a.uploadFile("gone.txt", new TextEncoder().encode("gone"), "text/plain");
    const key = objectKeyOf(upload.url);
    expect((await a.call("DELETE", `/api/v1/shares/${init.body.share.id}`)).status).toBe(204);

    const again = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: Buffer.from("evil") });
    expect(again.status).toBe(412);
    expect(await contentGone(key)).toBe(true);
    const complete = await a.call("POST", `/api/v1/shares/${init.body.share.id}/files/${upload.fileId}/complete`, {});
    expect(complete.status).toBe(404);
  });

  it("deleting a share before its bytes arrive (cancel) blocks its upload URL", async () => {
    const a = await Device.create(newNetwork().ip());
    const { shareId, upload } = await initOne(a);
    expect((await a.call("DELETE", `/api/v1/shares/${shareId}`)).status).toBe(204);

    const put = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: Buffer.from("late") });
    expect(put.status).toBe(412);
    expect(await contentGone(objectKeyOf(upload.url))).toBe(true);
    expect((await a.call("POST", `/api/v1/shares/${shareId}/files/${upload.fileId}/complete`, {})).status).toBe(404);
  });

  it("a rejected upload's URL can't store new bytes", async () => {
    const a = await Device.create(newNetwork().ip());
    const { shareId, upload } = await initOne(a);
    await fetch(upload.url, { method: "PUT", headers: { ...upload.headers, "content-encoding": "gzip" }, body: Buffer.from("abcd") });
    expect((await a.call("POST", `/api/v1/shares/${shareId}/files/${upload.fileId}/complete`, {})).status).toBe(422);

    const retry = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: Buffer.from("abcd") });
    expect(retry.status).toBe(412);
    expect(await contentGone(objectKeyOf(upload.url))).toBe(true);
  });

  it("completion is refused after the upload deadline, before the cleanup job has run", async () => {
    const a = await Device.create(newNetwork().ip());
    const { shareId, upload } = await initOne(a);
    expect((await fetch(upload.url, { method: "PUT", headers: upload.headers, body: Buffer.from("slow") })).status).toBe(200);
    await adminDb().query("update app.files set upload_expires_at = now() - interval '1 second' where id = $1", [upload.fileId]);

    const complete = await a.call("POST", `/api/v1/shares/${shareId}/files/${upload.fileId}/complete`, {});
    expect(complete.status).toBe(409);
    expect(complete.body.error.code).toBe("UPLOAD_EXPIRED");
    const state = await adminDb().query(
      "select s.status, f.upload_status from app.shares s join app.files f on f.share_id = s.id where f.id = $1",
      [upload.fileId],
    );
    expect(state.rows[0]).toEqual({ status: "pending_upload", upload_status: "pending" });
  });

  it("completion is refused once the share has expired, before the expiry job has run", async () => {
    const a = await Device.create(newNetwork().ip());
    const { shareId, upload } = await initOne(a);
    expect((await fetch(upload.url, { method: "PUT", headers: upload.headers, body: Buffer.from("past") })).status).toBe(200);
    await adminDb().query("update app.shares set expires_at = now() - interval '1 second' where id = $1", [shareId]);

    expect((await a.call("POST", `/api/v1/shares/${shareId}/files/${upload.fileId}/complete`, {})).status).toBe(404);
    const share = await adminDb().query("select status from app.shares where id = $1", [shareId]);
    expect(share.rows[0].status).toBe("pending_upload");
  });

  it("upload URLs never outlive the upload deadline, and each issue is recorded", async () => {
    const a = await Device.create(newNetwork().ip());
    const headers = { "idempotency-key": crypto.randomUUID() };
    const { shareId, upload } = await initOne(a, 4, headers);
    expect(new URL(upload.url).searchParams.get("X-Amz-Expires")).toBe("900");
    await adminDb().query("update app.files set upload_expires_at = now() + interval '60 seconds' where id = $1", [upload.fileId]);

    const replay = await a.call(
      "POST",
      "/api/v1/shares",
      { destination: "network", files: [{ name: "late.bin", size: 4, type: "application/octet-stream" }] },
      { headers },
    );
    expect(replay.body.share.id).toBe(shareId);
    const ttl = Number(new URL(replay.body.uploads[0].url).searchParams.get("X-Amz-Expires"));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    // The first URL (900 s) is still live, so the record keeps the latest expiry, never a shorter one.
    const file = await adminDb().query(
      "select upload_url_expires_at > now() + interval '14 minutes' as kept_longest from app.files where id = $1",
      [upload.fileId],
    );
    expect(file.rows[0]).toEqual({ kept_longest: true });
  });

  it("refuses to issue upload URLs once the deadline has passed", async () => {
    const a = await Device.create(newNetwork().ip());
    const headers = { "idempotency-key": crypto.randomUUID() };
    const { upload } = await initOne(a, 4, headers);
    await adminDb().query("update app.files set upload_expires_at = now() - interval '1 second' where id = $1", [upload.fileId]);
    const replay = await a.call(
      "POST",
      "/api/v1/shares",
      { destination: "network", files: [{ name: "late.bin", size: 4, type: "application/octet-stream" }] },
      { headers },
    );
    expect(replay.status).toBe(201);
    expect(replay.body.uploads).toEqual([]);
  });

  it("releases a held key once every upload URL has expired (opportunistic sweep)", async () => {
    const a = await Device.create(newNetwork().ip());
    const { init, upload } = await a.uploadFile("held.txt", new TextEncoder().encode("held"), "text/plain");
    const key = objectKeyOf(upload.url);
    expect((await a.call("DELETE", `/api/v1/shares/${init.body.share.id}`)).status).toBe(204);
    expect((await storedObject(key))?.tombstone).toBe(true);

    // Time passes: the URL has expired and the hold is due.
    await adminDb().query("update app.files set upload_url_expires_at = now() - interval '10 minutes' where id = $1", [upload.fileId]);
    await adminDb().query("update app.object_deletions set not_before = now() - interval '1 second' where object_key = $1 and completed_at is null", [key]);

    // Any later deletion runs a small sweep of due storage deletions after its response.
    const other = await a.postText();
    expect((await a.call("DELETE", `/api/v1/shares/${other.id}`)).status).toBe(204);
    // The sweep deletes the object, then marks the outbox row complete: wait for the latter.
    expect(await waitFor(async () => (await outboxRow(key))?.completed_at != null)).toBe(true);
    expect(await storedObject(key)).toBeNull();
  });
});

describe("storage quota race (T-026, DEC-019)", () => {
  it("parallel reservations near the quota never exceed it", async () => {
    const pool = new pg.Pool({ connectionString: LOCAL.appServerDatabaseUrl, max: 20 });
    try {
      const subject = crypto.randomUUID();
      const results = await Promise.all(
        Array.from({ length: 40 }, () =>
          pool.query("select app.reserve_storage('user', $1, null, 10, 100, interval '1 hour') as id", [subject]),
        ),
      );
      const granted = results.filter((r) => r.rows[0].id !== null).length;
      expect(granted).toBe(10);
      const usage = await pool.query("select bytes_reserved from app.storage_usage where subject_id = $1", [subject]);
      expect(usage.rows[0].bytes_reserved).toBe("100");
    } finally {
      await pool.end();
    }
  });
});
