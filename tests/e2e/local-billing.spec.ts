import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { BILLING_PORT } from "../../playwright.config";
import { newEmail, signInThroughUi } from "./support/accounts";
import { fitsScreen, newNetwork, openDevice } from "./support/local-devices";

/**
 * Billing in real browsers (phase 4 §17.7.6, §17.14, T4-B5) against the fake provider's hosted
 * checkout and portal (no real provider until Q-005): the return page with forged parameters never
 * shows Pro; paying on the provider's page does, once its webhook reached the server; the page fits
 * a phone.
 */

const PROVIDER = new RegExp(`^http://127\\.0\\.0\\.1:${BILLING_PORT}/`);

async function entitlementsSeen(page: Page): Promise<{ plan: string }> {
  const response = await page.waitForResponse((r) => r.url().includes("/api/v1/me/entitlements") && r.status() === 200);
  return (await response.json()) as { plan: string };
}

test("forged return parameters never show Pro; paying on the provider's checkout does (T4-B5)", async ({ browser }) => {
  const device = await openDevice(browser, newNetwork().ip());
  const { page } = device;
  await signInThroughUi(page, newEmail("billing"));
  await page.getByTestId("account-link").click();
  await page.getByTestId("account-billing-link").click();
  await expect(page).toHaveURL(/\/settings\/billing$/);
  await expect(page.getByTestId("billing-plan")).toHaveText("Free");

  // Someone edits the return URL to claim a paid checkout: the page only waits for the server.
  const [forged] = await Promise.all([entitlementsSeen(page), page.goto(`/settings/billing?checkout=${randomUUID()}&success=true&plan=pro&status=active`)]);
  expect(forged.plan).toBe("free");
  await expect(page.getByTestId("billing-confirming")).toBeVisible();
  expect((await entitlementsSeen(page)).plan).toBe("free"); // it keeps asking, and the answer stays Free
  await expect(page.getByTestId("billing-plan")).toHaveText("Free");
  await expect(page.getByTestId("billing-confirmed")).toHaveCount(0);

  // The real path: the provider's hosted checkout, payment, back to the app.
  await page.goto("/settings/billing");
  await page.getByTestId("billing-subscribe-month").click();
  await expect(page).toHaveURL(PROVIDER);
  await page.getByTestId("fake-pay").click();
  await expect(page).toHaveURL(/\/settings\/billing\?checkout=[0-9a-f-]{36}$/);
  await expect(page.getByTestId("billing-confirmed")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("billing-plan")).toHaveText("Pro");
  await expect(page.getByTestId("billing-status")).toContainText("Renews on");
  await expect(page.getByTestId("billing-subscribe-month")).toHaveCount(0);

  // The provider's portal, and back.
  await page.getByTestId("billing-portal").click();
  await expect(page).toHaveURL(PROVIDER);
  await expect(page.getByTestId("fake-portal-customer")).toHaveText(/^cus_/);
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/settings\/billing$/);
  await expect(page.getByTestId("billing-plan")).toHaveText("Pro");
  expect(await device.cspViolations()).toEqual([]);
});

test("phone layout: plan and billing fits 320 px, signed out and signed in", async ({ browser }) => {
  const device = await openDevice(browser, newNetwork().ip(), { viewport: { width: 320, height: 640 } });
  const { page } = device;
  await page.goto("/settings/billing");
  await expect(page.getByTestId("billing-anonymous")).toBeVisible();
  expect(await fitsScreen(page)).toBe(true);

  await page.goto("/");
  await signInThroughUi(page, newEmail("billing-phone"));
  await page.goto("/settings/billing");
  for (const id of ["billing-plan", "billing-subscribe-month", "billing-subscribe-year"]) await expect(page.getByTestId(id)).toBeInViewport();
  expect(await fitsScreen(page)).toBe(true);
  expect(await device.cspViolations()).toEqual([]);
});
