import { expect, test, type Page } from "@playwright/test";
import { mailCode, mailLink, newEmail, signInThroughUi } from "./support/accounts";
import { fitsScreen, newNetwork, openDevice, postText, unique } from "./support/local-devices";

/**
 * Accounts in real browsers (phase 4 §17.5; T4-A1c, T-053.1, T-053.3, T4-A9, T4-A11): the upgrade
 * keeps what an anonymous browser shared, signing in to an existing account moves it there (the
 * merge), an account's other browser can be signed out, and signing out starts a new anonymous
 * session. Codes come from mailpit. P4-23: the email's link, past a mail scanner.
 */

async function myUploads(page: Page) {
  await page.getByRole("link", { name: "My uploads" }).click();
  return page.getByTestId("my-uploads");
}

test("an anonymous browser signs up by email code and keeps what it shared (upgrade)", async ({ browser }) => {
  const device = await openDevice(browser, newNetwork().ip());
  const text = unique("before signing up");
  await postText(device, text);
  await expect(device.page.getByTestId("account-link")).toHaveText("Sign in");

  const email = newEmail("upgrade");
  await signInThroughUi(device.page, email);
  await expect(await myUploads(device.page)).toContainText(text);

  await device.page.getByTestId("account-link").click();
  await expect(device.page.getByTestId("account-email")).toHaveText(`${email[0]}•••@example.com`);
  await expect(device.page.getByTestId("account-methods")).toContainText("Email code");
  expect(await device.cspViolations()).toEqual([]);
});

test("signing in to an existing account moves this browser's uploads into it (merge), and the account can sign the other browser out", async ({ browser }) => {
  const email = newEmail("merge");
  const first = await openDevice(browser, newNetwork().ip());
  await signInThroughUi(first.page, email);

  const second = await openDevice(browser, newNetwork().ip());
  const text = unique("from the second browser");
  await postText(second, text);
  await signInThroughUi(second.page, email, { merge: true });
  await expect(await myUploads(second.page)).toContainText(text);

  // The first browser is the same account: it sees the moved share too.
  await expect(await myUploads(first.page)).toContainText(text);

  // Devices: the first browser signs the second out.
  await first.page.goto("/settings/devices");
  const list = first.page.getByTestId("device-list");
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByText("This device")).toHaveCount(1);
  const other = list.getByRole("listitem").filter({ hasNotText: "This device" });
  await other.getByTestId("revoke-device").click();
  await first.page.getByTestId("confirm-revoke").click();
  await expect(other).toContainText("Signed out");

  // The second browser's next start: signed out, told so, and anonymous again.
  await second.page.reload();
  await expect(second.page.getByTestId("boot-notice")).toContainText("This device was signed out.");
  await expect(second.page.getByTestId("account-link")).toHaveText("Sign in");
  await expect(await myUploads(second.page)).not.toContainText(text);
  expect(await second.cspViolations()).toEqual([]);
});

test("signing out starts a new anonymous session in this browser, without the account's data", async ({ browser }) => {
  const device = await openDevice(browser, newNetwork().ip());
  const text = unique("account only");
  await signInThroughUi(device.page, newEmail("signout"));
  await postText(device, text);

  await device.page.getByTestId("account-link").click();
  await device.page.getByTestId("sign-out").click();
  await expect(device.page).toHaveURL(/\/$/);
  await expect(device.page.getByTestId("account-link")).toHaveText("Sign in");
  await expect(await myUploads(device.page)).not.toContainText(text);
});

test("an account changes its email with a code from each address (P4-08)", async ({ browser }) => {
  const device = await openDevice(browser, newNetwork().ip());
  const before = newEmail("old");
  const after = newEmail("new");
  await signInThroughUi(device.page, before);
  await device.page.getByTestId("account-link").click();
  await device.page.getByTestId("change-email").click();
  await device.page.getByLabel("New email").fill(after);
  const since = new Date();
  await device.page.getByRole("button", { name: "Send code" }).click();
  await device.page.getByLabel("Code sent to your current email").fill(await mailCode(before, since));
  await device.page.getByLabel("Code sent to the new email").fill(await mailCode(after, since));
  await device.page.getByRole("button", { name: "Continue" }).click();
  await expect(device.page.getByText("Your email is changed.")).toBeVisible();
  await expect(device.page.getByTestId("account-email")).toHaveText(`${after[0]}•••@example.com`);
});

test("the link in the email: a mail scanner opening it uses nothing up, and Continue signs this browser in (P4-23)", async ({ browser }) => {
  const context = await browser.newContext();
  const ip = newNetwork().ip();
  await context.route(/\/api\/v1\//, (route) => route.continue({ headers: { ...route.request().headers(), "x-test-client-ip": ip } }));
  const page = await context.newPage();
  await page.goto("/login");
  const email = newEmail("link");
  await page.getByTestId("login-email").fill(email);
  const since = new Date();
  await page.getByTestId("login-send").click();
  await expect(page.getByTestId("login-resend")).toBeDisabled();
  const link = await mailLink(email, since);
  expect(new URL(link).pathname).toBe("/auth/callback");

  // A scanner that even runs the page's script: it sees the button, and presses nothing.
  const scanner = await browser.newContext();
  const scan = await scanner.newPage();
  await scan.goto(link);
  await expect(scan.getByTestId("callback-continue")).toBeVisible();
  await scanner.close();

  await page.goto(link);
  await expect(page.getByTestId("callback-continue")).toBeVisible();
  await page.getByTestId("callback-continue").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("account-link")).toHaveText("Account");
  await context.close();
});

for (const width of [320, 375]) {
  test(`the sign-in and account pages fit a ${width}px phone`, async ({ browser }) => {
    const device = await openDevice(browser, newNetwork().ip(), { viewport: { width, height: 800 } });
    await device.page.getByTestId("account-link").click();
    await expect(device.page.getByTestId("login-email")).toBeVisible();
    expect(await fitsScreen(device.page)).toBe(true);
    await device.page.goto("/settings/devices");
    await expect(device.page.getByRole("link", { name: "Sign in" }).first()).toBeVisible();
    expect(await fitsScreen(device.page)).toBe(true);
  });
}
