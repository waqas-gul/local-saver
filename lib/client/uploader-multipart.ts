import { multipartStatusResponse, partUrlsResponse, type MultipartUploadTarget } from "@/lib/shared/api/schemas";
import { partRange } from "@/lib/shared/multipart";
import type { ApiClient } from "./api-client";
import { ApiRequestError } from "./api-error";

/**
 * Multipart uploads in the browser (phase 4 §17.8.1, P4-14). The server planned the parts; this sends
 * the ones storage doesn't have yet, 4 at a time, each to its own presigned URL with exactly its bytes
 * (the size is part of the signature). Part URLs come 20 at a time, just before they are needed, so
 * none expires on a slow link. A part that fails for a network reason is retried with backoff, waiting
 * for the browser to come back online; after that the upload pauses (UploadPausedError) and can go on
 * later with the same File, or after a reload once the user picks it again. Storage's part list
 * (GET …/multipart) is the truth for what is uploaded. URLs stay in local variables (DEC-034).
 */

const PROGRESS_INTERVAL_MS = 100;
const URL_MARGIN_MS = 2 * 60_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

/** The network failed too often: the upload can go on later. */
export class UploadPausedError extends Error {
  constructor() {
    super("Upload paused: the connection was lost");
    this.name = "UploadPausedError";
  }
}

/** The user cancelled (or the page is going away). */
export class UploadCancelledError extends Error {
  constructor() {
    super("Upload cancelled");
    this.name = "UploadCancelledError";
  }
}

/** A part's PUT failed: status 0 for a network error. */
export class PartUploadError extends Error {
  constructor(readonly status: number) {
    super(`Part upload failed (${status})`);
    this.name = "PartUploadError";
  }
}

export type PutPart = (url: string, body: Blob, onProgress: (loaded: number) => void, signal: AbortSignal) => Promise<void>;

/** XMLHttpRequest, for upload progress (fetch has none). */
export const xhrPutPart: PutPart = (url, body, onProgress, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new UploadCancelledError());
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    let last = 0;
    xhr.upload.onprogress = (event) => {
      const now = Date.now();
      if (now - last >= PROGRESS_INTERVAL_MS || event.loaded === event.total) {
        last = now;
        onProgress(event.loaded);
      }
    };
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new PartUploadError(xhr.status)));
    xhr.onerror = () => reject(new PartUploadError(0));
    xhr.onabort = () => reject(new UploadCancelledError());
    xhr.send(body);
  });

export type MultipartDeps = {
  putPart?: PutPart;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Resolves when the browser is (back) online. */
  online?: (signal: AbortSignal) => Promise<void>;
  now?: () => number;
};

