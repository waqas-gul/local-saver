import { expect, test, type Page } from "@playwright/test";
import { newEmail, signInThroughUi } from "./support/accounts";
import { newNetwork, openDevice, postText, unique } from "./support/local-devices";
import { adminDb, closeAdminDb, openViewer, thirdPartyRequests } from "./support/remote";

/**
 * Link passwords in a real browser (phase 4 §17.8.3, §17.14, P4-16). A Pro creator protects a new link; a
 * viewer elsewhere gets the prompt, never the content, until the right password; a reload keeps access; a
 * code leads to the same prompt. Removing the password ends the grants, and the link opens without one. A
 * Free creator is never offered a password. No third-party requests on the share page.
 */

test.afterAll(closeAdminDb);

const PASSWORD = "violet harbour 71";

async function signInAsPro(page: Page, label: string): Promise<void> {
  const email = newEmail(label);
  await signInThroughUi(page, email);
  const { rows } = await adminDb().query("select id from auth.users where email = $1", [email]);
  await adminDb().query("select app.admin_grant_override($1, 'plan', '\"pro\"', 'e2e', 'tests')", [rows[0].id]);
  await page.reload();
}

const cardOf = (page: Page, text: string) => page.getByTestId("share-card").filter({ hasText: text });

test("a Pro creator protects a link; a viewer needs the password, by link or by code; removing it opens the link again", async ({ browser }) => {
  test.setTimeout(120_000);
  const creator = await openDevice(browser, newNetwork().ip());
  await signInAsPro(creator.page, "password");
  const text = unique("behind a password");
  await postText(creator, text);

  await cardOf(creator.page, text).getByRole("button", { name: "Share link" }).click();
  const dialog = creator.page.getByTestId("share-link-dialog");
  await dialog.getByTestId("with-code").check();
  await dialog.getByTestId("with-password").check();
  await dialog.getByLabel("Link password").fill(PASSWORD);
  const created = creator.page.waitForResponse((r) => /\/api\/v1\/shares\/[^/]+\/links$/.test(r.url()) && r.request().method() === "POST");
  await dialog.getByTestId("create-link").click();
  expect((await created).status()).toBe(201);
  const url = await dialog.getByTestId("share-link-url").inputValue();
  const code = (await dialog.getByTestId("share-code").textContent()) ?? "";
  await expect(dialog.getByTestId("created-link-password")).toBeVisible();
  await expect(dialog.getByTestId("link-password-badge")).toBeVisible();

  // A viewer on another network: the prompt, nothing of the share, and the secret gone from the address bar.
  const viewer = await openViewer(browser, newNetwork().ip());
  await viewer.page.goto(url);
  await expect(viewer.page.getByTestId("password-prompt")).toBeVisible();
  await expect(viewer.page.getByText(text)).toHaveCount(0);
  expect(new URL(viewer.page.url()).hash).toBe("");

  const input = viewer.page.getByTestId("password-input");
  await input.fill("not the password");
  await viewer.page.getByTestId("password-submit").click();
  await expect(viewer.page.getByTestId("password-prompt").getByRole("alert")).toHaveText("That password isn't right.");
  await expect(input).toHaveValue("");
  await input.fill(PASSWORD);
  await viewer.page.getByTestId("password-submit").click();
  await expect(viewer.page.getByTestId("shared-text")).toHaveText(text);
  // The grant is verified: a reload (no fragment) shows the share without asking again.
  await viewer.page.reload();
  await expect(viewer.page.getByTestId("shared-text")).toHaveText(text);

  // By code: the code page leads to the same prompt.
  const byCode = await openViewer(browser, newNetwork().ip());
  await byCode.page.goto("/c");
  await byCode.page.getByTestId("code-input").fill(code);
  await byCode.page.getByTestId("code-submit").click();
  await expect(byCode.page.getByTestId("password-prompt")).toBeVisible();
  await expect(byCode.page.getByText(text)).toHaveCount(0);
  await byCode.page.getByTestId("password-input").fill(PASSWORD);
  await byCode.page.getByTestId("password-submit").click();
  await expect(byCode.page.getByTestId("shared-text")).toHaveText(text);

  // Removing the password ends every grant; the full link then opens without one.
  const removed = creator.page.waitForResponse((r) => /\/api\/v1\/links\/[^/]+$/.test(r.url()) && r.request().method() === "PATCH");
  await dialog.getByRole("button", { name: "Remove password" }).click();
  expect((await removed).status()).toBe(200);
  await expect(dialog.getByTestId("link-password-badge")).toHaveCount(0);
  await viewer.page.reload();
  await expect(viewer.page.getByTestId("viewer-state")).toBeVisible();
  await expect(viewer.page.getByText(text)).toHaveCount(0);
  // Opened again in a new tab (going to the same path with only a new fragment wouldn't reload the page).
  const again = await viewer.page.context().newPage();
  await again.goto(url);
  await expect(again.getByTestId("shared-text")).toHaveText(text);
  await expect(again.getByTestId("password-prompt")).toHaveCount(0);

  for (const page of [viewer, byCode]) {
    expect(thirdPartyRequests(page)).toEqual([]);
    expect(await page.cspViolations()).toEqual([]);
  }
  expect(await creator.cspViolations()).toEqual([]);
});

test("a Free creator is never offered a password", async ({ browser }) => {
  const device = await openDevice(browser, newNetwork().ip());
  const text = unique("free link");
  await postText(device, text);
  await cardOf(device.page, text).getByRole("button", { name: "Share link" }).click();
  const dialog = device.page.getByTestId("share-link-dialog");
  await expect(dialog.getByTestId("create-link")).toBeVisible();
  await expect(dialog.getByTestId("with-code")).toBeVisible();
  // The plan has loaded (the dialog reads the same cached query) and has no linkPasswords.
  await expect
    .poll(() => device.page.evaluate(() => performance.getEntriesByType("resource").some((e) => e.name.endsWith("/api/v1/me/entitlements"))))
    .toBe(true);
  await expect(dialog.getByTestId("with-password")).toHaveCount(0);
  await expect(dialog.getByLabel("Link password")).toHaveCount(0);
});
