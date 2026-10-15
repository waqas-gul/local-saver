import { expect, test } from "@playwright/test";
import { expectPhoneLayout, fitsScreen, newNetwork, openDevice } from "./support/local-devices";

/**
 * Phone widths (Phase 1 review of the AC-1.12 screenshots): header labels never break
 * mid-label, the one-time notice's title stays clear of its close button, nothing scrolls
 * sideways. The emulated phones (local-mobile.spec.ts) run the same checks on WebKit.
 */

for (const width of [320, 360, 375, 393, 412, 430]) {
  test(`phone layout at ${width}px`, async ({ browser }) => {
    const device = await openDevice(browser, newNetwork().ip(), { viewport: { width, height: 800 } }, { dismissNotice: false });
    await expectPhoneLayout(device.page);
  });
}

for (const width of [768, 1280]) {
  test(`wider screens keep the header on one row at ${width}px`, async ({ browser }) => {
    const { page } = await openDevice(browser, newNetwork().ip(), { viewport: { width, height: 800 } });
    const title = await page.getByRole("banner").getByText("Local Saver", { exact: true }).boundingBox();
    const device = await page.getByTestId("device-label").boundingBox();
    expect(Math.abs(title!.y + title!.height / 2 - (device!.y + device!.height / 2))).toBeLessThan(4);
    expect(await fitsScreen(page)).toBe(true);
  });
}
