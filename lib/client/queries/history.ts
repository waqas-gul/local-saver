import { infiniteQueryOptions } from "@tanstack/react-query";
import { historyDownloadsResponse, historySharesResponse, type HistoryStatusFilter } from "@/lib/shared/api/schemas";
import type { ApiClient } from "../api-client";
import { queryKeys } from "./keys";

/**
 * Transfer history (phase 4 §17.14, P4-20): server state only, a page at a time by the server's cursor. The filters
 * come from the page's URL. Nothing is persisted; a change of user clears the cache with everything else.
 */

export type ShareHistoryFilters = { status: HistoryStatusFilter | null; kind: "files" | "text" | null };
export type DownloadHistoryFilters = { shareId: string | null };

function ready(api: ApiClient | null): ApiClient {
  if (!api) throw new Error("API client not ready");
  return api;
}

function historyPath(route: "shares" | "downloads", filters: Record<string, string | null>, cursor: string | null): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) if (value !== null) query.set(name, value);
  if (cursor) query.set("cursor", cursor);
  const search = query.toString();
  return `/api/v1/history/${route}${search ? `?${search}` : ""}`;
}

export const shareHistoryQuery = (api: ApiClient | null, filters: ShareHistoryFilters) =>
  infiniteQueryOptions({
    queryKey: queryKeys.historyShares(filters),
    queryFn: ({ pageParam }) => ready(api).request("GET", historyPath("shares", filters, pageParam), { schema: historySharesResponse }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: api !== null,
  });

export const downloadHistoryQuery = (api: ApiClient | null, filters: DownloadHistoryFilters) =>
  infiniteQueryOptions({
    queryKey: queryKeys.historyDownloads(filters),
    queryFn: ({ pageParam }) => ready(api).request("GET", historyPath("downloads", filters, pageParam), { schema: historyDownloadsResponse }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: api !== null,
  });
