import { describe, expect, it } from "vitest";
import { createFetchStorage, StorageError } from "../../supabase/functions/_shared/s3-fetch";

/**
 * The Edge Function's storage adapter (phase 3 §17.5): plain S3 REST calls over a signed fetch
 * (aws4fetch in Deno, D-8). Real calls are covered by the janitor integration tests; here the
 * requests it builds and the XML it reads.
 */

const KEY = "d7/2026/10/16/00000000-0000-4000-8000-000000000001";

function fake(responses: Response[]) {
  const requests: { url: string; method: string; headers: Record<string, string>; body: string | null }[] = [];
  const signed = async (input: string, init: RequestInit = {}) => {
    requests.push({
      url: input,
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body === undefined || init.body === null ? null : String(init.body instanceof Uint8Array ? `<${init.body.length} bytes>` : init.body),
    });
    return responses.shift() ?? new Response(null, { status: 500 });
  };
  const storage = createFetchStorage({ endpoint: "http://local-saver-s3:9000", bucket: "b", fetch: signed });
  return { storage, requests };
}

describe("fetch storage", () => {
  it("deletes by key; a missing key is fine", async () => {
    const { storage, requests } = fake([new Response(null, { status: 204 }), new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })]);
    await storage.deleteObject(KEY);
    await storage.deleteObject(KEY);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([`DELETE http://local-saver-s3:9000/b/${KEY}`, `DELETE http://local-saver-s3:9000/b/${KEY}`]);
  });

  it("raises S3 errors with status and code, never the key", async () => {
    const { storage } = fake([new Response("<Error><Code>SlowDown</Code><Key>secret</Key></Error>", { status: 503 })]);
    const error = await storage.deleteObject(KEY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect(error).toMatchObject({ status: 503, code: "SlowDown" });
    expect(String((error as Error).message)).not.toContain(KEY);
  });

  it("writes an empty, unconditional tombstone with no-store", async () => {
    const { storage, requests } = fake([new Response(null, { status: 200 })]);
    await storage.putTombstone(KEY);
    expect(requests[0]).toMatchObject({
      method: "PUT",
      url: `http://local-saver-s3:9000/b/${KEY}`,
      headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "x-amz-meta-tombstone": "1" },
      body: "<0 bytes>",
    });
    expect(requests[0]?.headers["if-none-match"]).toBeUndefined();
  });

  it("refuses keys that aren't generated keys before any request", async () => {
    const { storage, requests } = fake([]);
    await expect(storage.deleteObject("../other-bucket/x")).rejects.toThrow(/invalid object key/);
    await expect(storage.putTombstone("d7/2026/10/16/a?b")).rejects.toThrow(/invalid object key/);
    await expect(storage.putTombstone(`hold/${KEY}`)).rejects.toThrow(/invalid object key/);
    await expect(storage.copyObject(KEY, `hold/d7/2026/10/16/00000000-0000-4000-8000-000000000002`)).rejects.toThrow(/invalid object key/);
    await expect(storage.copyObject(`hold/${KEY}`, `hold/hold/${KEY}`)).rejects.toThrow(/invalid object key/);
    await expect(storage.copyObject(KEY, KEY)).rejects.toThrow(/invalid object key/);
    await expect(storage.objectExists("../x")).rejects.toThrow(/invalid object key/);
    expect(requests).toEqual([]);
  });

  it("copies an object to its hold/ twin server-side, keeping its stored headers (D-2, RISK-031)", async () => {
    const ok = `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"abc"</ETag><LastModified>2026-10-16T08:00:00.000Z</LastModified></CopyObjectResult>`;
    const { storage, requests } = fake([new Response(ok, { status: 200 })]);
    expect(await storage.copyObject(KEY, `hold/${KEY}`)).toBe("copied");
    expect(requests[0]).toMatchObject({
      method: "PUT",
      url: `http://local-saver-s3:9000/b/hold/${KEY}`,
      headers: { "x-amz-copy-source": `/b/${KEY}`, "x-amz-metadata-directive": "COPY" },
    });
  });

  it("a missing source is reported, a missing bucket and an error inside a 200 are errors", async () => {
    const { storage } = fake([
      new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }),
      new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 }),
      new Response("<?xml version=\"1.0\"?><Error><Code>InternalError</Code><Message>copy failed</Message></Error>", { status: 200 }),
    ]);
    expect(await storage.copyObject(KEY, `hold/${KEY}`)).toBe("missing");
    await expect(storage.copyObject(KEY, `hold/${KEY}`)).rejects.toMatchObject({ status: 404, code: "NoSuchBucket" });
    // S3 can report a failed copy inside a 200 response; it must not count as copied.
    await expect(storage.copyObject(KEY, `hold/${KEY}`)).rejects.toMatchObject({ status: 200, code: "InternalError" });
  });

  it("checks whether a key exists with HEAD; other failures are errors", async () => {
    const { storage, requests } = fake([
      new Response(null, { status: 200 }),
      new Response(null, { status: 404 }),
      new Response(null, { status: 403 }),
    ]);
    expect(await storage.objectExists(`hold/${KEY}`)).toBe(true);
    expect(await storage.objectExists(KEY)).toBe(false);
    await expect(storage.objectExists(KEY)).rejects.toMatchObject({ status: 403 });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `HEAD http://local-saver-s3:9000/b/hold/${KEY}`,
      `HEAD http://local-saver-s3:9000/b/${KEY}`,
      `HEAD http://local-saver-s3:9000/b/${KEY}`,
    ]);
  });

  it("deletes hold copies once a hold is released", async () => {
    const { storage, requests } = fake([new Response(null, { status: 204 })]);
    await storage.deleteObject(`hold/${KEY}`);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([`DELETE http://local-saver-s3:9000/b/hold/${KEY}`]);
  });

  it("lists with start-after and reads keys, dates and truncation", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name><KeyCount>2</KeyCount><MaxKeys>1000</MaxKeys>
<IsTruncated>true</IsTruncated>
<Contents><Key>${KEY}</Key><LastModified>2026-10-14T08:00:00.000Z</LastModified><Size>3</Size></Contents>
<Contents><Key>notes/a&amp;b.txt</Key><LastModified>2026-10-15T08:00:00.000Z</LastModified><Size>1</Size></Contents>
</ListBucketResult>`;
    const { storage, requests } = fake([new Response(xml, { status: 200 })]);
    const page = await storage.listObjects("d30/2026/x y", 1000);
    expect(requests[0]?.url).toBe("http://local-saver-s3:9000/b?list-type=2&max-keys=1000&start-after=d30%2F2026%2Fx%20y");
    expect(page).toEqual({
      truncated: true,
      keys: [
        { key: KEY, lastModified: new Date("2026-10-14T08:00:00.000Z") },
        { key: "notes/a&b.txt", lastModified: new Date("2026-10-15T08:00:00.000Z") },
      ],
    });
  });

  it("lists and aborts multipart uploads", async () => {
    const xml = `<ListMultipartUploadsResult><Bucket>b</Bucket><IsTruncated>false</IsTruncated>
<Upload><Key>${KEY}</Key><UploadId>abc/123</UploadId><Initiated>2026-10-14T08:00:00.000Z</Initiated></Upload></ListMultipartUploadsResult>`;
    const { storage, requests } = fake([new Response(xml, { status: 200 }), new Response(null, { status: 204 })]);
    expect(await storage.listMultipartUploads()).toEqual([{ key: KEY, uploadId: "abc/123", initiated: new Date("2026-10-14T08:00:00.000Z") }]);
    await storage.abortMultipartUpload(KEY, "abc/123");
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET http://local-saver-s3:9000/b?uploads",
      `DELETE http://local-saver-s3:9000/b/${KEY}?uploadId=abc%2F123`,
    ]);
  });
});
