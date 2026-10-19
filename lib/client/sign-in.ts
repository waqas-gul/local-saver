import type { AuthError, SupabaseClient } from "@supabase/supabase-js";
import type { ApiClient } from "./api-client";
import { prepareMerge, redeemPendingMerge, type MergeOutcome } from "./merge";
import { getTurnstileToken } from "./turnstile";

/**
 * Sign-in flows (phase 4 §17.5.2 … §17.5.4; D4-2: email code or link, and Google).
 *
 * - An anonymous browser first tries to add the email to itself (updateUser): the upgrade that
 *   keeps its user ID, so everything it shared stays where it is. Supabase answers email_exists
 *   when the address already has an account; the page then offers the merge.
 * - The merge: the anonymous session makes an intent first (it is replaced by the sign-in), then
 *   signs in to the account by code, then this browser redeems the intent.
 * - A browser with no session signs in (or signs up) by code.
 * The page asks for the 6-digit code, so the flow finishes in the browser that started it; the link
 * in the same email also works here, through /auth/callback (PKCE) and a click (P4-23, readEmailLink).
 */

export type SignInMode = "anonymous" | "fresh" | "account";
export type CodeKind = "upgrade" | "signin" | "merge";

export type SignInErrorKind = "invalid_email" | "wrong_code" | "rate_limited" | "no_account" | "generic";

export class SignInError extends Error {
  constructor(readonly kind: SignInErrorKind) {
    super(kind);
    this.name = "SignInError";
  }
}

function toSignInError(error: AuthError | Error | null | undefined): SignInError {
  const code = (error as AuthError | null | undefined)?.code;
  if (code === "otp_expired" || code === "invalid_credentials") return new SignInError("wrong_code");
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit" || code === "over_sms_send_rate_limit") {
    return new SignInError("rate_limited");
  }
  if (code === "otp_disabled" || code === "user_not_found" || code === "signup_disabled") return new SignInError("no_account");
  if (code === "validation_failed" || code === "email_address_invalid") return new SignInError("invalid_email");
  return new SignInError("generic");
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmail(value: string): boolean {
  return EMAIL.test(value.trim()) && value.trim().length <= 254;
}

export async function currentMode(supabase: SupabaseClient): Promise<{ mode: SignInMode; email: string | null }> {
  const session = (await supabase.auth.getSession()).data.session;
  if (!session) return { mode: "fresh", email: null };
  if (session.user.is_anonymous) return { mode: "anonymous", email: null };
  return { mode: "account", email: session.user.email ?? null };
}

/**
 * How long "Send a new code" waits after a code was sent (§17.5.8, P4-23): Supabase refuses another email to the same
 * address sooner (`max_frequency`, 60 s on hosted projects; the local stack allows 1 s for tests).
 */
export const RESEND_SECONDS = 60;

export type RequestResult = { next: "code"; kind: CodeKind } | { next: "merge_offer" };

type Options = { redirectTo: string; turnstileSiteKey: string | null };

/** With Supabase captcha on (Turnstile configured), sign-ins that send email need a token too. */
async function captcha(options: Options): Promise<{ captchaToken?: string }> {
  return options.turnstileSiteKey ? { captchaToken: await getTurnstileToken(options.turnstileSiteKey) } : {};
}

/** Step 1: send a code. `mergeConfirmed` after the person accepted the merge offer. */
export async function requestCode(
  supabase: SupabaseClient,
  api: ApiClient,
  rawEmail: string,
  mode: SignInMode,
  options: Options & { mergeConfirmed?: boolean },
): Promise<RequestResult> {
  const email = rawEmail.trim();
  if (!isEmail(email)) throw new SignInError("invalid_email");

  if (mode === "anonymous" && !options.mergeConfirmed) {
    const { error } = await supabase.auth.updateUser({ email }, { emailRedirectTo: options.redirectTo });
    if (!error) return { next: "code", kind: "upgrade" };
    if (error.code === "email_exists") return { next: "merge_offer" };
    throw toSignInError(error);
  }

  const merging = mode === "anonymous" && (await prepareMerge(api)) === "ready";
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: !merging, emailRedirectTo: options.redirectTo, ...(await captcha(options)) },
  });
  if (error) throw toSignInError(error);
  return { next: "code", kind: merging ? "merge" : "signin" };
}

