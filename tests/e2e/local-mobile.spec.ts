import { expect, test } from "@playwright/test";
import { expectPhoneLayout, feed, fitsScreen, newNetwork, openDevice, PNG_1X1, postText, unique } from "./support/local-devices";

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
