"use client";

import { createStore, type StoreApi } from "zustand/vanilla";

/**
 * Upload queue and per-file progress (DEC-034: client-only state). Never holds presigned
 * URLs or server data; the uploader keeps URLs in local variables only.
 */

export type UploadStatus = "queued" | "uploading" | "verifying" | "done" | "error";

export type UploadItem = {
  id: string;
  batchId: string;
  name: string;
  size: number;
  loaded: number;
  status: UploadStatus;
  error?: string;
};

export type UploadsState = {
  items: UploadItem[];
  addBatch: (files: { name: string; size: number }[]) => string;
  update: (id: string, patch: Partial<Pick<UploadItem, "loaded" | "status" | "error">>) => void;
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
          ...files.map((f) => ({ id: nextId("upload"), batchId, name: f.name, size: f.size, loaded: 0, status: "queued" as const })),
        ],
      }));
      return batchId;
    },
    update: (id, patch) => set((state) => ({ items: state.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) })),
    failBatch: (batchId, error) =>
      set((state) => ({
        items: state.items.map((i) => (i.batchId === batchId && i.status !== "done" ? { ...i, status: "error", error } : i)),
      })),
    clearFinished: () => set((state) => ({ items: state.items.filter((i) => i.status !== "done" && i.status !== "error") })),
  }));
}
