import { queryOptions } from "@tanstack/react-query";
import { linkListResponse, previewUrlResponse, viewerContentResponse, type ViewerContent } from "@/lib/shared/api/schemas";
import type { ApiClient } from "../api-client";
import { ApiRequestError } from "../api-error";
import { shouldRetry } from "../query-client";
import { queryKeys } from "./keys";

/**
 * Phase 2 queryOptions factories (DEC-034 rule 11). Link-viewer content is fetched in the browser
 * only (rule 7: it depends on a secret the server never sees in a URL) and polled every 30 s and
 * on focus instead of a Realtime subscription (rule 10). Nothing here is persisted (rule 5).
 */

const VIEWER_POLL_MS = 30_000;

/**
 * The viewer's content, or why there is none. A 404 or 410 replaces the cached content (rule 4:
 * nothing of an ended link stays in memory) and stops the polling. So does 409 PASSWORD_REQUIRED
 * (Phase 4, P4-16): a browser that must prove a (new) password keeps nothing of the share meanwhile.
 */
export type ViewerResult = { content: ViewerContent; ended: null } | { content: null; ended: ApiRequestError };

export async function fetchViewerContent(api: ApiClient, linkId: string): Promise<ViewerResult> {
  try {
    return { content: await api.request("GET", `/api/v1/links/${linkId}/content`, { schema: viewerContentResponse }), ended: null };
  } catch (error) {
    if (error instanceof ApiRequestError && (error.status === 404 || error.status === 410 || error.code === "PASSWORD_REQUIRED")) {
      return { content: null, ended: error };
    }
    throw error;
  }
}

export const viewerContentQuery = (api: ApiClient, linkId: string, enabled = true) =>
  queryOptions({
    queryKey: queryKeys.linkContent(linkId),
    queryFn: () => fetchViewerContent(api, linkId),
    enabled,
    staleTime: 0,
    // Stop polling once the link has ended or failed; the page shows why.
    refetchInterval: (query) => (query.state.data?.ended || query.state.status === "error" ? false : VIEWER_POLL_MS),
    refetchOnWindowFocus: (query) => !query.state.data?.ended,
    retry: shouldRetry,
  });

/** Preview URLs live 300 s; refetch well before they expire. They count against the link's daily cap. */
export const viewerPreviewQuery = (api: ApiClient, linkId: string, fileId: string) =>
  queryOptions({
    queryKey: queryKeys.linkPreview(linkId, fileId),
    queryFn: () =>
      api.request("POST", `/api/v1/links/${linkId}/files/${fileId}/preview-url`, { body: {}, schema: previewUrlResponse }),
    staleTime: 4 * 60_000,
    gcTime: 4 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

/** The creator's links for a share: state and expiry only, never a secret, URL or code. */
export const shareLinksQuery = (api: ApiClient | null, shareId: string, enabled = true) =>
  queryOptions({
    queryKey: queryKeys.shareLinks(shareId),
    queryFn: async () => {
      if (!api) throw new Error("API client not ready");
      return (await api.request("GET", `/api/v1/shares/${shareId}/links`, { schema: linkListResponse })).links;
    },
    enabled: api !== null && enabled,
  });
