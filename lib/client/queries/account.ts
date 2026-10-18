import { queryOptions } from "@tanstack/react-query";
import { deviceListResponse, meResponse } from "@/lib/shared/api/schemas";
import type { ApiClient } from "../api-client";
import { queryKeys } from "./keys";

/** This browser's user (phase 4 §17.5.5). The whole cache is cleared when the user changes. */
export const accountQuery = (api: ApiClient | null) =>
  queryOptions({
    queryKey: queryKeys.account(),
    queryFn: () => {
      if (!api) throw new Error("API client not ready");
      return api.request("GET", "/api/v1/me", { schema: meResponse });
    },
    enabled: api !== null,
    staleTime: 60_000,
  });

/** The account's devices (§17.5.6). Works without a device of its own (a browser at the cap). */
export const devicesQuery = (api: ApiClient | null) =>
  queryOptions({
    queryKey: queryKeys.devices(),
    queryFn: () => {
      if (!api) throw new Error("API client not ready");
      return api.request("GET", "/api/v1/me/devices", { schema: deviceListResponse });
    },
    enabled: api !== null,
  });
