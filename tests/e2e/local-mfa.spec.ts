import { expect, test, type Page } from "@playwright/test";
import { totp } from "../support/totp";
import { mailCode, newEmail, signInThroughUi } from "./support/accounts";
import { fitsScreen, newNetwork, openDevice, postText, unique } from "./support/local-devices";

/**
 * MFA in real browsers (phase 4 §17.5.9, P4-24; T4-A12): an account turns on an authenticator app in its settings (the
 * QR code and the key drawn in the page; a code computed from that key, as the app would); its other browser, signed in
 * before, is signed out by Supabase Auth and starts again without it; a third browser signs in by email code, merging
 * what it shared, and confirms with the authenticator before the app loads; the account removes the authenticator.
 * Codes come from mailpit; TOTP codes from the key shown at enrolment.
 */

async function settings(page: Page) {
  await page.getByTestId("account-link").click();
  await expect(page.getByTestId("mfa-panel")).toBeVisible();
}

test("an authenticator app: turned on in settings, then the account's browsers sign in with both codes; removed again", async ({ browser }) => {
  test.setTimeout(90_000);
  const email = newEmail("mfa");
  const first = await openDevice(browser, newNetwork().ip());
  await signInThroughUi(first.page, email);
  const second = await openDevice(browser, newNetwork().ip());
  await signInThroughUi(second.page, email, { merge: true });

  // Turn it on in the first browser: the QR code and the key, then a code from the key.
  await settings(first.page);
  await expect(first.page.getByTestId("mfa-status")).toContainText("Off");
  await first.page.getByTestId("mfa-setup").click();
  await expect(first.page.getByTestId("share-qr")).toBeVisible();
  const key = (await first.page.getByTestId("mfa-key").textContent())!.replace(/\s+/g, "");
  expect(key).toMatch(/^[A-Z2-7]{16,}$/);
  await first.page.getByTestId("mfa-code").fill(totp(key));
  await first.page.getByTestId("mfa-confirm").click();
  await expect(first.page.getByTestId("mfa-done")).toBeVisible();
  await expect(first.page.getByTestId("mfa-status")).toContainText("On");
  expect(await first.cspViolations()).toEqual([]);

  // The second browser was signed in before: Supabase Auth ended its session, so it starts again without the account.
  await second.page.goto("/");
  await expect(second.page.getByTestId("boot-notice")).toContainText("This device was signed out.");
  await expect(second.page.getByTestId("account-link")).toHaveText("Sign in");

  // A third browser shares something, signs in by email code (the merge), then the app asks for the authenticator.
  const third = await openDevice(browser, newNetwork().ip(), { viewport: { width: 320, height: 800 } });
  const text = unique("moves in after the authenticator");
  await postText(third, text);
  await third.page.getByTestId("account-link").click();
  await third.page.getByTestId("login-email").fill(email);
  await third.page.getByTestId("login-send").click();
  await expect(third.page.getByTestId("merge-offer")).toBeVisible();
  const since = new Date();
  await third.page.getByTestId("merge-continue").click();
  await expect(third.page.getByTestId("code-sent")).toBeVisible();
  await third.page.getByTestId("login-code").fill(await mailCode(email, since));
  await third.page.getByTestId("login-verify").click();
  await expect(third.page.getByTestId("mfa-gate")).toBeVisible();
  await expect(third.page.getByTestId("account-link")).toHaveCount(0);
  expect(await fitsScreen(third.page)).toBe(true);
  await third.page.getByTestId("mfa-gate-code").fill("000000");
  await third.page.getByTestId("mfa-gate-continue").click();
  await expect(third.page.getByTestId("mfa-gate").getByRole("alert")).toContainText("That code isn't right");
  await third.page.getByTestId("mfa-gate-code").fill(totp(key));
  await third.page.getByTestId("mfa-gate-continue").click();
  await expect(third.page.getByTestId("account-link")).toHaveText("Account");
  await third.page.getByRole("link", { name: "My uploads" }).click();
  await expect(third.page.getByTestId("my-uploads")).toContainText(text);

  // The first browser is still at aal2: it removes the authenticator with a fresh code.
  await first.page.reload();
  await expect(first.page.getByTestId("mfa-status")).toContainText("On");
  await first.page.getByTestId("mfa-remove").click();
  await first.page.getByTestId("mfa-remove-code").fill(totp(key));
  await first.page.getByTestId("mfa-remove-confirm").click();
  await expect(first.page.getByTestId("mfa-removed")).toBeVisible();
  await expect(first.page.getByTestId("mfa-status")).toContainText("Off");
});
