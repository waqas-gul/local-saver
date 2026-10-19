import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { authAdmin, browserClient, createAccount, latestMail, mailCode, mailsTo, newEmail, signInByCode, type Mail } from "./support/accounts";
import { adminDb, closeAdminDb, stack } from "./support/api";

/**
 * Email (phase 4 §17.5.8, P4-23): what Supabase Auth sends, read from mailpit as a person reads their
 * inbox. The templates themselves: tests/unit/email-templates.test.ts. Real SMTP, the sending domain and
 * deliverability are staging checks (infra/email/README.md); none of that is claimed here.
 */

afterAll(closeAdminDb);

const callback = () => `${stack().origin}/auth/callback`;
const hrefs = (mail: Mail) => [...mail.HTML.matchAll(/href="([^"]*)"/g)].map((m) => (m[1] ?? "").replace(/&amp;/g, "&"));
const codeIn = (mail: Mail) => mail.Text.match(/\b(\d{6})\b/)?.[1] ?? null;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The Supabase verify URL inside the email's link: /auth/callback#confirm=<it>. */
function verifyUrlIn(link: string): URL {
  const url = new URL(link);
  expect(`${url.origin}${url.pathname}`).toBe(callback());
  expect(url.search).toBe("");
  const inner = new URLSearchParams(url.hash.slice(1)).get("confirm");
  expect(inner).toBeTruthy();
  return new URL(inner!);
}

/** What every mail from Auth has in common: our sender, the code in the body only, nothing from elsewhere. */
function expectOurs(mail: Mail, { code }: { code: boolean }) {
  expect(mail.From.Name).toBe("Local Saver");
  expect(mail.Subject).toMatch(/Local Saver/);
  expect(mail.Subject).not.toMatch(/\d{6}/);
  expect(mail.HTML).not.toMatch(/<img|<script|<!--|OWNER REVIEW/i);
  expect(codeIn(mail) !== null).toBe(code);
}

/** One link to this app's callback, carrying Supabase's verify URL for `type` back to the callback. */
function expectLink(mail: Mail, type: string): URL {
  const links = hrefs(mail);
  expect(links).toHaveLength(1);
  const verify = verifyUrlIn(links[0]!);
  expect(`${verify.origin}${verify.pathname}`).toBe(`${stack().supabaseUrl}/auth/v1/verify`);
  expect(verify.searchParams.get("type")).toBe(type);
  expect(verify.searchParams.get("redirect_to")).toBe(callback());
  return verify;
}

describe("what Auth sends (P4-23)", () => {
  it("sign-up, sign-in, an email change (both addresses) and reauthentication: the code, and a link to this app only", async () => {
    // Sign-up: the first code to a new address. Auth's answer carries no code.
    const fresh = newEmail("mail-signup");
    let since = new Date();
    const otp = await fetch(`${stack().supabaseUrl}/auth/v1/otp?redirect_to=${encodeURIComponent(callback())}`, {
      method: "POST",
      headers: { apikey: stack().publishableKey, "content-type": "application/json" },
      body: JSON.stringify({ email: fresh, create_user: true }),
    });
    const answer = await otp.text();
    const signup = await latestMail(fresh, since);
    expectOurs(signup, { code: true });
    expect(answer).not.toContain(codeIn(signup)!);
    expectLink(signup, "signup");

    // Sign-in to an existing account.
    const { email } = await createAccount();
    since = new Date();
    expect((await browserClient().auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: callback() } })).error).toBeNull();
    const signin = await latestMail(email, since);
    expectOurs(signin, { code: true });
    expectLink(signin, "magiclink");

    // An email change: a code to each address (double_confirm_changes), neither in Auth's answer.
    const session = await signInByCode(email);
    const next = newEmail("mail-change");
    since = new Date();
    const changed = await session.client.auth.updateUser({ email: next }, { emailRedirectTo: callback() });
    expect(changed.error).toBeNull();
    for (const to of [email, next]) {
      const mail = await latestMail(to, since);
      expectOurs(mail, { code: true });
      expect(mail.HTML).toContain(next);
      expect(JSON.stringify(changed.data)).not.toContain(codeIn(mail)!);
      expectLink(mail, "email_change");
    }

    // Reauthentication (Supabase's own step-up email): a code and no link.
    await sleep(1100); // the local per-address resend interval (max_frequency = 1s)
    since = new Date();
    expect((await session.client.auth.reauthenticate()).error).toBeNull();
    const reauth = await latestMail(email, since);
    expectOurs(reauth, { code: true });
    expect(hrefs(reauth)).toEqual([]);
  });

  it("a password-reset request gets no code and no link to use: there are no passwords (D4-2), and the answer doesn't say who has an account", async () => {
    const { email } = await createAccount();
    const nobody = newEmail("mail-nobody");
    const since = new Date();
    const known = await browserClient().auth.resetPasswordForEmail(email, { redirectTo: callback() });
    const unknown = await browserClient().auth.resetPasswordForEmail(nobody, { redirectTo: callback() });
    expect([known.error, unknown.error]).toEqual([null, null]);
    expect(known.data).toEqual(unknown.data);

    const mail = await latestMail(email, since);
    expectOurs(mail, { code: false });
    expect(mail.HTML).not.toContain("/auth/v1/verify");
    for (const link of hrefs(mail)) expect(new URL(link).pathname).toBe("/login");
    await sleep(1500);
    expect(await mailsTo(nobody, since)).toEqual([]);
  });
});

