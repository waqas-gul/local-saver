"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { setNonce } from "get-nonce";
import type { ReactNode } from "react";
import { AuthRuntimeProvider } from "./auth-runtime";
import { ConfigProvider, type PublicConfig } from "./config";
import { getQueryClient } from "./query-client";
import { RuntimeProvider } from "./runtime";
import { PresenceStore, SessionStore, UploadsStore } from "./stores/session";
import { UiStoreProvider } from "./stores/ui-store";

/**
 * Client providers (DEC-034, 02 §3.3), in three layers:
 *
 * - RootProviders (root layout, every page): the public config and the CSP nonce. No Supabase.
 * - AppProviders (the app's pages): TanStack Query for server state, Zustand stores for
 *   client-only state, and the browser runtime (Supabase Auth and Realtime, API client).
 *   Realtime only signals; it invalidates queries (lib/client/realtime.ts).
 * - ViewerProviders (share and code pages, Phase 2): TanStack Query only. Link viewers never get
 *   a Supabase session or a Realtime connection (03 §4.2, RISK-006); they poll.
 */
export function RootProviders({
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
  return <ConfigProvider config={config}>{children}</ConfigProvider>;
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
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
  );
}

export function ViewerProviders({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={getQueryClient()}>{children}</QueryClientProvider>;
}

/**
 * AuthProviders (sign-in pages, Phase 4 C4-1): the Supabase client and an API client, but no
 * bootstrap, so visiting /login never creates an anonymous user. No query cache: these pages hold
 * no server state worth caching, and the app's cache is cleared when the user changes.
 */
export function AuthProviders({ children }: { children: ReactNode }) {
  return <AuthRuntimeProvider>{children}</AuthRuntimeProvider>;
}
