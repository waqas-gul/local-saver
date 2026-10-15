import { queryOptions } from "@tanstack/react-query";
import {
  localFeedResponse,
  observeResponse,
  previewUrlResponse,
  shareListResponse,
  shareResponse,
} from "@/lib/shared/api/schemas";
import type { ApiClient } from "../api-client";
import { shouldRetry } from "../query-client";
import { queryKeys } from "./keys";

/**
 * queryOptions factories (DEC-034 rule 11). Network-dependent data is fetched in the
 * browser only (rule 7); nothing here is persisted (rule 5). Queries stay disabled until
 * the browser runtime (API client) exists.
 */

const HEARTBEAT_MS = 5 * 60_000; // observe every 5 minutes while open (03 §3.6)

function ready(api: ApiClient | null): ApiClient {
  if (!api) throw new Error("API client not ready");
  return api;
}

/** The observe heartbeat: also refetched on focus and when the browser comes back online. */
export const networkQuery = (api: ApiClient | null) =>
  queryOptions({
    queryKey: queryKeys.network(),
    queryFn: () => ready(api).request("POST", "/api/v1/network/observe", { body: {}, schema: observeResponse }),
    enabled: api !== null,
    staleTime: 0,
    refetchInterval: HEARTBEAT_MS,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    retry: shouldRetry,
  });

export const localFeedQuery = (api: ApiClient | null, spaceIds: readonly string[]) =>
  queryOptions({
    queryKey: queryKeys.localFeed(spaceIds),
    queryFn: () => ready(api).request("GET", "/api/v1/local/shares", { schema: localFeedResponse }),
    enabled: api !== null && spaceIds.length > 0,
  });

export const shareQuery = (api: ApiClient | null, shareId: string) =>
  queryOptions({
    queryKey: queryKeys.share(shareId),
    queryFn: async () => (await ready(api).request("GET", `/api/v1/shares/${shareId}`, { schema: shareResponse })).share,
    enabled: api !== null,
  });

export const myUploadsQuery = (api: ApiClient | null) =>
  queryOptions({
    queryKey: queryKeys.myShares(),
    queryFn: () => ready(api).request("GET", "/api/v1/me/shares", { schema: shareListResponse }),
    enabled: api !== null,
  });

/** Preview URLs live 300 s; refetch well before they expire. */
export const previewQuery = (api: ApiClient | null, fileId: string) =>
  queryOptions({
    queryKey: queryKeys.preview(fileId),
    queryFn: () => ready(api).request("POST", `/api/v1/files/${fileId}/preview-url`, { body: {}, schema: previewUrlResponse }),
    enabled: api !== null,
    staleTime: 4 * 60_000,
    gcTime: 4 * 60_000,
  });
