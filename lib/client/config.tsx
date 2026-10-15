"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Public runtime configuration, passed from the root layout at request time (DV1-8) so one
 * build serves every environment. Only values that are safe in a browser.
 * Null when Supabase is not configured (for example the Phase 0 smoke server).
 */
export type PublicConfig = {
  supabaseUrl: string;
  supabasePublishableKey: string;
  turnstileSiteKey: string | null;
} | null;

const ConfigContext = createContext<PublicConfig>(null);

export function ConfigProvider({ config, children }: { config: PublicConfig; children: ReactNode }) {
  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>;
}

export function usePublicConfig(): PublicConfig {
  return useContext(ConfigContext);
}
