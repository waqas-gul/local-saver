"use client";

import { useQuery } from "@tanstack/react-query";
import { myUploadsQuery } from "@/lib/client/queries/shares";
import { useRealtimeBridge } from "@/lib/client/realtime";
import { useRuntime } from "@/lib/client/runtime";
import { BootState } from "./boot-state";
import { ShareList } from "./share-list";

/** My uploads (T-014): the creator's open shares from any network. */
function MyUploadsList() {
  const runtime = useRuntime();
  // Only the user: topic here; the network feed lives on the home page.
  useRealtimeBridge([]);
  const uploads = useQuery(myUploadsQuery(runtime?.api ?? null));
  if (!uploads.data) return <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>;
  return (
    <section aria-label="My uploads" data-testid="my-uploads">
      <ShareList shares={uploads.data.shares} empty="You haven't shared anything that is still available." />
    </section>
  );
}

export function MyUploads() {
  return (
    <BootState>
      <MyUploadsList />
    </BootState>
  );
}
