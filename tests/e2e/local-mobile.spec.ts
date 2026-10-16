import { expect, test } from "@playwright/test";
import { expectPhoneLayout, feed, fitsScreen, newNetwork, openDevice, PNG_1X1, postText, unique } from "./support/local-devices";
import { closeAdminDb, expectFreeBurnOn } from "./support/remote";

/**
 * Emulated phones: Playwright's "iPhone 15" (WebKit) and "Pixel 7" (Chromium) profiles, set by
 * the local-mobile-* projects. A local pre-check of the phone layout and the phone upload flow
 * only. Emulation is not a phone (no iOS Safari, no real file picker, no mobile network), so it
 * is NOT evidence for AC-1.6; that needs the real-device run in phase-1-manual-verification.md.
 */

// A tiny but valid PDF (magic bytes %PDF).
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

test("phone layout: header labels on one line, notice title clear of its close button (emulated)", async ({ browser }) => {
  const device = await openDevice(browser, newNetwork().ip(), {}, { dismissNotice: false });
  await expectPhoneLayout(device.page);
});

test("a phone posts text, an image and a document; another phone on the network gets them live (emulated, not AC-1.6 evidence)", async ({ browser }) => {
  const net = newNetwork();
  const a = await openDevice(browser, net.ip());
  const b = await openDevice(browser, net.ip());
  expect(await fitsScreen(a.page)).toBe(true);

  const note = unique("from my phone");
  await postText(a, note);
  await expect(feed(b).getByText(note)).toBeVisible({ timeout: 5_000 });

  const doc = `${unique("report").replace(" ", "-")}.pdf`;
  await a.page.getByRole("tab", { name: "Files" }).click();
  await a.page.getByTestId("composer-files").setInputFiles([
    { name: "photo.png", mimeType: "image/png", buffer: PNG_1X1 },
    { name: doc, mimeType: "application/pdf", buffer: PDF },
  ]);
  await a.page.getByTestId("composer-submit").click();
  await expect(a.page.getByText(/^Shared/).first()).toBeVisible();

  await expect(feed(b).getByText(doc)).toBeVisible({ timeout: 5_000 });
  const preview = feed(b).getByRole("img", { name: "photo.png" });
  await expect(preview).toBeVisible();
  expect(await preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);

  const downloadPromise = b.page.waitForEvent("download");
  await feed(b).getByRole("button", { name: `Download ${doc}` }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(doc);

  expect(await fitsScreen(a.page)).toBe(true);
  expect(await fitsScreen(b.page)).toBe(true);
  expect(await a.cspViolations()).toEqual([]);
  expect(await b.cspViolations()).toEqual([]);
});

test("phone layout: the burn-after-download confirmation fits the screen, buttons in reach (emulated, Phase 3)", async ({ browser }) => {
  // Switched on once for the whole run by the E2E global setup, so parallel runs can't race over it.
  await expectFreeBurnOn();
  try {
    const net = newNetwork();
    const a = await openDevice(browser, net.ip());
    const b = await openDevice(browser, net.ip());
    const note = unique("burn on a phone");
    await a.page.getByTestId("composer-burn").check();
    await a.page.getByTestId("composer-text").fill(note);
    await a.page.getByTestId("composer-submit").click();
    await feed(b).getByTestId("burn-reveal").first().click({ timeout: 10_000 });
    const dialog = b.page.getByTestId("burn-confirm");
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    const viewport = b.page.viewportSize();
    expect(box && viewport && box.x >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height).toBe(true);
    await expect(b.page.getByTestId("burn-confirm-button")).toBeInViewport();
    await expect(b.page.getByRole("button", { name: "Cancel" })).toBeInViewport();
    expect(await fitsScreen(b.page)).toBe(true);
    await b.page.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await closeAdminDb();
  }
});
