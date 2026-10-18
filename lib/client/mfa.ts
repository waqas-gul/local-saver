import type { AuthError, SupabaseClient } from "@supabase/supabase-js";

/**
 * The account's authenticator (phase 4 §17.5.9, P4-24): optional TOTP, through Supabase Auth's own MFA calls. Nothing
 * here touches the app's API: the factor's secret and the codes go between this browser and Auth only. The server
 * enforces the outcome (an account with a verified factor uses the app only at aal2, 403 MFA_REQUIRED) and Auth
 * enforces its own rules: removing a verified factor, or adding a second, needs aal2; anonymous users can't enrol.
 */

export type MfaErrorKind = "wrong_code" | "expired" | "rate_limited" | "session_gone" | "generic";

export class MfaError extends Error {
  constructor(readonly kind: MfaErrorKind) {
    super(kind);
    this.name = "MfaError";
  }
}

function toMfaError(error: AuthError | Error | null | undefined): MfaError {
  const code = (error as AuthError | null | undefined)?.code;
  const status = (error as AuthError | null | undefined)?.status;
  if (code === "mfa_verification_failed" || code === "invalid_credentials") return new MfaError("wrong_code");
  if (code === "mfa_challenge_expired") return new MfaError("expired");
  if (code === "over_request_rate_limit" || status === 429) return new MfaError("rate_limited");
  if (code === "session_not_found" || code === "user_not_found" || error?.name === "AuthSessionMissingError") return new MfaError("session_gone");
  return new MfaError("generic");
}

/** A 6-digit code from the authenticator app, spaces allowed; anything else never reaches Auth. */
function codeFrom(raw: string): string {
  const code = raw.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) throw new MfaError("wrong_code");
  return code;
}

export type Enrolment = { factorId: string; uri: string; secret: string };

/** The account's verified authenticators (TOTP factors). */
export async function verifiedAuthenticators(supabase: SupabaseClient): Promise<{ id: string }[]> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw toMfaError(error);
  return data.totp.map((f) => ({ id: f.id }));
}

/** Confirm this session with the authenticator: Supabase Auth raises it to aal2 (the same session). */
export async function confirmWithAuthenticator(supabase: SupabaseClient, rawCode: string): Promise<void> {
  const code = codeFrom(rawCode);
  const [factor] = await verifiedAuthenticators(supabase);
  if (!factor) throw new MfaError("generic");
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
  if (error) throw toMfaError(error);
}

/** Enrolling, step 1: a new TOTP factor, after removing any left unfinished (Auth allows removing those at aal1). */
export async function startEnrolment(supabase: SupabaseClient, factorName: string): Promise<Enrolment> {
  const { data: factors, error: listed } = await supabase.auth.mfa.listFactors();
  if (listed) throw toMfaError(listed);
  for (const stale of factors.all.filter((f) => f.factor_type === "totp" && f.status !== "verified")) {
    await supabase.auth.mfa.unenroll({ factorId: stale.id });
  }
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: factorName, issuer: "Local Saver" });
  if (error || !data || data.type !== "totp") throw toMfaError(error);
  return { factorId: data.id, uri: data.totp.uri, secret: data.totp.secret };
}

/** Enrolling, step 2: the first code verifies the factor; Auth raises this session to aal2 and ends the account's others. */
export async function confirmEnrolment(supabase: SupabaseClient, factorId: string, rawCode: string): Promise<void> {
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: codeFrom(rawCode) });
  if (error) throw toMfaError(error);
}

/** Enrolling, abandoned: the unverified factor goes. */
export async function cancelEnrolment(supabase: SupabaseClient, factorId: string): Promise<void> {
  await supabase.auth.mfa.unenroll({ factorId });
}

/** Removing: a fresh code first (this browser in front of the person), then Auth removes it, which needs aal2. */
export async function removeAuthenticator(supabase: SupabaseClient, rawCode: string): Promise<void> {
  const code = codeFrom(rawCode);
  const [factor] = await verifiedAuthenticators(supabase);
  if (!factor) return;
  const verified = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
  if (verified.error) throw toMfaError(verified.error);
  const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
  if (error) throw toMfaError(error);
}
