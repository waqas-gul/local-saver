import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "@/lib/client/api-client";
import { ApiRequestError } from "@/lib/client/api-error";
import {
  PartUploadError,
  UploadCancelledError,
  UploadPausedError,
  uploadMultipart,
  type PutPart,
} from "@/lib/client/uploader-multipart";
import type { MultipartUploadTarget } from "@/lib/shared/api/schemas";

/**
 * The browser side of multipart uploads (phase 4 §17.8.1, P4-14), with a fake API and a fake storage PUT:
 * which parts go, with how many bytes, URLs fetched in batches before they are needed, retries on network
 * errors, a pause after too many, and a cancel that stops everything.
 */

const SHARE = "11111111-1111-4111-8111-111111111111";
const FILE = "22222222-2222-4222-8222-222222222222";
// 40 parts of 16 MiB would be a 640 MiB blob: the fakes never read it, so a small part size keeps it light.
const target = (partCount: number, partSize = 16, last = 16): MultipartUploadTarget => ({
  fileId: FILE,
  name: "big.bin",
  sizeBytes: partSize * (partCount - 1) + last,
  method: "MULTIPART",
  partSize,
  partCount,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
});
const blobOf = (t: MultipartUploadTarget) => new Blob([new Uint8Array(t.sizeBytes)]);

function fakeApi(options: { expiresInMs?: number; fail?: (call: number) => Error | null } = {}) {
  const requests: number[][] = [];
  const api: ApiClient = {
    async request<T>(method: string, path: string, opts?: { body?: unknown }): Promise<T> {
      expect(method).toBe("POST");
      expect(path).toBe(`/api/v1/shares/${SHARE}/files/${FILE}/multipart/parts`);
      const { partNumbers } = opts?.body as { partNumbers: number[] };
      requests.push(partNumbers);
      const failure = options.fail?.(requests.length);
      if (failure) throw failure;
      const expiresAt = new Date(Date.now() + (options.expiresInMs ?? 3_600_000)).toISOString();
      return { parts: partNumbers.map((n) => ({ partNumber: n, url: `https://storage.test/part/${n}?v=${requests.length}`, size: 1, expiresAt })) } as T;
    },
  };
  return { api, requests };
}

function fakeStorage(behaviour: (url: string, attempt: number) => Error | null = () => null) {
  const sent: { url: string; bytes: number }[] = [];
  const attempts = new Map<string, number>();
  let active = 0;
  let maxActive = 0;
  const putPart: PutPart = async (url, body, onProgress, signal) => {
    const part = url.split("?")[0] as string;
    const attempt = (attempts.get(part) ?? 0) + 1;
    attempts.set(part, attempt);
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      await new Promise((r) => setTimeout(r, 1));
      if (signal.aborted) throw new UploadCancelledError();
      const failure = behaviour(url, attempt);
      if (failure) throw failure;
      onProgress(body.size);
      sent.push({ url, bytes: body.size });
    } finally {
      active--;
    }
  };
  return { putPart, sent, attempts, maxActive: () => maxActive };
}

const noWait = { sleep: async () => {}, online: async () => {} };

describe("uploading the parts", () => {
  it("sends every part once with exactly its bytes, 4 at a time, asking for URLs 20 at a time", async () => {
    const t = target(45, 16, 5);
    const { api, requests } = fakeApi();
    const storage = fakeStorage();
    const progress: number[] = [];
    await uploadMultipart({ api, shareId: SHARE, target: t, file: blobOf(t), onProgress: (n) => progress.push(n), signal: new AbortController().signal, deps: { ...noWait, putPart: storage.putPart } });

    expect(storage.sent).toHaveLength(45);
    expect(new Set(storage.sent.map((s) => s.url.split("?")[0])).size).toBe(45);
    expect(storage.sent.find((s) => s.url.includes("/part/45?"))?.bytes).toBe(5);
    expect(storage.sent.filter((s) => s.bytes === 16)).toHaveLength(44);
    expect(storage.maxActive()).toBe(4);
    expect(requests.every((r) => r.length <= 20)).toBe(true);
    expect(requests.flat().sort((a, b) => a - b)).toEqual(Array.from({ length: 45 }, (_, i) => i + 1));
    expect(progress.at(-1)).toBe(t.sizeBytes);
  });

  it("sends only what storage doesn't have, and counts the rest as done (resume)", async () => {
    const t = target(6);
    const { api, requests } = fakeApi();
    const storage = fakeStorage();
    const progress: number[] = [];
    await uploadMultipart({
      api,
      shareId: SHARE,
      target: t,
      file: blobOf(t),
      uploaded: new Set([1, 2, 5]),
      onProgress: (n) => progress.push(n),
      signal: new AbortController().signal,
      deps: { ...noWait, putPart: storage.putPart },
    });
    expect(storage.sent.map((s) => Number(/part\/(\d+)/.exec(s.url)?.[1])).sort()).toEqual([3, 4, 6]);
    expect(requests.flat().sort()).toEqual([3, 4, 6]);
    expect(progress[0]).toBe(48);
    expect(progress.at(-1)).toBe(96);
  });

  it("asks for a new URL before an old one runs out", async () => {
    const t = target(3);
    // URLs that expire in a minute are inside the 2-minute margin: never used, always replaced.
    let call = 0;
    const api: ApiClient = {
      async request<T>(_m: string, _p: string, opts?: { body?: unknown }): Promise<T> {
        call++;
        const { partNumbers } = opts?.body as { partNumbers: number[] };
        const expiresAt = new Date(Date.now() + (call === 1 ? 60_000 : 3_600_000)).toISOString();
        return { parts: partNumbers.map((n) => ({ partNumber: n, url: `https://storage.test/part/${n}?v=${call}`, size: 1, expiresAt })) } as T;
      },
    };
    const storage = fakeStorage();
    await uploadMultipart({ api, shareId: SHARE, target: t, file: blobOf(t), onProgress: () => {}, signal: new AbortController().signal, deps: { ...noWait, putPart: storage.putPart } });
    expect(storage.sent.every((s) => !s.url.endsWith("v=1"))).toBe(true);
  });
});

