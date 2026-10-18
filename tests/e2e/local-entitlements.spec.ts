import { expect, test } from "@playwright/test";
import { newEmail, signInThroughUi } from "./support/accounts";
import { fitsScreen, newNetwork, openDevice, unique } from "./support/local-devices";
import { adminDb, closeAdminDb } from "./support/remote";

/**
 * Plans in real browsers (phase 4 §17.6.5, P4-11): the composer and the link dialog offer the
 * caller's plan's options, a Free refusal that Pro would allow shows the upgrade hint with a link to
 * the pricing page, and the pricing page fits a phone. Pro comes from an operator override, as
 * support grants it (billing is 4C).
 */

test.afterAll(closeAdminDb);

test("a Free browser gets Free's options and, past its text limit, the upgrade hint and the plans", async ({ browser }) => {
  const device = await openDevice(browser, newNetwork().ip());
  const { page } = device;
  await page.getByTestId("composer-expiry").click();
  await expect(page.getByRole("option", { name: "Expires after 7 days" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Expires after 30 days" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.getByTestId("composer-text").fill("x".repeat(100 * 1024 + 1));
  await expect(page.getByText("Text can be up to 100 KB.")).toBeVisible();
  await expect(page.getByTestId("composer-submit")).toBeDisabled();
  const hint = page.getByTestId("upgrade-hint");
  await expect(hint).toContainText("Pro allows texts up to 1.0 MB.");
  await hint.getByRole("link", { name: "See plans" }).click();
  await expect(page).toHaveURL(/\/pricing$/);
  await expect(page.getByTestId("pricing-row-maxTextBytes")).toContainText("1.0 MB");
  expect(await device.cspViolations()).toEqual([]);
});

test("a Pro account gets Pro's options: a 90-day share, longer texts, a 30-day link and a 7-day code", async ({ browser }) => {
  const device = await openDevice(browser, newNetwork().ip());
  const { page } = device;
  const email = newEmail("pro");
  await signInThroughUi(page, email);
  const { rows } = await adminDb().query("select id from auth.users where email = $1", [email]);
  await adminDb().query("select app.admin_grant_override($1, 'plan', '\"pro\"', 'e2e', 'tests')", [rows[0].id]);
  // The plan is read on every request; the page asks again on its next load.
  await page.reload();

  await page.getByTestId("composer-expiry").click();
  await page.getByRole("option", { name: "Expires after 90 days" }).click();
  const note = `${unique("pro note")} ${"y".repeat(150 * 1024)}`;
  await page.getByTestId("composer-text").fill(note);
  await expect(page.getByText(/Text can be up to/)).toHaveCount(0);
  await expect(page.getByTestId("upgrade-hint")).toHaveCount(0);
  const posted = page.waitForResponse((r) => r.url().endsWith("/api/v1/texts") && r.request().method() === "POST");
  await page.getByTestId("composer-submit").click();
  expect((await posted).status()).toBe(201);
  const card = page.getByTestId("share-card").filter({ hasText: note.slice(0, 20) });
  await expect(card).toContainText("Expires in 90 days");

  await card.getByRole("button", { name: "Share link" }).click();
  const dialog = page.getByTestId("share-link-dialog");
  await dialog.getByRole("combobox", { name: "Link expires" }).click();
  await expect(page.getByRole("option", { name: "For 30 days" })).toBeVisible();
  await page.getByRole("option", { name: "For 30 days" }).click();
  await dialog.getByTestId("with-code").check();
  await dialog.getByRole("combobox", { name: "Code expires" }).click();
  await page.getByRole("option", { name: "Code for 7 days" }).click();
  const created = page.waitForResponse((r) => /\/api\/v1\/shares\/[^/]+\/links$/.test(r.url()) && r.request().method() === "POST");
  await dialog.getByTestId("create-link").click();
  expect((await created).status()).toBe(201);
  await expect(dialog.getByTestId("share-code")).toBeVisible();
  expect(await device.cspViolations()).toEqual([]);
});

for (const width of [320, 375]) {
  test(`the pricing page fits a ${width} px phone, with no third-party requests`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 740 } });
    const page = await context.newPage();
    const foreign: string[] = [];
    // The app is served from 127.0.0.1; anything else would be a third party.
    page.on("request", (request) => {
      const url = request.url();
      if (!url.startsWith("data:") && new URL(url).hostname !== "127.0.0.1") foreign.push(url);
    });
    await page.goto("/pricing");
    await expect(page.getByRole("heading", { name: "Plans" })).toBeVisible();
    await expect(page.getByTestId("pricing-table")).toBeVisible();
    await expect(page.getByTestId("pro-price")).toHaveText("[OWNER: price]");
    expect(await fitsScreen(page)).toBe(true);
    const table = await page.getByTestId("pricing-table").boundingBox();
    expect(table && table.x >= 0 && table.x + table.width <= width).toBe(true);
    expect(foreign).toEqual([]);
    await context.close();
  });
}
