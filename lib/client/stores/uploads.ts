"use client";

import { createStore, type StoreApi } from "zustand/vanilla";

/**
 * Upload queue and per-file progress (DEC-034: client-only state). Never holds presigned
 * URLs or server data; the uploader keeps URLs in local variables only.
 *
 * Phase 4 (P4-14): a multipart upload can be "paused" (the connection was lost; it goes on with the same
 * file) or, after a reload, "needs_file" (the browser no longer has the file: the user picks it again).
 * `multipart` marks the large files, which can be cancelled; `warning` asks the user to confirm a file
 * picked again that doesn't look like the original.
 */

export type UploadStatus = "queued" | "uploading" | "paused" | "needs_file" | "verifying" | "done" | "error";

export type UploadItem = {
  id: string;
  batchId: string;
  name: string;
  size: number;
  loaded: number;
  status: UploadStatus;
  error?: string;
  multipart?: boolean;
  warning?: string;
};

type NewItem = { name: string; size: number; multipart?: boolean; status?: UploadStatus; loaded?: number };

export type UploadsState = {
  items: UploadItem[];
  addBatch: (files: NewItem[]) => string;
  update: (id: string, patch: Partial<Pick<UploadItem, "loaded" | "status" | "error" | "warning">>) => void;
  failBatch: (batchId: string, error: string) => void;
  clearFinished: () => void;
};

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(sequence++).toString(36)}`;

export function createUploadsStore(): StoreApi<UploadsState> {
  return createStore<UploadsState>()((set) => ({
    items: [],
    addBatch: (files) => {
      const batchId = nextId("batch");
      set((state) => ({
        items: [
          ...state.items,
          ...files.map((f) => ({
            id: nextId("upload"),
            batchId,
            name: f.name,
            size: f.size,
            loaded: f.loaded ?? 0,
            status: f.status ?? ("queued" as const),
            ...(f.multipart ? { multipart: true } : {}),
          })),
        ],
      }));
      return batchId;
    },
    update: (id, patch) => set((state) => ({ items: state.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) })),
    failBatch: (batchId, error) =>
      set((state) => ({
        items: state.items.map((i) => (i.batchId === batchId && i.status !== "done" ? { ...i, status: "error", error, warning: undefined } : i)),
      })),
    clearFinished: () => set((state) => ({ items: state.items.filter((i) => i.status !== "done" && i.status !== "error") })),
  }));
}