function abortable(signal: AbortSignal, register: (done: () => void) => () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new UploadCancelledError());
    const onAbort = () => {
      cleanup();
      reject(new UploadCancelledError());
    };
    const cleanup = register(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  abortable(signal, (done) => {
    const timer = setTimeout(done, ms);
    return () => clearTimeout(timer);
  });

const defaultOnline = (signal: AbortSignal) =>
  typeof navigator === "undefined" || navigator.onLine
    ? Promise.resolve()
    : abortable(signal, (done) => {
        window.addEventListener("online", done, { once: true });
        return () => window.removeEventListener("online", done);
      });

/** Network errors and storage hiccups are worth another try; refusals are not. */
function retryable(error: unknown): boolean {
  if (error instanceof PartUploadError) return error.status === 0 || error.status === 403 || error.status === 408 || error.status === 429 || error.status >= 500;
  if (error instanceof ApiRequestError) return error.status === 429 || error.status >= 500;
  return error instanceof TypeError; // fetch's network error
}

function filePath(shareId: string, fileId: string): string {
  return `/api/v1/shares/${shareId}/files/${fileId}`;
}

/** The part numbers storage already holds (resume after a reload or a pause). */
export async function uploadedParts(api: ApiClient, shareId: string, fileId: string): Promise<Set<number>> {
  const status = await api.request("GET", `${filePath(shareId, fileId)}/multipart`, { schema: multipartStatusResponse });
  return new Set(status.uploaded.map((p) => p.partNumber));
}

/**
 * Uploads every part of `target` not in `uploaded`. `onProgress` gets the bytes in storage plus those in
 * flight. Resolves when storage has every part; the caller then calls complete.
 */
export async function uploadMultipart(options: {
  api: ApiClient;
  shareId: string;
  target: MultipartUploadTarget;
  file: Blob;
  uploaded?: ReadonlySet<number>;
  onProgress: (loaded: number) => void;
  signal: AbortSignal;
  concurrency?: number;
  deps?: MultipartDeps;
}): Promise<void> {
  const { api, shareId, target, file, signal } = options;
  const putPart = options.deps?.putPart ?? xhrPutPart;
  const sleep = options.deps?.sleep ?? defaultSleep;
  const online = options.deps?.online ?? defaultOnline;
  const now = options.deps?.now ?? Date.now;
  const uploaded = options.uploaded ?? new Set<number>();
  const sizeOf = (n: number) => partRange(n, target.partSize, target.sizeBytes).size;

  const queue: number[] = [];
  let stored = 0;
  for (let n = 1; n <= target.partCount; n++) {
    if (uploaded.has(n)) stored += sizeOf(n);
    else queue.push(n);
  }
  const inFlight = new Map<number, number>();
  const report = () => options.onProgress(stored + [...inFlight.values()].reduce((a, b) => a + b, 0));
  report();

  // Part URLs, fetched 20 at a time for the next parts without a fresh one; one request at a time.
  const urls = new Map<number, { url: string; expiresAt: number }>();
  let fetching: Promise<void> | null = null;
  const fresh = (n: number) => {
    const known = urls.get(n);
    return known !== undefined && known.expiresAt - now() > URL_MARGIN_MS;
  };
  async function urlFor(n: number): Promise<string> {
    while (!fresh(n)) {
      if (!fetching) {
        const wanted = [n, ...queue.filter((m) => !fresh(m))].slice(0, 20);
        fetching = api
          .request("POST", `${filePath(shareId, target.fileId)}/multipart/parts`, { body: { partNumbers: wanted }, schema: partUrlsResponse })
          .then(({ parts }) => {
            for (const part of parts) urls.set(part.partNumber, { url: part.url, expiresAt: Date.parse(part.expiresAt) });
          })
          .finally(() => {
            fetching = null;
          });
      }
      await fetching;
    }
    return (urls.get(n) as { url: string }).url;
  }

  async function send(n: number): Promise<void> {
    const range = partRange(n, target.partSize, target.sizeBytes);
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw new UploadCancelledError();
      try {
        const url = await urlFor(n);
        inFlight.set(n, 0);
        await putPart(url, file.slice(range.start, range.end), (loaded) => {
          inFlight.set(n, Math.min(loaded, range.size));
          report();
        }, signal);
        inFlight.delete(n);
        stored += range.size;
        report();
        return;
      } catch (error) {
        inFlight.delete(n);
        report();
        if (error instanceof UploadCancelledError || signal.aborted) throw new UploadCancelledError();
        if (!retryable(error)) throw error;
        // An expired or refused URL: ask for a new one next time.
        if (error instanceof PartUploadError && error.status === 403) urls.delete(n);
        if (attempt >= BACKOFF_MS.length) throw new UploadPausedError();
        await online(signal);
        await sleep(BACKOFF_MS[attempt] as number, signal);
      }
    }
  }

  let failure: unknown = null;
  const worker = async () => {
    while (failure === null && queue.length > 0) {
      const n = queue.shift() as number;
      try {
        await send(n);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 4, queue.length)) }, worker));
  if (failure !== null) throw failure;
}
