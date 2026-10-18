import { randomBytes } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Accounts in the browser (Phase 4A E2E): sign-in codes are read from mailpit, as a person reads
 * them from their inbox. playwright.config.ts records the local stack (with mailpit's URL) in
 * LOCAL_SAVER_E2E_STACK.
 */

export const newEmail = (tag: string) => `e2e-${tag}-${randomBytes(5).toString("hex")}@example.com`;

function mailpitUrl(): string {
  const stack = JSON.parse(process.env.LOCAL_SAVER_E2E_STACK ?? "{}") as { mailpitUrl?: string | null };
  if (!stack.mailpitUrl) throw new Error("mailpit is not running (pnpm stack:start includes it from Phase 4)");
  return stack.mailpitUrl;
}

/**
 * The newest mail to `email` sent after `since` that `pick` finds something in. Call it once the app shows that the
 * mail was sent: mails up to a second before `since` count, so an earlier read can still find the previous code.
 */
async function fromMail(email: string, since: Date, pick: (message: { Text: string; HTML: string }) => string | undefined): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const search = await fetch(`${mailpitUrl()}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const messages = ((await search.json()) as { messages?: { ID: string; Created: string }[] }).messages ?? [];
    const latest = messages.filter((m) => new Date(m.Created).getTime() >= since.getTime() - 1000).sort((a, b) => b.Created.localeCompare(a.Created))[0];
    if (latest) {
      const found = pick((await (await fetch(`${mailpitUrl()}/api/v1/message/${latest.ID}`)).json()) as { Text: string; HTML: string });
      if (found) return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`no mail for ${email}`);
}

/** The 6-digit code in the newest mail to `email` sent after `since`. */
export function mailCode(email: string, since: Date): Promise<string> {
  return fromMail(email, since, (message) => message.Text.match(/\b(\d{6})\b/)?.[1]);
}

/** The link in the newest mail to `email` sent after `since` (P4-23: it opens this app's /auth/callback). */
export function mailLink(email: string, since: Date): Promise<string> {
  return fromMail(email, since, (message) => message.HTML.match(/href="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&"));
}

/** A permanent account made through Supabase Auth's admin API: confirmed, and sent no email. */
export async function createAccount(email: string): Promise<void> {
  const stack = JSON.parse(process.env.LOCAL_SAVER_E2E_STACK ?? "{}") as { url?: string; secretKey?: string };
  if (!stack.url || !stack.secretKey) throw new Error("the local stack is not running (pnpm stack:start)");
  const admin = createClient(stack.url, stack.secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error) throw new Error(`account creation failed: ${error.message}`);
}

/** From the app's header to signed in: the login page, the email, the code from the mail. */
export async function signInThroughUi(page: Page, email: string, { merge = false }: { merge?: boolean } = {}) {
  await page.getByTestId("account-link").click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByTestId("login-email").fill(email);
  let since = new Date();
  await page.getByTestId("login-send").click();
  if (merge) {
    await expect(page.getByTestId("merge-offer")).toBeVisible();
    since = new Date();
    await page.getByTestId("merge-continue").click();
  }
  await expect(page.getByTestId("code-sent")).toBeVisible();
  await page.getByTestId("login-code").fill(await mailCode(email, since));
  await page.getByTestId("login-verify").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("account-link")).toHaveText("Account");
}
