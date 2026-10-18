import type { StoreApi } from "zustand/vanilla";
import {
  createFileShareResponse,
  multipartStatusResponse,
  shareResponse,
  uploadUrlResponse,
  type Destination,
  type MultipartUploadTarget,
  type PutUploadTarget,
  type ShareDto,
} from "@/lib/shared/api/schemas";
import { formatBytes } from "@/lib/shared/format";
import { FREE_LIMITS, SINGLE_PUT_MAX_BYTES } from "@/lib/shared/plans";
import type { ApiClient } from "./api-client";
import { ApiRequestError } from "./api-error";
import type { UploadsState } from "./stores/uploads";
import { dropResume, dropResumeFile, readResume, saveResume, type ResumeEntry } from "./upload-resume";
import { UploadCancelledError, UploadPausedError, uploadMultipart, type MultipartDeps } from "./uploader-multipart";

/**
 * Uploads (02 §4.3): init → PUT each file straight to storage (R2) with the signed headers →
 * complete. Progress goes to the Zustand uploads store, throttled to about 10 updates per
 * second per file (DEC-034 rule 9). Presigned URLs stay in local variables only.
 *
 * Phase 4 (P4-14, §17.8.1): a file above 100 MiB goes up in parts (uploader-multipart.ts). A PUT URL
 * close to expiry is replaced just before its file's turn (upload-url, C4-13). A share with a multipart
 * file is resilient: a lost connection pauses it (it goes on by itself when the browser is back online,
 * or with Resume), Cancel ends it on the server (multipart abort), and its pending files are remembered
 * (upload-resume.ts) so that after a reload the user can pick them again and finish (restoreUploads).
 * A share of single-PUT files only behaves as in Phases 1–3.
 */

const PROGRESS_INTERVAL_MS = 100;
/** A PUT URL with less than this left is replaced before use. */
const URL_MARGIN_MS = 2 * 60_000;
/** Completion attempts while storage still misses parts (MULTIPART_INCOMPLETE). */
const COMPLETE_ROUNDS = 3;

// OWNER REVIEW (P4-14): what a resumed upload says about the files picked again.
export const RESUME_COPY = {
  different: "This doesn't look like the file you started with.",
  missing: (name: string, size: number) => `Choose “${name}” (${formatBytes(size)}).`,
};

// ---------------------------------------------------------------------------------- batch controls

/** What the upload queue can do with a batch in progress. Handles, not state: never in Zustand. */
type BatchControl = {
  cancel: () => void;
  resume?: () => void;
  provideFiles?: (files: File[]) => void;
  confirm?: () => void;
};

const controls = new Map<string, BatchControl>();

export function cancelUpload(batchId: string): void {
  controls.get(batchId)?.cancel();
}

export function resumeUpload(batchId: string): void {
  controls.get(batchId)?.resume?.();
}

export function provideUploadFiles(batchId: string, files: File[]): void {
  controls.get(batchId)?.provideFiles?.(files);
}

export function confirmUploadFiles(batchId: string): void {
  controls.get(batchId)?.confirm?.();
}

// ---------------------------------------------------------------------------------- single PUT

/** A single PUT failed: status 0 for a network error. The messages are Phase 1's. */
export class PutFailedError extends Error {
  constructor(readonly status: number) {
    super(status === 0 ? "Upload failed: network error" : `Upload failed (${status})`);
    this.name = "PutFailedError";
  }
}

type PutFile = (target: PutUploadTarget, file: File, onProgress: (loaded: number) => void, signal?: AbortSignal) => Promise<void>;

/** Test seams: the storage PUTs (single and part), the backoff and the online wait. */
export type UploadDeps = MultipartDeps & { putFile?: PutFile };

