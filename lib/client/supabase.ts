import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { PublicConfig } from "./config";

/**
 * Browser Supabase client: Auth (anonymous sign-in) and Realtime only. The browser never
 * reads application tables (DEC-006). The session lives in this browser's storage and is
 * refreshed here, never on the server (DV1-6).
 */

let client: SupabaseClient | undefined;

export function getSupabaseBrowserClient(config: NonNullable<PublicConfig>): SupabaseClient {
  client ??= createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: "local-saver.auth" },
  });
  return client;
}
