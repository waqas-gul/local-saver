import type { StoreApi } from "zustand/vanilla";
import { createFileShareResponse, shareResponse, type ShareDto, type UploadTarget } from "@/lib/shared/api/schemas";
import type { ApiClient } from "./api-client";
import { ApiRequestError } from "./api-error";
import type { UploadsState } from "./stores/uploads";

/**
 * Uploads (02 §4.3): init → PUT each file straight to storage (R2) with the signed headers →
 * complete. Progress goes to the Zustand uploads store, throttled to about 10 updates per
 * second per file (DEC-034 rule 9). Presigned URLs stay in local variables only.
 */

const PROGRESS_INTERVAL_MS = 100;

function putWithProgress(target: UploadTarget, file: File, onProgress: (loaded: number) => void): Promise<void> {
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
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error("Upload failed: network error"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.send(file);
  });
}

export function uploadErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case "FILE_TOO_LARGE":
        return "A file is larger than 100 MB.";
      case "TOO_MANY_FILES":
        return "You can share up to 20 files at once.";
      case "STORAGE_QUOTA_EXCEEDED":
        return "You've used your storage. Delete some uploads and try again.";
      case "DAILY_UPLOAD_LIMIT":
        return "Daily upload limit reached. Try again tomorrow.";
      case "LOCAL_SHARING_UNAVAILABLE":
        return "Local sharing is off on this network.";
      case "UPLOADS_DISABLED":
        return "Uploads are paused right now.";
      case "UPLOAD_REJECTED":
        return "The upload didn't match what was announced, so it was rejected.";
      case "UPLOAD_EXPIRED":
        return "The upload took too long. Please start again.";
      case "RATE_LIMITED":
        return "Too many uploads. Wait a moment and try again.";
      case "REMOTE_FILE_BLOCKED":
        return "Programs, scripts, installers and disk images can't be shared by link.";
      case "REMOTE_LINKS_DISABLED":
        return "Sharing by link is paused right now.";
    }
  }
  return error instanceof Error ? error.message : "Upload failed.";
}

/** Uploads the files as one share; resolves to the finished share, or null if it failed. */
export async function uploadFiles(options: {
  api: ApiClient;
  files: File[];
  expiresIn: number;
  /** This network, or Link only (DEC-033). */
  destination?: "network" | "link_only";
  uploads: StoreApi<UploadsState>;
  onFinished: () => void;
}): Promise<ShareDto | null> {
  const { api, files, expiresIn, uploads, destination = "network" } = options;
  const batchId = uploads.getState().addBatch(files.map((f) => ({ name: f.name, size: f.size })));
  // addBatch appends one item per file, in file order.
  const itemIds = uploads
    .getState()
    .items.filter((item) => item.batchId === batchId)
    .map((item) => item.id);

  try {
    const init = await api.request("POST", "/api/v1/shares", {
      body: {
        destination,
        expiresIn,
        files: files.map((f) => ({ name: f.name, size: f.size, type: f.type || "application/octet-stream" })),
      },
      schema: createFileShareResponse,
      headers: { "idempotency-key": crypto.randomUUID() },
    });
    if (init.uploads.length !== files.length) throw new Error("Unexpected upload plan");

    let share = init.share;
    for (const [index, target] of init.uploads.entries()) {
      const file = files[index] as File;
      if (target.sizeBytes !== file.size) throw new Error("Unexpected upload plan");
      const itemId = itemIds[index];
      const update = (patch: Parameters<UploadsState["update"]>[1]) => {
        if (itemId) uploads.getState().update(itemId, patch);
      };

      update({ status: "uploading" });
      await putWithProgress(target, file, (loaded) => update({ loaded }));
      update({ status: "verifying", loaded: file.size });
      share = (
        await api.request("POST", `/api/v1/shares/${init.share.id}/files/${target.fileId}/complete`, {
          body: {},
          schema: shareResponse,
        })
      ).share;
      update({ status: "done" });
    }
    options.onFinished();
    return share;
  } catch (error) {
    uploads.getState().failBatch(batchId, uploadErrorMessage(error));
    options.onFinished();
    return null;
  }
}