const putWithProgress: PutFile = (target, file, onProgress, signal) => {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", target.url);
    for (const [name, value] of Object.entries(target.headers)) xhr.setRequestHeader(name, value);
    let last = 0;
    xhr.upload.onprogress = (event) => {
      const now = Date.now();
      if (now - last >= PROGRESS_INTERVAL_MS || event.loaded === event.total) {
        last = now;
        onProgress(event.loaded);
      }
    };
    const abort = () => xhr.abort();
    signal?.addEventListener("abort", abort, { once: true });
    xhr.onloadend = () => signal?.removeEventListener("abort", abort);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new PutFailedError(xhr.status)));
    xhr.onerror = () => reject(new PutFailedError(0));
    xhr.onabort = () => reject(signal?.aborted ? new UploadCancelledError() : new Error("Upload cancelled"));
    xhr.send(file);
  });
};

export function uploadErrorMessage(error: unknown): string {
  if (error instanceof UploadCancelledError) return "Cancelled.";
  if (error instanceof ApiRequestError) {
    // Phase 4B: the limits are the caller's plan's, and the server says which applied.
    const details = (error.details ?? {}) as { maxFileBytes?: number; maxFiles?: number };
    switch (error.code) {
      case "FILE_TOO_LARGE":
        return `A file is larger than ${formatBytes(details.maxFileBytes ?? FREE_LIMITS.maxFileBytes)}.`;
      case "TOO_MANY_FILES":
        return `You can share up to ${details.maxFiles ?? FREE_LIMITS.maxFilesPerShare} files at once.`;
      case "STORAGE_QUOTA_EXCEEDED":
        return "You've used your storage. Delete some uploads and try again.";
      case "DAILY_UPLOAD_LIMIT":
        return "Daily upload limit reached. Try again tomorrow.";
      case "LOCAL_SHARING_UNAVAILABLE":
        return "Local sharing is off on this network.";
      case "UPLOADS_DISABLED":
        return "Uploads are paused right now.";
      case "UPLOAD_REJECTED":
      case "MULTIPART_INVALID":
        return "The upload didn't match what was announced, so it was rejected.";
      case "UPLOAD_EXPIRED":
        return "The upload took too long. Please start again.";
      case "RATE_LIMITED":
        return "Too many uploads. Wait a moment and try again.";
      case "REMOTE_FILE_BLOCKED":
        return "Programs, scripts, installers and disk images can't be shared by link.";
      case "REMOTE_LINKS_DISABLED":
        return "Sharing by link is paused right now.";
      // P4-22 (E30): the account's deletion is scheduled, so it is read-only.
      case "ACCOUNT_DELETION_PENDING":
        return "This account is being deleted. Cancel the deletion to share again.";
      // OWNER REVIEW (phase 3 §17.9): burn errors at posting.
      case "FEATURE_NOT_IN_PLAN":
      case "BURN_AFTER_DOWNLOAD_DISABLED":
        return "Burn after download isn't available right now.";
    }
  }
  return error instanceof Error ? error.message : "Upload failed.";
}

// ---------------------------------------------------------------------------------- the batch runner

type Job = {
  fileId: string;
  file: File;
  itemId: string | undefined;
  /** A PUT target from init, or null: ask upload-url for one. */
  put: PutUploadTarget | null;
  multipart: boolean;
};

type Run = {
  api: ApiClient;
  uploads: StoreApi<UploadsState>;
  shareId: string;
  jobs: Job[];
  control: BatchControl;
  signal: AbortSignal;
  /** A share with a multipart file pauses instead of failing on a lost connection. */
  resilient: boolean;
  deps?: UploadDeps;
};

const filePath = (shareId: string, fileId: string) => `/api/v1/shares/${shareId}/files/${fileId}`;

/** Worth waiting for the connection: a network error, a server or storage hiccup, or an expired PUT URL. */
function transient(error: unknown): boolean {
  if (error instanceof UploadPausedError || error instanceof TypeError) return true;
  if (error instanceof PutFailedError) return [0, 403, 408, 429].includes(error.status) || error.status >= 500;
  return error instanceof ApiRequestError && (error.status === 429 || error.status >= 500);
}

