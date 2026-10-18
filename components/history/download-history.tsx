"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { downloadHistoryQuery, type DownloadHistoryFilters } from "@/lib/client/queries/history";
import { useRuntime } from "@/lib/client/runtime";
import type { HistoryDownloadDto } from "@/lib/shared/api/schemas";
import { HISTORY_COPY } from "./copy";
import { HistoryProblem, OlderButton, when } from "./parts";

/**
 * Transfer history, downloads (phase 4 §17.8.6, P4-20): what happened to the caller's shares, by actor kind only
 * (D4-20). A link is named only when it is the caller's own.
 */

function whoOf(download: HistoryDownloadDto): string {
  if (download.actorKind === "link_viewer" && download.link) {
    return download.link.kind === "room" ? HISTORY_COPY.viaRoomLink : HISTORY_COPY.viaShareLink;
  }
  return HISTORY_COPY.actor[download.actorKind];
}

function DownloadRow({ download }: { download: HistoryDownloadDto }) {
  const what = download.file?.name ?? download.share.title ?? HISTORY_COPY.untitledText;
  return (
    <li className="space-y-0.5 py-3" data-testid="history-download" data-event={download.event}>
      <p className="truncate text-sm">
        <span className="font-medium">{HISTORY_COPY.event[download.event]}</span> · {what}
      </p>
      <p className="text-xs text-muted-foreground" data-testid="history-download-who">
        {[whoOf(download), download.browser, when(download.at)].filter(Boolean).join(" · ")}
      </p>
      {download.link?.id && <p className="text-xs text-muted-foreground">{HISTORY_COPY.yourLink(download.link.id)}</p>}
    </li>
  );
}

export function DownloadHistory({ filters, onAll }: { filters: DownloadHistoryFilters; onAll: () => void }) {
  const runtime = useRuntime();
  const history = useInfiniteQuery(downloadHistoryQuery(runtime?.api ?? null, filters));
  const downloads = history.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="space-y-3">
      {filters.shareId && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">{HISTORY_COPY.oneShare}</p>
          <Button variant="ghost" size="sm" onClick={onAll} data-testid="history-all-downloads">
            {HISTORY_COPY.allDownloads}
          </Button>
        </div>
      )}
      {history.isError ? (
        <HistoryProblem error={history.error} />
      ) : !history.data ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{HISTORY_COPY.loading}</p>
      ) : downloads.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{HISTORY_COPY.emptyDownloads}</p>
      ) : (
        <ul className="divide-y" data-testid="history-downloads">
          {downloads.map((download) => (
            <DownloadRow key={download.id} download={download} />
          ))}
        </ul>
      )}
      {history.hasNextPage && <OlderButton onClick={() => void history.fetchNextPage()} busy={history.isFetchingNextPage} />}
    </div>
  );
}
