import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { totp } from "../../support/totp";
import { stack, type Session } from "./api";

/**
 * Account fixtures for Phase 4 (§17.19 "test helpers"). Accounts are made with the Auth admin API
 * and signed in with an admin-generated code, so most tests send no mail. The upgrade and sign-up
 * tests use the real email flow and read the code from mailpit, as a person would from their inbox.
 */

export const newEmail = (tag = "it") => `${tag}-${randomBytes(6).toString("hex")}@example.com`;

let admin: SupabaseClient | undefined;

/** Service-key client for fixtures only; the app's browser code never has this key. */
export function authAdmin(): SupabaseClient {
  admin ??= createClient(stack().supabaseUrl, stack().secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return admin;
}

/** A fresh browser: no session yet. */
export function browserClient(): SupabaseClient {
  return createClient(stack().supabaseUrl, stack().publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as Record<string, unknown>;
}

/** A permanent account with a confirmed email and no anonymous history. */
export async function createAccount(email = newEmail()): Promise<{ email: string; userId: string }> {
  const { data, error } = await authAdmin().auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`account creation failed: ${error?.message}`);
  return { email, userId: data.user.id };
}

async function sessionOf(client: SupabaseClient, result: { data: { session: { access_token: string; user: { id: string } } | null }; error: unknown }): Promise<Session> {
  if (result.error || !result.data.session) throw new Error(`sign-in failed: ${String((result.error as Error | null)?.message)}`);
  await client.realtime.setAuth(result.data.session.access_token);
  return { userId: result.data.session.user.id, accessToken: result.data.session.access_token, client };
}

/** A new browser sign-in to an existing account by code (a new Auth session each time). */
export async function signInByCode(email: string, client = browserClient()): Promise<Session> {
  const { data, error } = await authAdmin().auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.properties?.email_otp) throw new Error(`code generation failed: ${error?.message}`);
  return sessionOf(client, await client.auth.verifyOtp({ email, token: data.properties.email_otp, type: "email" }));
}

/** The same browser's session again, after an Auth call replaced it (upgrade, verifyOtp). */
export async function currentSession(client: SupabaseClient): Promise<Session> {
  const { data } = await client.auth.getSession();
  if (!data.session) throw new Error("no session");
  await client.realtime.setAuth(data.session.access_token);
  return { userId: data.session.user.id, accessToken: data.session.access_token, client };
}

type MailSummary = { ID: string; Created: string; Subject: string };

/** A message as mailpit holds it (P4-23 reads the whole mail, not only the code). */
export type Mail = { ID: string; Subject: string; From: { Name: string; Address: string }; HTML: string; Text: string };

function mailpit(): string {
  const base = stack().mailpitUrl;
  if (!base) throw new Error("mailpit is not running (pnpm stack:start includes it from Phase 4)");
  return base;
}

/** The mails to `email` sent after `since`, newest first. */
export async function mailsTo(email: string, since: Date): Promise<MailSummary[]> {
  const search = await fetch(`${mailpit()}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
  const found = ((await search.json()) as { messages?: MailSummary[] }).messages ?? [];
  return found.filter((m) => new Date(m.Created).getTime() >= since.getTime() - 1000).sort((a, b) => b.Created.localeCompare(a.Created));
}

/** The newest mail to `email` sent after `since`, waiting for it to arrive. */
export async function latestMail(email: string, since: Date): Promise<Mail> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const latest = (await mailsTo(email, since))[0];
    if (latest) return (await (await fetch(`${mailpit()}/api/v1/message/${latest.ID}`)).json()) as Mail;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`no mail for ${email}`);
}

/** The 6-digit code in the newest mail to `email` sent after `since`, from mailpit. */
export async function mailCode(email: string, since: Date): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const code = (await latestMail(email, since)).Text.match(/\b(\d{6})\b/)?.[1];
    if (code) return code;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`no code in the mail for ${email}`);
}

/** RFC 6238 TOTP, as an authenticator app computes it (shared with the E2E tests). */
export { totp };

/** Enrol and verify a TOTP factor on this session's account (the session becomes aal2). */
export async function enrollTotp(client: SupabaseClient): Promise<{ factorId: string; secret: string }> {
  const enrolled = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: `it-${randomBytes(3).toString("hex")}` });
  if (enrolled.error || !enrolled.data) throw new Error(`TOTP enrol failed: ${enrolled.error?.message}`);
  await stepUp(client, enrolled.data.id, enrolled.data.totp.secret);
  return { factorId: enrolled.data.id, secret: enrolled.data.totp.secret };
}

/** Challenge and verify with the authenticator code: this session moves to aal2. */
export async function stepUp(client: SupabaseClient, factorId: string, secret: string): Promise<Session> {
  const challenge = await client.auth.mfa.challenge({ factorId });
  if (challenge.error || !challenge.data) throw new Error(`TOTP challenge failed: ${challenge.error?.message}`);
  const verified = await client.auth.mfa.verify({ factorId, challengeId: challenge.data.id, code: totp(secret) });
  if (verified.error) throw new Error(`TOTP verify failed: ${verified.error.message}`);
  return currentSession(client);
}