/** Resolves when the user presses Resume or the browser comes back online. */
function waitForResume(control: BatchControl, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      control.resume = undefined;
      window.removeEventListener("online", done);
      signal.removeEventListener("abort", aborted);
      resolve();
    };
    const aborted = () => {
      control.resume = undefined;
      window.removeEventListener("online", done);
      reject(new UploadCancelledError());
    };
    if (signal.aborted) return aborted();
    control.resume = done;
    window.addEventListener("online", done, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
  });
}

async function runBatch(run: Run): Promise<ShareDto> {
  const { api, uploads, shareId, signal } = run;
  let share: ShareDto | null = null;

  for (const job of run.jobs) {
    const update = (patch: Parameters<UploadsState["update"]>[1]) => {
      if (job.itemId) uploads.getState().update(job.itemId, patch);
    };
    /** Runs a step; in a resilient batch a transient failure pauses it until it can go on. */
    const step = async <T>(fn: () => Promise<T>): Promise<T> => {
      for (;;) {
        if (signal.aborted) throw new UploadCancelledError();
        try {
          return await fn();
        } catch (error) {
          if (signal.aborted) throw new UploadCancelledError();
          if (!run.resilient || !transient(error)) throw error;
          update({ status: "paused" });
          await waitForResume(run.control, signal);
          update({ status: "uploading" });
        }
      }
    };
    const complete = () =>
      api.request("POST", `${filePath(shareId, job.fileId)}/complete`, { body: {}, schema: shareResponse }).then((r) => r.share);

    update({ status: "uploading", warning: undefined });
    if (!job.multipart) {
      await step(async () => {
        let target = job.put;
        if (target === null || Date.parse(target.expiresAt) - Date.now() < URL_MARGIN_MS) {
          target = (await api.request("POST", `${filePath(shareId, job.fileId)}/upload-url`, { body: {}, schema: uploadUrlResponse })).upload;
        }
        job.put = null; // a retry asks for a fresh URL
        if (target.sizeBytes !== job.file.size) throw new Error("Unexpected upload plan");
        await (run.deps?.putFile ?? putWithProgress)(target, job.file, (loaded) => update({ loaded }), signal);
      });
      update({ status: "verifying", loaded: job.file.size });
      share = await step(complete);
    } else {
      for (let round = 1; ; round++) {
        await step(async () => {
          // Storage's part list is the truth: it says what is left, also after a pause or a reload.
          const status = await api.request("GET", `${filePath(shareId, job.fileId)}/multipart`, { schema: multipartStatusResponse });
          const target: MultipartUploadTarget = {
            fileId: job.fileId,
            name: job.file.name,
            sizeBytes: job.file.size,
            method: "MULTIPART",
            partSize: status.partSize,
            partCount: status.partCount,
            expiresAt: status.expiresAt,
          };
          const uploaded = new Set(status.uploaded.map((p) => p.partNumber));
          await uploadMultipart({ api, shareId, target, file: job.file, uploaded, onProgress: (loaded) => update({ loaded }), signal, deps: run.deps });
        });
        update({ status: "verifying", loaded: job.file.size });
        try {
          share = await step(complete);
          break;
        } catch (error) {
          // A part storage doesn't have after all: send what is missing, then complete again.
          if (!(error instanceof ApiRequestError && error.code === "MULTIPART_INCOMPLETE") || round >= COMPLETE_ROUNDS) throw error;
          update({ status: "uploading" });
        }
      }
    }
    dropResumeFile(shareId, job.fileId);
    update({ status: "done" });
  }
  if (!share) throw new Error("Unexpected upload plan");
  return share;
}

/** Cancel on the server: the share ends at once and its storage comes back (multipart abort). */
async function abortOnServer(api: ApiClient, shareId: string, multipartFileId: string | undefined): Promise<void> {
  dropResume(shareId);
  if (!multipartFileId) return;
  try {
    await api.request("POST", `${filePath(shareId, multipartFileId)}/multipart/abort`, { body: {} });
  } catch {
    // Already over (404), or the server is unreachable: the 24-hour deadline ends it anyway.
  }
}

