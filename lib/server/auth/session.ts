import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { sql } from "kysely";
import { getSupabaseConfig } from "../config/integrations";
import { getDb } from "../db/client";
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
 *
 * Phase 4 (§17.5.1): the principal also carries the token's Auth session (every device is bound
 * to one, C4-2), its assurance level and sign-in methods (sensitive actions, D4-30), and an
 * account's email and providers. Password sessions are refused: the app offers no passwords
 * (D4-2), and a password on an account means someone set one without the owner (P4-00).
 *
 * P4-24 (§17.5.9, D4-30): an account with a verified authenticator (a Supabase Auth TOTP factor) uses the app only at
 * aal2. requirePrincipal (the endpoints without a device) and requireCaller (every other one) refuse its aal1 sessions
 * with 403 MFA_REQUIRED, whatever the request says: the level comes from the verified token, the factor from Auth's
 * table. Enrolling, confirming and removing a factor are Auth's own calls; Auth refuses removal below aal2.
 */

export type AuthMethod = { method: string; timestamp: number };

export type Principal = {
  userId: string;
  isAnonymous: boolean;
  /** The Supabase Auth session (one per browser sign-in); devices are bound to it. */
  sessionId: string;
  aal: "aal1" | "aal2";
  amr: AuthMethod[];
  /** Accounts only. */
  email: string | null;
  /** Sign-in providers linked to the account ("email", "google"); empty for anonymous users. */
  providers: string[];
};

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

function authMethods(value: unknown): AuthMethod[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    entry && typeof entry === "object" && typeof (entry as AuthMethod).method === "string"
      ? [{ method: (entry as AuthMethod).method, timestamp: Number((entry as AuthMethod).timestamp) || 0 }]
      : [],
  );
}

/** The principal of verified token claims, or null when the token may not use the app. */
export function principalFromClaims(raw: unknown): Principal | null {
  if (!raw || typeof raw !== "object") return null;
  const claims = raw as Record<string, unknown>;
  if (typeof claims.sub !== "string" || !UUID.test(claims.sub) || claims.role !== "authenticated") return null;
  if (typeof claims.session_id !== "string" || !UUID.test(claims.session_id)) return null;
  const amr = authMethods(claims.amr);
  if (amr.some((m) => m.method === "password")) return null;
  const isAnonymous = claims.is_anonymous === true;
  const appMetadata = claims.app_metadata && typeof claims.app_metadata === "object" ? (claims.app_metadata as Record<string, unknown>) : {};
  const providers = Array.isArray(appMetadata.providers) ? appMetadata.providers.filter((p): p is string => typeof p === "string") : [];
  return {
    userId: claims.sub.toLowerCase(),
    isAnonymous,
    sessionId: claims.session_id.toLowerCase(),
    aal: claims.aal === "aal2" ? "aal2" : "aal1",
    amr,
    email: !isAnonymous && typeof claims.email === "string" && claims.email !== "" ? claims.email : null,
    providers: isAnonymous ? [] : providers,
  };
}

export async function getPrincipal(request: Request, env: Env): Promise<Principal | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const { data, error } = await getVerifier(env).auth.getClaims(token);
  if (error || !data) return null;
  return principalFromClaims(data.claims);
}

/** A verified token that may use the app, with no assurance check: requireCaller checks the device first, then that. */
export async function requireSession(request: Request, env: Env): Promise<Principal> {
  const principal = await getPrincipal(request, env);
  if (!principal) throw new ApiError(401, "UNAUTHENTICATED", "A valid session is required");
  return principal;
}

/**
 * The endpoints without a device whose database functions check the token's Auth session themselves (registration, the
 * merge's redemption). The device list and revocation use requireLiveSession (auth/device.ts, P4-26).
 */
export async function requirePrincipal(request: Request, env: Env): Promise<Principal> {
  const principal = await requireSession(request, env);
  await assertMfaSatisfied(principal);
  return principal;
}

export function mfaRequired(): ApiError {
  return new ApiError(403, "MFA_REQUIRED", "Confirm with your authenticator app first");
}

/** Whether the user has a verified authenticator (Supabase Auth: a verified MFA factor). */
export async function mfaEnrolled(userId: string): Promise<boolean> {
  const { rows } = await sql<{ enrolled: boolean }>`select app.mfa_enrolled(${userId}::uuid) as enrolled`.execute(getDb());
  return rows[0]?.enrolled === true;
}

/** P4-24: an account with an authenticator must be at aal2. Anonymous users can't have one (Auth refuses them). */
export async function assertMfaSatisfied(principal: Principal): Promise<void> {
  if (principal.isAnonymous || principal.aal === "aal2") return;
  if (await mfaEnrolled(principal.userId)) throw mfaRequired();
}

/** A permanent account (§17.13 "Account"): anonymous users get 403 ACCOUNT_REQUIRED. */
export function assertAccount(principal: Principal): void {
  if (principal.isAnonymous) throw new ApiError(403, "ACCOUNT_REQUIRED", "Sign in to an account first");
}
