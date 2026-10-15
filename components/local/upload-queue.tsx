"use client";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { UploadsStore, useUploads } from "@/lib/client/stores/session";
import { formatBytes } from "./format";

const STATUS: Record<string, string> = {
  queued: "Waiting",
  uploading: "Uploading",
  verifying: "Checking",
  done: "Shared",
  error: "Failed",
};

/** Upload progress from the Zustand uploads store (DEC-034). Stays on this device only. */
export function UploadQueue() {
  const items = useUploads((s) => s.items);
  const store = UploadsStore.useStoreApi();
  if (items.length === 0) return null;
  const finished = items.every((i) => i.status === "done" || i.status === "error");

  return (
    <section aria-label="Uploads" className="space-y-2 rounded-lg border p-3">
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id} className="space-y-1">
            <div className="flex justify-between gap-2 text-sm">
              <span className="truncate">{item.name}</span>
              <span className={item.status === "error" ? "text-destructive" : "text-muted-foreground"}>
                {item.status === "error" ? item.error : `${STATUS[item.status]} · ${formatBytes(item.size)}`}
              </span>
            </div>
            <Progress value={item.size > 0 ? Math.round((item.loaded / item.size) * 100) : 0} />
          </li>
        ))}
      </ul>
      {finished && (
        <Button size="sm" variant="ghost" onClick={() => store.getState().clearFinished()}>
          Clear
        </Button>
      )}
    </section>
  );
}
