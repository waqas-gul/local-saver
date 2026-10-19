"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createContext, useContext, useState, type ReactNode } from "react";
import { readStoredDeviceId } from "./account-storage";
import { createApiClient, type ApiClient } from "./api-client";
import { usePublicConfig } from "./config";
import { getSupabaseBrowserClient } from "./supabase";

/**
 * The sign-in pages' runtime (phase 4 §17.5.2, C4-1): the same Supabase client and storage as the
 * app, so a sign-in here is the app's session afterwards, but no bootstrap. These pages never sign
 * in anonymously: an anonymous session already in this browser is upgraded or merged, and a browser
 * without one signs in directly.
 */

export type AuthRuntime = { supabase: SupabaseClient; api: ApiClient };

const AuthRuntimeContext = createContext<AuthRuntime | null>(null);

export function AuthRuntimeProvider({ children }: { children: ReactNode }) {
  const config = usePublicConfig();
  const [runtime] = useState<AuthRuntime | null>(() => {
    if (typeof window === "undefined" || !config) return null;
    const supabase = getSupabaseBrowserClient(config);
    return {
      supabase,
      api: createApiClient({
        auth: {
          getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
          refreshAccessToken: async () => (await supabase.auth.refreshSession()).data.session?.access_token ?? null,
        },
        getDeviceId: readStoredDeviceId,
      }),
    };
  });
  return <AuthRuntimeContext.Provider value={runtime}>{children}</AuthRuntimeContext.Provider>;
}

export function useAuthRuntime(): AuthRuntime | null {
  return useContext(AuthRuntimeContext);
}
