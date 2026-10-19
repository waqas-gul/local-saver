import { createApiClient, type ApiClient } from "./api-client";

/**
 * API client for link viewers (share and code pages, Phase 2). Same-origin requests carrying
 * only the httpOnly link-session cookie, which the browser adds itself: no Supabase token and
 * no device ID, because a viewer has neither (03 §4.2).
 */
export function createViewerApiClient(fetcher?: typeof fetch): ApiClient {
  return createApiClient({
    auth: { getAccessToken: async () => null, refreshAccessToken: async () => null },
    getDeviceId: () => null,
    fetch: fetcher,
  });
}
