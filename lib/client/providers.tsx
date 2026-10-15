"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { setNonce } from "get-nonce";
import type { ReactNode } from "react";
import { ConfigProvider, type PublicConfig } from "./config";
import { getQueryClient } from "./query-client";
import { RuntimeProvider } from "./runtime";
import { PresenceStore, SessionStore, UploadsStore } from "./stores/session";
import { UiStoreProvider } from "./stores/ui-store";

/**
 * Client providers for the whole app (DEC-034, 02 §3.3): TanStack Query for server state,
 * Zustand stores for client-only state, and the browser runtime (Supabase Auth and Realtime,
 * API client). Realtime only signals; it invalidates queries (lib/client/realtime.ts).
 */
export function AppProviders({
  config = null,
  nonce,
  children,
}: {
  config?: PublicConfig;
  /** This response's CSP nonce, for <style> tags that UI libraries insert at runtime. */
  nonce?: string;
  children: ReactNode;
}) {
  // Radix dialogs lock scrolling with a runtime <style> tag; get-nonce lets it carry the
  // nonce so the CSP (style-src 'nonce-…') allows it. Browser only: the value is per request.
  if (typeof window !== "undefined" && nonce) setNonce(nonce);

  return (
    <ConfigProvider config={config}>
      <QueryClientProvider client={getQueryClient()}>
        <UiStoreProvider>
          <SessionStore.Provider>
            <UploadsStore.Provider>
              <PresenceStore.Provider>
                <RuntimeProvider>{children}</RuntimeProvider>
              </PresenceStore.Provider>
            </UploadsStore.Provider>
          </SessionStore.Provider>
        </UiStoreProvider>
      </QueryClientProvider>
    </ConfigProvider>
  );
}
