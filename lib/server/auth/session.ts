import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseConfig } from "../config/integrations";
import type { Env } from "../env";
import { ApiError } from "../http/errors";

/**
 * Supabase session verification (03 §8).
 *
 * The browser sends its access token as `Authorization: Bearer …` (DV1-6). The server only
 * verifies it (getClaims: JWKS with asymmetric keys, otherwise the Auth server) and never
 * refreshes it, so it can't rotate the browser's refresh token. An expired token gets 401;
 * the client refreshes and retries once. A header the browser must set explicitly also can't
 * be sent by another site (CSRF).
 */

export type Principal = { userId: string; isAnonymous: boolean };

let verifier: SupabaseClient | undefined;

function getVerifier(env: Env): SupabaseClient {
  const { url, publishableKey } = getSupabaseConfig(env);
  verifier ??= createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return verifier;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer ([A-Za-z0-9._-]{20,4096})$/);
  return match?.[1] ?? null;
}

export async function getPrincipal(request: Request, env: Env): Promise<Principal | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const { data, error } = await getVerifier(env).auth.getClaims(token);
  if (error || !data) return null;
  const claims = data.claims as { sub?: unknown; role?: unknown; is_anonymous?: unknown };
  if (typeof claims.sub !== "string" || !UUID.test(claims.sub) || claims.role !== "authenticated") return null;
  return { userId: claims.sub.toLowerCase(), isAnonymous: claims.is_anonymous === true };
}

export async function requirePrincipal(request: Request, env: Env): Promise<Principal> {
  const principal = await getPrincipal(request, env);
  if (!principal) throw new ApiError(401, "UNAUTHENTICATED", "A valid session is required");
  return principal;
}
