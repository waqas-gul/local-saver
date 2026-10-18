import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { PublicConfig } from "./config";

/**
 * Browser Supabase client: Auth (anonymous sign-in) and Realtime only. The browser never
 * reads application tables (DEC-006). The session lives in this browser's storage and is
 * refreshed here, never on the server (DV1-6).
 *
 * Phase 4: PKCE (§17.5.2). Email links and Google come back to /auth/callback with a code that
 * only this browser can exchange (its verifier is in this storage), so a sign-in finishes in the
 * browser that started it, where the anonymous data and the merge intent are.
 */

let client: SupabaseClient | undefined;

export function getSupabaseBrowserClient(config: NonNullable<PublicConfig>): SupabaseClient {
  client ??= createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: "pkce", storageKey: "local-saver.auth" },
  });
  return client;
}

/** The Auth session a token belongs to (for telling sign-ins apart; the server verifies it). */
export function sessionIdOf(accessToken: string | undefined | null): string | null {
  if (!accessToken) return null;
  try {
    const part = accessToken.split(".")[1] ?? "";
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as { session_id?: unknown };
    return typeof json.session_id === "string" ? json.session_id : null;
  } catch {
    return null;
  }
}
