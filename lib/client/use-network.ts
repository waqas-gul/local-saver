"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { ObserveResponse } from "@/lib/shared/api/schemas";
import { applyNetworkChange } from "./network";
import { queryKeys } from "./queries/keys";
import { networkQuery } from "./queries/shares";
import { useRuntime } from "./runtime";
import { useSession } from "./stores/session";

/**
 * The current network (the observe result) and the rules around it: re-observe when the
 * connection changes, and remove the old network's data when it changes (DEC-034 rule 3).
 */
export function useCurrentNetwork() {
  const runtime = useRuntime();
  const ready = useSession((s) => s.phase === "ready");
  const queryClient = useQueryClient();
  const previous = useRef<ObserveResponse | undefined>(undefined);

  const options = networkQuery(runtime?.api ?? null);
  const query = useQuery({ ...options, enabled: options.enabled !== false && ready });

  useEffect(() => {
    if (!query.data) return;
    applyNetworkChange(queryClient, previous.current, query.data);
    previous.current = query.data;
  }, [query.data, queryClient]);

  // 'online' and connection changes (Chromium) may mean a different network (03 §3.6).
  useEffect(() => {
    const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.network() });
    const connection = (navigator as Navigator & { connection?: EventTarget }).connection;
    window.addEventListener("online", refresh);
    connection?.addEventListener("change", refresh);
    return () => {
      window.removeEventListener("online", refresh);
      connection?.removeEventListener("change", refresh);
    };
  }, [queryClient]);

  return query;
}