// ---------------------------------------------------------------------------------- entry points

/** Uploads the files as one share; resolves to the finished share, or null if it failed or was cancelled. */
export async function uploadFiles(options: {
  api: ApiClient;
  files: File[];
  expiresIn: number;
  /** This network, Link only (DEC-033), or (P4-17) a room the caller is a member of. */
  destination?: Destination;
  /** Phase 3: burn after download (entitlement-gated on the server). */
  burnAfterDownload?: boolean;
  uploads: StoreApi<UploadsState>;
  /** Phase 4 (P4-14): whose upload it is, for the resume metadata (none: not resumable after a reload). */
  resumeOwner?: () => Promise<string | null>;
  onFinished: () => void;
  /** Phase 4B: the failure, for the composer's upgrade hint. */
  onError?: (error: unknown) => void;
  deps?: UploadDeps;
}): Promise<ShareDto | null> {
  const { api, files, expiresIn, uploads, destination = "network" } = options;
  // The server decides, by the same rule: a file above one PUT's size goes up in parts.
  const batchId = uploads.getState().addBatch(files.map((f) => ({ name: f.name, size: f.size, ...(f.size > SINGLE_PUT_MAX_BYTES ? { multipart: true } : {}) })));
  // addBatch appends one item per file, in file order.
  const itemIds = uploads
    .getState()
    .items.filter((item) => item.batchId === batchId)
    .map((item) => item.id);
  const abort = new AbortController();
  const control: BatchControl = { cancel: () => abort.abort() };
  controls.set(batchId, control);
  let shareId: string | null = null;
  let multipartFileId: string | undefined;

  try {
    const init = await api.request("POST", "/api/v1/shares", {
      body: {
        destination,
        expiresIn,
        ...(options.burnAfterDownload ? { burnAfterDownload: true } : {}),
        files: files.map((f) => ({ name: f.name, size: f.size, type: f.type || "application/octet-stream" })),
      },
      schema: createFileShareResponse,
      headers: { "idempotency-key": crypto.randomUUID() },
    });
    if (init.uploads.length !== files.length) throw new Error("Unexpected upload plan");
    shareId = init.share.id;
    const jobs: Job[] = init.uploads.map((target, index) => {
      const file = files[index] as File;
      if (target.sizeBytes !== file.size) throw new Error("Unexpected upload plan");
      return { fileId: target.fileId, file, itemId: itemIds[index], put: target.method === "PUT" ? target : null, multipart: target.method === "MULTIPART" };
    });
    const multipart = init.uploads.find((t) => t.method === "MULTIPART");
    multipartFileId = multipart?.fileId;
    const owner = multipart ? await options.resumeOwner?.().catch(() => null) : null;
    if (multipart && owner) {
      saveResume({
        userId: owner,
        shareId,
        expiresAt: multipart.expiresAt,
        files: jobs.map((j) => ({ fileId: j.fileId, name: j.file.name, size: j.file.size, lastModified: j.file.lastModified, multipart: j.multipart })),
      });
    }

    const share = await runBatch({ api, uploads, shareId, jobs, control, signal: abort.signal, resilient: multipart !== undefined, deps: options.deps });
    options.onFinished();
    return share;
  } catch (error) {
    if (shareId && multipartFileId) await abortOnServer(api, shareId, multipartFileId);
    uploads.getState().failBatch(batchId, uploadErrorMessage(error));
    if (!(error instanceof UploadCancelledError)) options.onError?.(error);
    options.onFinished();
    return null;
  } finally {
    controls.delete(batchId);
  }
}

/** Uploads (user and share) already back in the queue or being checked: a second call never adds them again. */
const restored = new Set<string>();

