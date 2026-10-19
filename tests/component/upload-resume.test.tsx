import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UploadQueue } from "@/components/local/upload-queue";
import type { ApiClient } from "@/lib/client/api-client";
import { ApiRequestError } from "@/lib/client/api-error";
import { SessionStore, UploadsStore } from "@/lib/client/stores/session";
import { createUploadsStore } from "@/lib/client/stores/uploads";
import { readResume, saveResume, type ResumeEntry } from "@/lib/client/upload-resume";
import { cancelUpload, PutFailedError, restoreUploads, resumeUpload, uploadFiles } from "@/lib/client/uploader";
import { PartUploadError, type PutPart } from "@/lib/client/uploader-multipart";

/**
 * Large uploads in the browser (phase 4 §17.8.1, P4-14): a lost connection pauses the upload and Resume
 * (or coming back online) continues it; Cancel ends it on the server; after a reload the upload comes back
 * waiting for its file, which is checked against the original before anything is sent (D4-25). Storage's
 * part list (GET …/multipart) decides what is left.
 */

const runtimeMock = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/client/runtime", () => ({ useRuntime: () => runtimeMock.current }));

const MiB = 1024 * 1024;
const SIZE = 120 * MiB; // 8 parts of 16 MiB
const PART = 16 * MiB;
const SHARE = "33333333-3333-4333-8333-333333333333";
const FILE = "44444444-4444-4444-8444-444444444444";
const DEVICE = { id: "d1", label: "Laptop", platform: "Windows" };
const LAST_MODIFIED = 1_760_000_000_000;

/** A File stand-in: the uploader reads its size and slices it; 120 MiB of real bytes would be wasted here. */
function bigFile(name = "big.bin", size = SIZE, lastModified = LAST_MODIFIED): File {
  return { name, size, type: "application/octet-stream", lastModified, slice: (start: number, end: number) => new Blob([new Uint8Array(end - start > 0 ? 1 : 0)]) } as unknown as File;
}

const share = (status: "pending_upload" | "active") => ({
  id: SHARE,
  kind: "files",
  scope: "network",
  status,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  isMine: true,
  fromLabel: "Laptop",
  text: null,
  files: [{ id: FILE, name: "big.bin", sizeBytes: SIZE, type: "application/octet-stream", status: status === "active" ? "verified" : "pending", previewable: false, riskFlags: [] }],
  fileCount: 1,
  totalBytes: SIZE,
});

type Call = { method: string; path: string; body?: unknown };

/** The server for one 8-part upload; `stored` is what storage holds. */
function fakeServer(options: { stored?: number[]; statusError?: Error } = {}) {
  const stored = new Set(options.stored ?? []);
  const calls: Call[] = [];
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const api: ApiClient = {
    request: vi.fn(async (method: string, path: string, opts?: { body?: unknown }) => {
      calls.push({ method, path, body: opts?.body });
      const file = `/api/v1/shares/${SHARE}/files/${FILE}`;
      if (method === "POST" && path === "/api/v1/shares") {
        return { share: share("pending_upload"), uploads: [{ fileId: FILE, name: "big.bin", sizeBytes: SIZE, method: "MULTIPART", partSize: PART, partCount: 8, expiresAt }] };
      }
      if (method === "GET" && path === `${file}/multipart`) {
        if (options.statusError) throw options.statusError;
        return { partSize: PART, partCount: 8, expiresAt, uploaded: [...stored].map((n) => ({ partNumber: n, size: PART })) };
      }
      if (method === "POST" && path === `${file}/multipart/parts`) {
        const { partNumbers } = opts?.body as { partNumbers: number[] };
        return { parts: partNumbers.map((n) => ({ partNumber: n, url: `https://storage.test/p/${n}`, size: PART, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })) };
      }
      if (method === "POST" && path === `${file}/complete`) return { share: share("active") };
      if (method === "POST" && path === `${file}/multipart/abort`) return undefined;
      throw new Error(`unexpected ${method} ${path}`);
    }) as ApiClient["request"],
  };
  const putPart: PutPart = async (url, _body, onProgress) => {
    stored.add(Number(url.split("/").pop()));
    onProgress(PART);
  };
  return { api, calls, stored, putPart };
}

