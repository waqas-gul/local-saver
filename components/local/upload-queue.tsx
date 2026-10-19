"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { queryKeys } from "@/lib/client/queries/keys";
import { useRuntime } from "@/lib/client/runtime";
import { UploadsStore, useSession, useUploads } from "@/lib/client/stores/session";
import type { UploadItem } from "@/lib/client/stores/uploads";
import { cancelUpload, confirmUploadFiles, provideUploadFiles, RESUME_COPY, restoreUploads, resumeUpload } from "@/lib/client/uploader";
import { UPLOAD_COPY } from "./copy";
import { formatBytes } from "./format";

const STATUS: Record<string, string> = {
  queued: "Waiting",
  uploading: "Uploading",
  paused: UPLOAD_COPY.paused,
  needs_file: UPLOAD_COPY.needsFile,
  verifying: "Checking",
  done: "Shared",
  error: "Failed",
};

function BatchActions({ batchId, items }: { batchId: string; items: UploadItem[] }) {
  const open = items.some((i) => i.status !== "done" && i.status !== "error");
  // Large files can be cancelled, paused and resumed (P4-14); a batch of small files runs as before.
  if (!open || !items.some((i) => i.multipart)) return null;
  const paused = items.some((i) => i.status === "paused");
  const needsFile = items.some((i) => i.status === "needs_file");
  const warned = needsFile && items.some((i) => i.warning === RESUME_COPY.different);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {paused && (
        <Button size="sm" data-testid="upload-resume" onClick={() => resumeUpload(batchId)}>
          {UPLOAD_COPY.resume}
        </Button>
      )}
      {needsFile && (
        <label className="inline-flex">
          <span className="sr-only">{UPLOAD_COPY.pickLabel}</span>
          <input
            type="file"
            multiple
            data-testid="upload-pick"
            className="text-sm file:mr-2 file:rounded-md file:border file:px-2 file:py-1"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (files.length > 0) provideUploadFiles(batchId, files);
            }}
          />
        </label>
      )}
      {warned && (
        <Button size="sm" variant="outline" data-testid="upload-continue" onClick={() => confirmUploadFiles(batchId)}>
          {UPLOAD_COPY.continueAnyway}
        </Button>
      )}
      <Button size="sm" variant="ghost" data-testid="upload-cancel" onClick={() => cancelUpload(batchId)}>
        {UPLOAD_COPY.cancel}
      </Button>
    </div>
  );
}

/** Upload progress from the Zustand uploads store (DEC-034). Stays on this device only. */
export function UploadQueue() {
  const items = useUploads((s) => s.items);
  const store = UploadsStore.useStoreApi();
  const runtime = useRuntime();
  const userId = useSession((s) => s.userId);
  const phase = useSession((s) => s.phase);
  const queryClient = useQueryClient();

  // After a reload: unfinished large uploads come back, waiting for their files (D4-25).
  useEffect(() => {
    if (!runtime || !userId || phase !== "ready") return;
    void restoreUploads({
      api: runtime.api,
      uploads: store,
      userId,
      onFinished: () => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.local() });
        void queryClient.invalidateQueries({ queryKey: queryKeys.myShares() });
      },
    });
  }, [runtime, userId, phase, store, queryClient]);

  if (items.length === 0) return null;
  const finished = items.every((i) => i.status === "done" || i.status === "error");
  const batches = [...new Set(items.map((i) => i.batchId))];

  return (
    <section aria-label="Uploads" className="space-y-2 rounded-lg border p-3">
      {batches.map((batchId) => {
        const batch = items.filter((i) => i.batchId === batchId);
        return (
          <div key={batchId} className="space-y-2" data-testid="upload-batch">
            <ul className="space-y-2">
              {batch.map((item) => (
                <li key={item.id} className="space-y-1">
                  <div className="flex justify-between gap-2 text-sm">
                    <span className="truncate">{item.name}</span>
                    <span className={item.status === "error" ? "text-destructive" : "text-muted-foreground"}>
                      {item.status === "error" ? item.error : `${STATUS[item.status]} · ${formatBytes(item.size)}`}
                    </span>
                  </div>
                  <Progress value={item.size > 0 ? Math.round((item.loaded / item.size) * 100) : 0} />
                  {item.warning && <p className="text-xs text-destructive">{item.warning}</p>}
                </li>
              ))}
            </ul>
            <BatchActions batchId={batchId} items={batch} />
          </div>
        );
      })}
      {finished && (
        <Button size="sm" variant="ghost" onClick={() => store.getState().clearFinished()}>
          Clear
        </Button>
      )}
    </section>
  );
}