/**
 * After a reload (D4-25): this user's unfinished uploads with a multipart file reappear as "needs_file".
 * The user picks the files again (matched by size and name; a different name or date asks to confirm),
 * then only what storage doesn't have yet is sent. Uploads that can no longer finish are forgotten.
 */
export async function restoreUploads(options: {
  api: ApiClient;
  uploads: StoreApi<UploadsState>;
  userId: string;
  onFinished: () => void;
  deps?: UploadDeps;
}): Promise<void> {
  const { api, userId } = options;
  for (const entry of readResume(userId)) {
    const key = `${userId}:${entry.shareId}`;
    if (restored.has(key)) continue;
    restored.add(key);
    const first = entry.files.find((f) => f.multipart);
    if (!first) {
      dropResume(entry.shareId);
      continue;
    }
    let uploadedBytes = 0;
    try {
      const status = await api.request("GET", `${filePath(entry.shareId, first.fileId)}/multipart`, { schema: multipartStatusResponse });
      uploadedBytes = status.uploaded.reduce((sum, p) => sum + p.size, 0);
    } catch (error) {
      // Gone, rejected or expired: nothing left to resume. Anything else: try again on the next call.
      if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500 && error.status !== 429) dropResume(entry.shareId);
      else restored.delete(key);
      continue;
    }
    restoreBatch(entry, uploadedBytes, options);
  }
}

function restoreBatch(entry: ResumeEntry, uploadedBytes: number, options: Parameters<typeof restoreUploads>[0]): void {
  const { api, uploads } = options;
  const batchId = uploads.getState().addBatch(
    entry.files.map((f) => ({ name: f.name, size: f.size, multipart: f.multipart, status: "needs_file" as const, loaded: f.multipart ? uploadedBytes : 0 })),
  );
  const itemIds = uploads
    .getState()
    .items.filter((item) => item.batchId === batchId)
    .map((item) => item.id);
  const multipartFileId = entry.files.find((f) => f.multipart)?.fileId;
  const abort = new AbortController();
  let running = false;
  const control: BatchControl = {
    cancel: () => {
      abort.abort();
      if (!running) {
        controls.delete(batchId);
        void abortOnServer(api, entry.shareId, multipartFileId).then(() => uploads.getState().failBatch(batchId, uploadErrorMessage(new UploadCancelledError())));
      }
    },
  };
  controls.set(batchId, control);

  const start = async (picked: File[]) => {
    running = true;
    control.provideFiles = undefined;
    control.confirm = undefined;
    const jobs: Job[] = entry.files.map((f, index) => ({ fileId: f.fileId, file: picked[index] as File, itemId: itemIds[index], put: null, multipart: f.multipart }));
    try {
      await runBatch({ api, uploads, shareId: entry.shareId, jobs, control, signal: abort.signal, resilient: true, deps: options.deps });
    } catch (error) {
      await abortOnServer(api, entry.shareId, multipartFileId);
      uploads.getState().failBatch(batchId, uploadErrorMessage(error));
    } finally {
      controls.delete(batchId);
      options.onFinished();
    }
  };

  control.provideFiles = (files) => {
    const picked: File[] = [];
    let missing = false;
    let different = false;
    entry.files.forEach((expected, index) => {
      const sameSize = files.filter((f) => f.size === expected.size);
      const match = sameSize.find((f) => f.name === expected.name) ?? sameSize[0];
      const itemId = itemIds[index] as string;
      if (!match) {
        missing = true;
        uploads.getState().update(itemId, { warning: RESUME_COPY.missing(expected.name, expected.size) });
        return;
      }
      picked[index] = match;
      if (match.name !== expected.name || match.lastModified !== expected.lastModified) {
        different = true;
        uploads.getState().update(itemId, { warning: RESUME_COPY.different });
      } else {
        uploads.getState().update(itemId, { warning: undefined });
      }
    });
    if (missing) return;
    if (different) {
      control.confirm = () => void start(picked);
      return;
    }
    void start(picked);
  };
}