describe("codes and links (P4-23)", () => {
  it("a mail scanner opening the link leaves the code working; once the code is used, the link is spent too", async () => {
    const { email } = await createAccount();
    const since = new Date();
    await browserClient().auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: callback() } });
    const mail = await latestMail(email, since);
    const link = hrefs(mail)[0]!;

    // What Outlook Safe Links and similar scanners do: open every link, following redirects.
    const scanned = await fetch(link, { redirect: "follow" });
    expect(scanned.status).toBe(200);
    expect(new URL(scanned.url).origin).toBe(stack().origin);

    const code = codeIn(mail)!;
    expect((await browserClient().auth.verifyOtp({ email, token: code, type: "email" })).error).toBeNull();
    const spent = await fetch(verifyUrlIn(link), { redirect: "manual" });
    expect(spent.headers.get("location")).toContain("error_code=otp_expired");

    // The app never saw the token: it travels in the fragment, which browsers and scanners don't send.
    const token = verifyUrlIn(link).searchParams.get("token")!;
    expect(token.length).toBeGreaterThan(20);
    expect(readFileSync(stack().serverLog, "utf8")).not.toContain(token);
  });

  it("a code works once, only for its address, and a newer one replaces it; a second request at once is refused", async () => {
    const { email } = await createAccount();
    const other = await createAccount();
    let since = new Date();
    await browserClient().auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    const first = await mailCode(email, since);
    const tooSoon = await browserClient().auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    expect(tooSoon.error?.code).toBe("over_email_send_rate_limit");

    await sleep(2100);
    since = new Date();
    await browserClient().auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    const second = await mailCode(email, since);
    expect(second).not.toBe(first);

    const verify = (address: string, token: string) => browserClient().auth.verifyOtp({ email: address, token, type: "email" });
    expect((await verify(email, first)).error?.code).toBe("otp_expired");
    expect((await verify(other.email, second)).error?.code).toBe("otp_expired");
    expect((await verify(email, second)).error).toBeNull();
    expect((await verify(email, second)).error?.code).toBe("otp_expired");
  });

  it("a code older than its lifetime (otp_expiry, 1 hour) is refused", async () => {
    const { email, userId } = await createAccount();
    const since = new Date();
    await browserClient().auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    const code = await mailCode(email, since);
    await adminDb().query("update auth.users set recovery_sent_at = recovery_sent_at - interval '61 minutes' where id = $1", [userId]);
    expect((await browserClient().auth.verifyOtp({ email, token: code, type: "email" })).error?.code).toBe("otp_expired");
    expect((await authAdmin().auth.admin.getUserById(userId)).data.user?.last_sign_in_at ?? null).toBeNull();
  });
});
