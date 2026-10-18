"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { BootState } from "@/components/local/boot-state";
import { Button } from "@/components/ui/button";
import type { DownloadHistoryFilters, ShareHistoryFilters } from "@/lib/client/queries/history";
import { entitlementsQuery } from "@/lib/client/queries/entitlements";
import { useRuntime } from "@/lib/client/runtime";
import { HISTORY_STATUS_FILTERS } from "@/lib/shared/api/schemas";
import { HISTORY_COPY } from "./copy";
import { DownloadHistory } from "./download-history";
import { ShareHistory } from "./share-history";

/**
 * /history (phase 4 §17.14, P4-20): Pro's transfer history, shares or downloads. The view and its filters live in the
 * URL (a reload or a shared bookmark keeps them); values the page doesn't know are dropped, never sent.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type HistoryFilters = ShareHistoryFilters & DownloadHistoryFilters & { view: "shares" | "downloads" };

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

export function filtersFrom(params: { get(name: string): string | null }): HistoryFilters {
  const shareId = params.get("shareId");
  return {
    view: params.get("view") === "downloads" ? "downloads" : "shares",
    status: pick(params.get("status"), HISTORY_STATUS_FILTERS),
    kind: pick(params.get("kind"), ["files", "text"] as const),
    shareId: shareId !== null && UUID.test(shareId) ? shareId : null,
  };
}

/** The URL for a view: only that view's filters. */
export function historyHref(filters: HistoryFilters): string {
  const params = new URLSearchParams();
  if (filters.view === "downloads") {
    params.set("view", "downloads");
    if (filters.shareId) params.set("shareId", filters.shareId);
  } else {
    if (filters.status) params.set("status", filters.status);
    if (filters.kind) params.set("kind", filters.kind);
  }
  const search = params.toString();
  return search ? `/history?${search}` : "/history";
}

export function HistoryView({ filters, onFilters }: { filters: HistoryFilters; onFilters: (filters: HistoryFilters) => void }) {
  const runtime = useRuntime();
  const entitlements = useQuery(entitlementsQuery(runtime?.api ?? null));
  const days = entitlements.data?.features.transferHistory ? (entitlements.data.limits?.historyRetentionDays ?? null) : null;
  const tab = (view: HistoryFilters["view"]) => (
    <Button
      role="tab"
      variant={filters.view === view ? "secondary" : "ghost"}
      size="sm"
      aria-selected={filters.view === view}
      onClick={() => onFilters({ view, status: null, kind: null, shareId: null })}
      data-testid={`history-tab-${view}`}
    >
      {HISTORY_COPY.tabs[view]}
    </Button>
  );
  return (
    <section className="space-y-4" aria-label={HISTORY_COPY.title} data-testid="history">
      <p className="text-sm text-muted-foreground">{days ? HISTORY_COPY.intro(days) : HISTORY_COPY.introNoPlan}</p>
      <div role="tablist" className="flex gap-1">
        {tab("shares")}
        {tab("downloads")}
      </div>
      {filters.view === "shares" ? (
        <ShareHistory
          filters={{ status: filters.status, kind: filters.kind }}
          onFilters={(next) => onFilters({ ...filters, ...next })}
          onDownloads={(shareId) => onFilters({ view: "downloads", status: null, kind: null, shareId })}
        />
      ) : (
        <DownloadHistory filters={{ shareId: filters.shareId }} onAll={() => onFilters({ ...filters, shareId: null })} />
      )}
    </section>
  );
}

export function HistoryFromUrl() {
  const params = useSearchParams();
  const router = useRouter();
  return (
    <BootState>
      <HistoryView filters={filtersFrom(params)} onFilters={(next) => router.replace(historyHref(next), { scroll: false })} />
    </BootState>
  );
}
