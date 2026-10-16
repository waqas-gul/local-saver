import { queryOptions } from "@tanstack/react-query";
import { entitlementsResponse } from "@/lib/shared/api/schemas";
import type { ApiClient } from "../api-client";
import { queryKeys } from "./keys";

/**
 * What this device may use (07 §2.2, phase 3 §17.10). The server decides; the UI only hides what
 * it would refuse (the burn toggle). Cached for a minute: plans and flags change rarely.
 */
export const entitlementsQuery = (api: ApiClient | null) =>
  queryOptions({
    queryKey: queryKeys.entitlements(),
    queryFn: () => {
      if (!api) throw new Error("API client not ready");
      return api.request("GET", "/api/v1/me/entitlements", { schema: entitlementsResponse });
    },
    enabled: api !== null,
    staleTime: 60_000,
  });