const noWait = { sleep: async () => {}, online: async () => {} };
const entry = (extra: Partial<ResumeEntry> = {}): ResumeEntry => ({
  userId: "u1",
  shareId: SHARE,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  files: [{ fileId: FILE, name: "big.bin", size: SIZE, lastModified: LAST_MODIFIED, multipart: true }],
  ...extra,
});

function Ready({ userId, children }: { userId: string; children: ReactNode }) {
  const store = SessionStore.useStoreApi();
  const [ready] = useState(() => {
    store.getState().ready(userId, DEVICE, false);
    return true;
  });
  return ready ? children : null;
}

function renderQueue(api: ApiClient, userId = "u1") {
  runtimeMock.current = { api, supabase: {} };
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionStore.Provider>
        <UploadsStore.Provider>
          <Ready userId={userId}>
            <UploadQueue />
          </Ready>
        </UploadsStore.Provider>
      </SessionStore.Provider>
    </QueryClientProvider>,
  );
}

let userSeq = 0;
beforeEach(() => window.localStorage.clear());
afterEach(() => {
  runtimeMock.current = null;
});

describe("pause, resume and cancel while the file is still in the page", () => {
  it("a lost connection pauses the upload; Resume sends only what storage is missing, then completes", async () => {
    const server = fakeServer();
    const uploads = createUploadsStore();
    let failing = true;
    const putPart: PutPart = async (url, body, onProgress, signal) => {
      if (failing && Number(url.split("/").pop()) > 3) throw new PartUploadError(0);
      return server.putPart(url, body, onProgress, signal);
    };
    const done = uploadFiles({ api: server.api, files: [bigFile()], expiresIn: 86_400, uploads, onFinished: () => {}, deps: { ...noWait, putPart } });
    await waitFor(() => expect(uploads.getState().items[0]?.status).toBe("paused"));
    expect(server.stored.size).toBeLessThan(8);

    failing = false;
    resumeUpload(uploads.getState().items[0]?.batchId as string);
    expect((await done)?.status).toBe("active");
    expect(server.stored.size).toBe(8);
    expect(uploads.getState().items[0]).toMatchObject({ status: "done", loaded: SIZE });
    // After the pause, storage's list was asked again before anything more was sent.
    expect(server.calls.filter((c) => c.method === "GET").length).toBeGreaterThanOrEqual(2);
  });

  it("Cancel stops the upload and ends it on the server; nothing is kept to resume", async () => {
    const server = fakeServer();
    const uploads = createUploadsStore();
    const owner = `u-cancel-${userSeq++}`;
    const putPart: PutPart = (url, body, onProgress, signal) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    const done = uploadFiles({ api: server.api, files: [bigFile()], expiresIn: 86_400, uploads, resumeOwner: async () => owner, onFinished: () => {}, deps: { ...noWait, putPart } });
    await waitFor(() => expect(readResume(owner)).toHaveLength(1));
    await waitFor(() => expect(server.calls.some((c) => c.path.endsWith("/multipart/parts"))).toBe(true));
    cancelUpload(uploads.getState().items[0]?.batchId as string);
    expect(await done).toBeNull();
    expect(server.calls.at(-1)).toMatchObject({ method: "POST", path: `/api/v1/shares/${SHARE}/files/${FILE}/multipart/abort` });
    expect(uploads.getState().items[0]).toMatchObject({ status: "error", error: "Cancelled." });
    expect(readResume(owner)).toEqual([]);
  });

  it("a small file of the same share pauses on a lost connection too, and goes on with a fresh URL", async () => {
    const SMALL = "88888888-8888-4888-8888-888888888888";
    const server = fakeServer({ stored: [1, 2, 3, 4, 5, 6, 7, 8] });
    const calls: Call[] = [];
    const api: ApiClient = {
      request: vi.fn(async (method: string, path: string, opts?: { body?: unknown }) => {
        calls.push({ method, path, body: opts?.body });
        const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
        const put = { fileId: SMALL, name: "note.txt", sizeBytes: 5, url: "https://storage.test/put", method: "PUT", headers: {}, expiresAt };
        if (method === "POST" && path === "/api/v1/shares") {
          const init = (await server.api.request(method, path, opts)) as { share: unknown; uploads: unknown[] };
          return { share: init.share, uploads: [put, ...init.uploads] };
        }
        if (path === `/api/v1/shares/${SHARE}/files/${SMALL}/upload-url`) return { upload: put };
        if (path === `/api/v1/shares/${SHARE}/files/${SMALL}/complete`) return { share: share("pending_upload") };
        return server.api.request(method, path, opts);
      }) as ApiClient["request"],
    };
    const uploads = createUploadsStore();
    let failing = true;
    const putFile = async () => {
      if (failing) throw new PutFailedError(0);
    };
    const small = { name: "note.txt", size: 5, type: "text/plain", lastModified: LAST_MODIFIED, slice: () => new Blob() } as unknown as File;
    const done = uploadFiles({ api, files: [small, bigFile()], expiresIn: 86_400, uploads, onFinished: () => {}, deps: { ...noWait, putPart: server.putPart, putFile } });
    await waitFor(() => expect(uploads.getState().items[0]?.status).toBe("paused"));
    failing = false;
    resumeUpload(uploads.getState().items[0]?.batchId as string);
    expect((await done)?.status).toBe("active");
    expect(uploads.getState().items.map((i) => i.status)).toEqual(["done", "done"]);
    // The retry asked for a fresh URL instead of reusing the one that failed.
    expect(calls.filter((c) => c.path.endsWith(`${SMALL}/upload-url`))).toHaveLength(1);
  });

  it("remembers the pending files while the upload runs, and forgets them once it completes", async () => {
    const server = fakeServer();
    const owner = `u-done-${userSeq++}`;
    const uploads = createUploadsStore();
    let seen: ResumeEntry[] = [];
    const putPart: PutPart = async (url, body, onProgress, signal) => {
      seen = readResume(owner);
      return server.putPart(url, body, onProgress, signal);
    };
    await uploadFiles({ api: server.api, files: [bigFile()], expiresIn: 86_400, uploads, resumeOwner: async () => owner, onFinished: () => {}, deps: { ...noWait, putPart } });
    expect(seen).toEqual([expect.objectContaining({ shareId: SHARE, userId: owner, files: [expect.objectContaining({ fileId: FILE, size: SIZE, lastModified: LAST_MODIFIED, multipart: true })] })]);
    expect(readResume(owner)).toEqual([]);
  });
});

