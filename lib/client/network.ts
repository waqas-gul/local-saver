import type { QueryClient } from "@tanstack/react-query";
import type { ObserveResponse } from "@/lib/shared/api/schemas";
import { NETWORK_SCOPED_KEYS } from "./queries/keys";

/**
 * Leaving a network clears its data (DEC-034 rule 3, G3, RISK-027): when observe reports
 * different space IDs, or a status other than ok, every network-scoped query is removed
 * from the cache, not just hidden. My uploads stays: it belongs to the user.
 */

function sameSpaces(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = [...b].sort();
  return [...a].sort().every((id, i) => id === sorted[i]);
}

export function isSameNetwork(previous: ObserveResponse, next: ObserveResponse): boolean {
  return previous.status === next.status && sameSpaces(previous.spaceIds, next.spaceIds);
}

/** Returns true when network-scoped data was removed. */
export function applyNetworkChange(
  queryClient: QueryClient,
  previous: ObserveResponse | undefined,
  next: ObserveResponse,
): boolean {
  if (!previous || isSameNetwork(previous, next)) return false;
  for (const queryKey of NETWORK_SCOPED_KEYS) queryClient.removeQueries({ queryKey });
  return true;
}