describe("network trouble", () => {
  it("retries a part after a network error or a storage hiccup, with a fresh URL after a 403", async () => {
    const t = target(3);
    const { api, requests } = fakeApi();
    const storage = fakeStorage((url, attempt) => {
      if (url.includes("/part/1?") && attempt === 1) return new PartUploadError(0);
      if (url.includes("/part/2?") && attempt === 1) return new PartUploadError(503);
      if (url.includes("/part/3?") && attempt === 1) return new PartUploadError(403);
      return null;
    });
    const waits: number[] = [];
    await uploadMultipart({
      api,
      shareId: SHARE,
      target: t,
      file: blobOf(t),
      onProgress: () => {},
      signal: new AbortController().signal,
      deps: { putPart: storage.putPart, online: async () => {}, sleep: async (ms) => void waits.push(ms) },
    });
    expect(storage.sent).toHaveLength(3);
    expect(waits).toEqual([1000, 1000, 1000]);
    // Part 3's refused URL was replaced by a new request for it.
    expect(requests.filter((r) => r.includes(3)).length).toBe(2);
  });

  it("pauses after five retries of a part, without failing the upload", async () => {
    const t = target(2);
    const { api } = fakeApi();
    const storage = fakeStorage((url) => (url.includes("/part/2?") ? new PartUploadError(0) : null));
    const waits: number[] = [];
    let online = 0;
    await expect(
      uploadMultipart({
        api,
        shareId: SHARE,
        target: t,
        file: blobOf(t),
        onProgress: () => {},
        signal: new AbortController().signal,
        deps: { putPart: storage.putPart, online: async () => void online++, sleep: async (ms) => void waits.push(ms) },
      }),
    ).rejects.toBeInstanceOf(UploadPausedError);
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(online).toBe(5);
    expect(storage.attempts.get("https://storage.test/part/2")).toBe(6);
  });

  it("stops at a refusal that waiting won't fix (the upload expired or was rejected)", async () => {
    const t = target(2);
    const { api } = fakeApi({ fail: () => new ApiRequestError(409, "UPLOAD_EXPIRED", "expired") });
    const storage = fakeStorage();
    await expect(
      uploadMultipart({ api, shareId: SHARE, target: t, file: blobOf(t), onProgress: () => {}, signal: new AbortController().signal, deps: { ...noWait, putPart: storage.putPart } }),
    ).rejects.toMatchObject({ code: "UPLOAD_EXPIRED" });
    expect(storage.sent).toHaveLength(0);
  });

  it("a cancel stops every part in flight and sends nothing more", async () => {
    const t = target(20);
    const { api } = fakeApi();
    const controller = new AbortController();
    const storage = fakeStorage((_url, _attempt) => {
      controller.abort();
      return null;
    });
    await expect(
      uploadMultipart({ api, shareId: SHARE, target: t, file: blobOf(t), onProgress: () => {}, signal: controller.signal, deps: { ...noWait, putPart: storage.putPart } }),
    ).rejects.toBeInstanceOf(UploadCancelledError);
    expect(storage.sent.length).toBeLessThan(5);
  });
});

describe("the web tier never deletes or aborts (D-1)", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }

  it("no app or lib code uses a destructive storage command: the janitor alone runs them", () => {
    const offenders = [...sources("lib"), ...sources("app")].filter((path) =>
      /\b(DeleteObjectCommand|DeleteObjectsCommand|AbortMultipartUploadCommand|PutBucketLifecycleConfigurationCommand)\b/.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
