"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { formatBytes } from "@/components/local/format";
import { Button } from "@/components/ui/button";
import { shareHistoryQuery, type ShareHistoryFilters } from "@/lib/client/queries/history";
import { useRuntime } from "@/lib/client/runtime";
import type { HistoryShareDto } from "@/lib/shared/api/schemas";
import { HISTORY_COPY } from "./copy";
import { Choices, HistoryProblem, OlderButton, when } from "./parts";

/** Transfer history, shares (phase 4 §17.8.6, P4-20): every state, newest first, filtered by the page's URL. */

function stateOf(share: HistoryShareDto): string {
  switch (share.status) {
    case "pending_upload":
      return HISTORY_COPY.uploading;
    case "active":
      return share.expiresAt ? HISTORY_COPY.availableUntil(when(share.expiresAt)) : HISTORY_COPY.available;
    case "claimed":
      return HISTORY_COPY.claimed;
    default:
      return HISTORY_COPY.ended[share.endReason ?? "expired"](share.endedAt ? when(share.endedAt) : "");
  }
}

function placeOf(share: HistoryShareDto): string {
  if (share.scope !== "room") return HISTORY_COPY.scope[share.scope];
  return HISTORY_COPY.scope.room(share.room?.label ?? HISTORY_COPY.untitledRoom);
}

function ShareRow({ share, onDownloads }: { share: HistoryShareDto; onDownloads: (shareId: string) => void }) {
  const title = share.title ?? (share.kind === "text" ? HISTORY_COPY.untitledText : HISTORY_COPY.untitledFiles);
  const size = share.kind === "files" ? `${HISTORY_COPY.files(share.fileCount)} · ${formatBytes(share.totalBytes)}` : null;
  return (
    <li className="flex items-start justify-between gap-3 py-3" data-testid="history-share" data-status={share.status}>
      <div className="min-w-0 space-y-0.5">
        <p className="truncate text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{[placeOf(share), size, when(share.createdAt)].filter(Boolean).join(" · ")}</p>
        <p className="text-xs" data-testid="history-share-state">
          {stateOf(share)}
        </p>
      </div>
      <Button variant="outline" size="sm" className="shrink-0" onClick={() => onDownloads(share.id)} data-testid="history-share-downloads">
        {HISTORY_COPY.showDownloads}
      </Button>
    </li>
  );
}

export function ShareHistory({
  filters,
  onFilters,
  onDownloads,
}: {
  filters: ShareHistoryFilters;
  onFilters: (filters: ShareHistoryFilters) => void;
  onDownloads: (shareId: string) => void;
}) {
  const runtime = useRuntime();
  const history = useInfiniteQuery(shareHistoryQuery(runtime?.api ?? null, filters));
  const shares = history.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="space-y-3">
      <Choices
        label={HISTORY_COPY.statusLabel}
        name="status"
        value={filters.status}
        options={[[null, HISTORY_COPY.status.all], ["active", HISTORY_COPY.status.active], ["ended", HISTORY_COPY.status.ended]]}
        onChange={(status) => onFilters({ ...filters, status })}
      />
      <Choices
        label={HISTORY_COPY.kindLabel}
        name="kind"
        value={filters.kind}
        options={[[null, HISTORY_COPY.kind.all], ["files", HISTORY_COPY.kind.files], ["text", HISTORY_COPY.kind.text]]}
        onChange={(kind) => onFilters({ ...filters, kind })}
      />
      {history.isError ? (
        <HistoryProblem error={history.error} />
      ) : !history.data ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{HISTORY_COPY.loading}</p>
      ) : shares.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{HISTORY_COPY.emptyShares}</p>
      ) : (
        <ul className="divide-y" data-testid="history-shares">
          {shares.map((share) => (
            <ShareRow key={share.id} share={share} onDownloads={onDownloads} />
          ))}
        </ul>
      )}
      {history.hasNextPage && <OlderButton onClick={() => void history.fetchNextPage()} busy={history.isFetchingNextPage} />}
    </div>
  );
}
