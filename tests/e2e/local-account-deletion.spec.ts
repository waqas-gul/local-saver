import { expect, test, type Page } from "@playwright/test";
import { mailCode, newEmail, signInThroughUi } from "./support/accounts";
import { fitsScreen, newNetwork, openDevice, postText, unique } from "./support/local-devices";
import { adminDb, closeAdminDb } from "./support/remote";

/**
 * Account deletion in real browsers (phase 4 §17.5.7, P4-22; T4-A5, T4-A6): an account schedules its deletion from
 * its settings (a typed confirmation; just signed in, it needs no new code), is read-only with a banner on every page,
 * and cancels it from the banner. An account whose sign-in is older than 10 minutes confirms with an emailed code
 * first; after the date the hourly job deletes the account, and the browser starts again without it. The job is run
 * here as pg_cron runs it.
 */

test.afterAll(closeAdminDb);

const READ_ONLY = "This account is being deleted. Cancel the deletion to share again.";

async function scheduleDeletion(page: Page, reauthEmail: string | null = null) {
  await page.getByTestId("account-link").click();
  await page.getByTestId("delete-account-open").click();
  const dialog = page.getByTestId("delete-account-dialog");
  await expect(dialog).toContainText("This can't be undone.");
  await expect(page.getByTestId("delete-submit")).toBeDisabled();
  await page.getByTestId("delete-confirm").fill("DELETE");
  const isRequest = (r: { url(): string; request(): { method(): string } }) => r.url().endsWith("/api/v1/me") && r.request().method() === "DELETE";
  const since = new Date();
  const first = page.waitForResponse(isRequest);
  await page.getByTestId("delete-submit").click();
  if (reauthEmail) {
    // The sign-in is too old (D4-30): a code to the account's address, which signs this browser in again.
    expect((await first).status()).toBe(403);
    await expect(dialog).toContainText(`we sent a 6-digit code to ${reauthEmail}`);
    await page.getByTestId("delete-code").fill(await mailCode(reauthEmail, since));
    const again = page.waitForResponse((r) => isRequest(r) && r.status() !== 401);
    await page.getByTestId("delete-verify").click();
    expect((await again).status()).toBe(202);
  } else {
    expect((await first).status()).toBe(202);
  }
  await expect(dialog).toHaveCount(0);
}

/** The browser's sign-in becomes 20 minutes old: Auth's record of it, and a stored access token that must be refreshed. */
async function ageSignIn(page: Page, email: string) {
  await adminDb().query(
    `update auth.mfa_amr_claims set created_at = now() - interval '20 minutes', updated_at = now() - interval '20 minutes'
      where session_id in (select s.id from auth.sessions s join auth.users u on u.id = s.user_id where u.email = $1)`,
    [email],
  );
  await page.evaluate(() => {
    // lib/client/supabase.ts's storage key.
    const stored = JSON.parse(window.localStorage.getItem("local-saver.auth") ?? "null") as { expires_at?: number } | null;
    if (!stored) throw new Error("no stored session");
    window.localStorage.setItem("local-saver.auth", JSON.stringify({ ...stored, expires_at: Math.floor(Date.now() / 1000) - 10 }));
  });
  await page.reload();
}

test("an account schedules its deletion, is read-only with a banner on every page, and cancels it", async ({ browser }) => {
  const device = await openDevice(browser, newNetwork().ip());
  const { page } = device;
  await signInThroughUi(page, newEmail("delete"));
  await postText(device, unique("before the request"));

  await scheduleDeletion(page);
  const banner = page.getByTestId("deletion-banner");
  await expect(banner).toContainText("This account will be deleted on");
  await expect(page.getByTestId("delete-account")).toContainText("Deletion is scheduled for");

  await page.getByRole("link", { name: "This network" }).click();
  await expect(banner).toBeVisible();
  await page.getByTestId("composer-text").fill(unique("during the grace"));
  const refused = page.waitForResponse((r) => r.url().endsWith("/api/v1/texts") && r.request().method() === "POST");
  await page.getByTestId("composer-submit").click();
  expect((await refused).status()).toBe(403);
  await expect(page.getByText(READ_ONLY)).toBeVisible();

  const cancelled = page.waitForResponse((r) => r.url().endsWith("/api/v1/me/deletion/cancel"));
  await page.getByTestId("cancel-deletion").click();
  expect((await cancelled).status()).toBe(204);
  await expect(page.getByTestId("deletion-cancelled")).toContainText("The deletion is cancelled.");
  await expect(banner).toHaveCount(0);
  await postText(device, unique("after cancelling"));
  expect(await device.cspViolations()).toEqual([]);
});

test("an old sign-in confirms with a code; after the date the job deletes the account and the browser starts again without it; on a phone", async ({ browser }) => {
  const device = await openDevice(browser, newNetwork().ip(), { viewport: { width: 320, height: 640 } });
  const { page } = device;
  const email = newEmail("deleted");
  await signInThroughUi(page, email);
  await ageSignIn(page, email);
  await scheduleDeletion(page, email);
  await expect(page.getByTestId("deletion-banner")).toBeVisible();
  expect(await fitsScreen(page)).toBe(true);

  // The grace ends: the date is shown as passed, with nothing to cancel.
  const { rows } = await adminDb().query("select id from auth.users where email = $1", [email]);
  await adminDb().query("update app.profiles set deletion_scheduled_for = now() - interval '1 second' where user_id = $1", [rows[0].id]);
  await page.reload();
  await expect(page.getByTestId("deletion-banner")).toContainText("This account is being deleted.");
  await expect(page.getByTestId("cancel-deletion")).toHaveCount(0);

  await adminDb().query("select app.run_job('delete-due-accounts')");
  expect((await adminDb().query("select count(*)::int as n from auth.users where id = $1", [rows[0].id])).rows[0].n).toBe(0);
  // Its refresh token is refused: the browser is told it was signed out and starts again as a new anonymous user.
  await page.reload();
  await expect(page.getByTestId("boot-notice")).toContainText("This device was signed out.");
  await expect(page.getByTestId("account-link")).toHaveText("Sign in");
  await expect(page.getByTestId("deletion-banner")).toHaveCount(0);
  expect(await device.cspViolations()).toEqual([]);
});
