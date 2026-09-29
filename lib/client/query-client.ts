import { QueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "./api-error";

/**
 * TanStack Query owns server state (DEC-034). Nothing is persisted (rule 5).
 * Query keys and queryOptions factories go in lib/client/queries/* from Phase 1 (rule 11).
 */

const MAX_RETRIES = 3;

/** Rule 8: never retry 4xx automatically; retry network errors and 5xx a few times. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiRequestError && error.status < 500) return false;
  return failureCount < MAX_RETRIES;
}

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: shouldRetry, refetchOnWindowFocus: true },
      mutations: { retry: false },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

/**
 * Rule 6 and the bundled Next.js 16 TanStack Query guide: a new client for each
 * server render (no data shared between requests), one reused client in the browser.
 */
export function getQueryClient(): QueryClient {
  if (typeof window === "undefined") return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}