describe("after a reload (D4-25)", () => {
  it("brings back this user's unfinished upload, waiting for its file, with what storage already holds", async () => {
    const userId = `u-restore-${userSeq++}`;
    saveResume(entry({ userId }));
    saveResume(entry({ userId: "someone-else", shareId: "55555555-5555-4555-8555-555555555555" }));
    const server = fakeServer({ stored: [1, 2, 3] });
    renderQueue(server.api, userId);
    expect(await screen.findByText(/Choose the file again to finish/)).toBeTruthy();
    expect(screen.getAllByTestId("upload-batch")).toHaveLength(1);
    // 3 of 8 parts (48 of 120 MiB) are in storage: 40 %.
    expect(document.querySelector<HTMLElement>('[data-slot="progress-indicator"]')?.style.transform).toBe("translateX(-60%)");
    expect(screen.getByTestId("upload-pick")).toBeTruthy();
    expect(screen.getByTestId("upload-cancel")).toBeTruthy();
  });

  it("refuses a file of another size, and asks before using one with another name or date", async () => {
    const userId = `u-pick-${userSeq++}`;
    saveResume(entry({ userId }));
    // Everything is already in storage: once a file is accepted, only the completion is left.
    const server = fakeServer({ stored: [1, 2, 3, 4, 5, 6, 7, 8] });
    renderQueue(server.api, userId);
    const input = await screen.findByTestId("upload-pick");

    fireEvent.change(input, { target: { files: [bigFile("big.bin", SIZE - 1)] } });
    expect(await screen.findByText("Choose “big.bin” (120 MB).")).toBeTruthy();
    expect(server.calls.some((c) => c.path.endsWith("/complete"))).toBe(false);

    fireEvent.change(input, { target: { files: [bigFile("renamed.bin", SIZE, LAST_MODIFIED + 1)] } });
    expect(await screen.findByText("This doesn't look like the file you started with.")).toBeTruthy();
    expect(server.calls.some((c) => c.path.endsWith("/complete"))).toBe(false);
    fireEvent.click(screen.getByTestId("upload-continue"));
    await waitFor(() => expect(server.calls.some((c) => c.path.endsWith("/complete"))).toBe(true));
    expect(await screen.findByText(/Shared/)).toBeTruthy();
    expect(readResume(userId)).toEqual([]);
  });

  it("the same file continues at once: only the missing parts go", async () => {
    const userId = `u-same-${userSeq++}`;
    saveResume(entry({ userId }));
    const server = fakeServer({ stored: [1, 2, 3, 4, 5, 6] });
    const uploads = createUploadsStore();
    await restoreUploads({ api: server.api, uploads, userId, onFinished: () => {}, deps: { ...noWait, putPart: server.putPart } });
    const batchId = uploads.getState().items[0]?.batchId as string;
    const { provideUploadFiles } = await import("@/lib/client/uploader");
    act(() => provideUploadFiles(batchId, [bigFile()]));
    await waitFor(() => expect(uploads.getState().items[0]?.status).toBe("done"));
    const parts = server.calls.filter((c) => c.path.endsWith("/multipart/parts")).flatMap((c) => (c.body as { partNumbers: number[] }).partNumbers);
    expect(parts.sort()).toEqual([7, 8]);
  });

  it("Cancel on an upload waiting for its file ends it on the server", async () => {
    const userId = `u-cancel-restore-${userSeq++}`;
    saveResume(entry({ userId }));
    const server = fakeServer({ stored: [1] });
    renderQueue(server.api, userId);
    fireEvent.click(await screen.findByTestId("upload-cancel"));
    await waitFor(() => expect(server.calls.at(-1)).toMatchObject({ method: "POST", path: `/api/v1/shares/${SHARE}/files/${FILE}/multipart/abort` }));
    expect(await screen.findByText("Cancelled.")).toBeTruthy();
    expect(readResume(userId)).toEqual([]);
  });

  it("restores each upload once, even when another one is gone and the queue asks again", async () => {
    const userId = `u-twice-${userSeq++}`;
    const GONE = "66666666-6666-4666-8666-666666666666";
    saveResume(entry({ userId }));
    saveResume(entry({ userId, shareId: GONE, files: [{ fileId: "77777777-7777-4777-8777-777777777777", name: "old.bin", size: SIZE, lastModified: 1, multipart: true }] }));
    const server = fakeServer({ stored: [1] });
    const api: ApiClient = {
      request: vi.fn(async (method: string, path: string, opts?: { body?: unknown }) => {
        if (path.includes(GONE)) throw new ApiRequestError(404, "NOT_FOUND", "Not found");
        return server.api.request(method, path, opts);
      }) as ApiClient["request"],
    };
    const uploads = createUploadsStore();
    await restoreUploads({ api, uploads, userId, onFinished: () => {} });
    await restoreUploads({ api, uploads, userId, onFinished: () => {} });
    expect(uploads.getState().items.map((i) => i.name)).toEqual(["big.bin"]);
    expect(readResume(userId).map((e) => e.shareId)).toEqual([SHARE]);
  });

  it("forgets an upload that can no longer finish (expired, rejected or gone)", async () => {
    const userId = `u-gone-${userSeq++}`;
    saveResume(entry({ userId }));
    const server = fakeServer({ statusError: new ApiRequestError(409, "UPLOAD_EXPIRED", "expired") });
    const uploads = createUploadsStore();
    await restoreUploads({ api: server.api, uploads, userId, onFinished: () => {} });
    expect(uploads.getState().items).toEqual([]);
    expect(readResume(userId)).toEqual([]);
  });

  it("keeps it for the next load when the server can't be reached", async () => {
    const userId = `u-offline-${userSeq++}`;
    saveResume(entry({ userId }));
    const server = fakeServer({ statusError: new TypeError("Failed to fetch") });
    await restoreUploads({ api: server.api, uploads: createUploadsStore(), userId, onFinished: () => {} });
    expect(readResume(userId)).toHaveLength(1);
  });

  it("drops entries past their deadline, and ignores storage it can't read", () => {
    saveResume(entry({ userId: "u-old", expiresAt: new Date(Date.now() - 1000).toISOString() }));
    expect(readResume("u-old")).toEqual([]);
    window.localStorage.setItem("localsaver.upload-resume.v1", "{not json");
    expect(readResume("u1")).toEqual([]);
    window.localStorage.setItem("localsaver.upload-resume.v1", JSON.stringify([{ userId: "u1", shareId: "not-a-uuid" }]));
    expect(readResume("u1")).toEqual([]);
  });
});