/** Step 2: the code from the email. Returns what happened to a pending merge, if there was one. */
export async function verifyCode(
  supabase: SupabaseClient,
  api: ApiClient,
  rawEmail: string,
  rawCode: string,
  kind: CodeKind,
): Promise<{ merge: MergeOutcome | null }> {
  const email = rawEmail.trim();
  const token = rawCode.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(token)) throw new SignInError("wrong_code");
  const { error } = await supabase.auth.verifyOtp({ email, token, type: kind === "upgrade" ? "email_change" : "email" });
  if (error) throw toSignInError(error);
  return { merge: kind === "merge" ? await redeemPendingMerge(api) : null };
}

/** Google (D4-2): link it to the anonymous browser (upgrade), or sign in with it (merge or fresh). */
export async function startGoogle(
  supabase: SupabaseClient,
  api: ApiClient,
  mode: SignInMode,
  options: { redirectTo: string; merge?: boolean },
): Promise<void> {
  if (mode === "anonymous" && !options.merge) {
    const { error } = await supabase.auth.linkIdentity({ provider: "google", options: { redirectTo: options.redirectTo } });
    if (error) throw toSignInError(error);
    return;
  }
  if (mode === "anonymous") await prepareMerge(api);
  const { error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: options.redirectTo } });
  if (error) throw toSignInError(error);
}

export type EmailLink = { kind: "none" } | { kind: "follow"; url: string } | { kind: "refused" };

/**
 * The link in Auth's emails (P4-23) opens /auth/callback#confirm=<Supabase's verify URL>, and the page follows it only
 * when the person presses Continue. Mail scanners open the links in emails; opening Supabase's link itself uses up the
 * sign-in token, and the code in the same email with it. In the fragment, the token never reaches this app's server.
 * Only Supabase's own verify endpoint is followed, so the page is never an open redirect.
 */
export function readEmailLink(hash: string, supabaseUrl: string): EmailLink {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  if (!params.has("confirm")) return { kind: "none" };
  try {
    const target = new URL(params.get("confirm") ?? "");
    const verify = new URL("/auth/v1/verify", supabaseUrl);
    if (target.origin !== verify.origin || target.pathname !== verify.pathname || !target.searchParams.has("token")) return { kind: "refused" };
    return { kind: "follow", url: target.href };
  } catch {
    return { kind: "refused" };
  }
}

export type CallbackResult =
  | { kind: "signed_in"; merge: MergeOutcome | null }
  /** Google is already another account's: offer the merge, then sign in with Google. */
  | { kind: "google_merge_offer" }
  | { kind: "failed" };

/** /auth/callback: finish a link or Google sign-in in this browser (PKCE), then any pending merge. */
export async function completeCallback(supabase: SupabaseClient, api: ApiClient, params: URLSearchParams): Promise<CallbackResult> {
  const errorCode = params.get("error_code");
  if (errorCode === "identity_already_exists") return { kind: "google_merge_offer" };
  if (params.get("error") || errorCode) return { kind: "failed" };
  const code = params.get("code");
  if (!code) return { kind: "failed" };
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return { kind: "failed" };
  const session = (await supabase.auth.getSession()).data.session;
  return { kind: "signed_in", merge: session && !session.user.is_anonymous ? await redeemPendingMerge(api) : null };
}

/** Whether this Supabase project offers Google sign-in (its public settings endpoint). */
export async function googleEnabled(supabaseUrl: string, publishableKey: string): Promise<boolean> {
  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/settings`, { headers: { apikey: publishableKey } });
    if (!response.ok) return false;
    const settings = (await response.json()) as { external?: { google?: boolean } };
    return settings.external?.google === true;
  } catch {
    return false;
  }
}
