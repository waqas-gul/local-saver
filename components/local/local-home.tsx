"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { localFeedQuery } from "@/lib/client/queries/shares";
import { useRealtimeBridge } from "@/lib/client/realtime";
import { useRuntime } from "@/lib/client/runtime";
import { usePresence } from "@/lib/client/stores/session";
import { useCurrentNetwork } from "@/lib/client/use-network";
import { BootState } from "./boot-state";
import { Composer } from "./composer";
import { FirstVisitNotice } from "./first-visit-notice";
import { NetworkStatusPanel } from "./network-status";
import { ShareList } from "./share-list";
import { UploadQueue } from "./upload-queue";

/**
 * "This network" home: network line, composer with the audience line, uploads and the local
 * feed. Opening the page on a network shows what was posted there; no join step. Where local
 * sharing is off, the composer offers Link only (Phase 2 fallback: link, QR code or code).
 */
function LocalNetwork() {
  const runtime = useRuntime();
  const network = useCurrentNetwork();
  const status = network.data;
  const spaceIds = status?.status === "ok" ? status.spaceIds : [];
  useRealtimeBridge(spaceIds);

  const members = usePresence((s) => s.members);
  const incoming = usePresence((s) => s.incoming);
  const feed = useQuery(localFeedQuery(runtime?.api ?? null, spaceIds));
  const devicesHere = Math.max(members.length, status?.devicesHere ?? 0);

  if (!status) {
    return (
      <p className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Finding your network…
      </p>
    );
  }

  const ok = status.status === "ok";
  return (
    <div className="space-y-4">
      <NetworkStatusPanel status={status.status} reason={status.reason} devicesHere={devicesHere} />
      <FirstVisitNotice active={ok} />
      <Composer localAvailable={ok} />
      <UploadQueue />
      {ok && incoming.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {incoming.length === 1 ? "Someone is uploading a file…" : `${incoming.length} uploads in progress…`}
        </p>
      )}
      {ok && (
        <section aria-label="Shared on this network" data-testid="local-feed">
          {feed.data ? (
            <ShareList shares={feed.data.shares} empty="Nothing has been shared on this network yet." />
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
          )}
        </section>
      )}
    </div>
  );
}

export function LocalHome() {
  return (
    <BootState>
      <LocalNetwork />
    </BootState>
  );
}
