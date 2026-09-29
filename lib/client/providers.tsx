"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { getQueryClient } from "./query-client";
import { UiStoreProvider } from "./stores/ui-store";

/**
 * Client providers for the whole app (DEC-034, 02 §3.3):
 * TanStack Query for server state and Zustand stores for client-only state.
 * Supabase Realtime joins in Phase 1 as a signal source that invalidates queries.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={getQueryClient()}>
      <UiStoreProvider>{children}</UiStoreProvider>
    </QueryClientProvider>
  );
}
