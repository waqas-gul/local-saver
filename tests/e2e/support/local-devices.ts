import { randomBytes } from "node:crypto";
import { expect, type Browser, type BrowserContextOptions, type Locator, type Page } from "@playwright/test";

/**
 * Simulated devices for the Phase 1 E2E specs: each browser context is a separate device with
 * its own anonymous user, on a simulated network (X-Test-Client-IP on same-origin API calls).
 */

export type SimDevice = { page: Page; moveTo: (ip: string) => Promise<void>; cspViolations: () => Promise<string[]> };

export function newNetwork() {
  const a = randomBytes(2).toString("hex");
  const b = randomBytes(2).toString("hex");
  let host = 0;
  return { ip: () => `2001:db8:${a}:${b}::${(++host).toString(16)}` };
}

export const unique = (label: string) => `${label} ${randomBytes(3).toString("hex")}`;

// A valid 1×1 PNG, so the preview really decodes.
export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export async function openDevice(
  browser: Browser,
  ip: string,
  options: BrowserContextOptions = {},
  { dismissNotice = true }: { dismissNotice?: boolean } = {},
): Promise<SimDevice> {
  const context = await browser.newContext(options);
  let current = ip;
  await context.route(/\/api\/v1\//, (route) =>
    route.continue({ headers: { ...route.request().headers(), "x-test-client-ip": current } }),
  );
  const page = await context.newPage();
  const consoleViolations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) consoleViolations.push(message.text());
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const w = window as unknown as { __csp?: string[] };
      (w.__csp ??= []).push(`${event.violatedDirective} ${event.blockedURI} at ${event.sourceFile}:${event.lineNumber}:${event.columnNumber}`);
    });
  });
  await page.goto("/");
  // The one-time notice (DEC-033) appears once the network is known to be ok.
  if (dismissNotice) await page.getByRole("button", { name: "Got it" }).click();
  return {
    page,
    moveTo: async (next) => {
      current = next;
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
    },
    cspViolations: async () => [
      ...consoleViolations,
      ...(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])),
    ],
  };
}

export async function postText(device: SimDevice, text: string) {
  await device.page.getByTestId("composer-text").fill(text);
  const posted = device.page.waitForResponse((r) => r.url().endsWith("/api/v1/texts") && r.status() === 201);
  await device.page.getByTestId("composer-submit").click();
  await posted;
}

export const feed = (device: SimDevice) => device.page.getByTestId("local-feed");

type Box = { x: number; y: number; width: number; height: number };

/** One box per rendered line of the element's text (labels must not break mid-label). */
export async function textLineBoxes(locator: Locator): Promise<Box[]> {
  return locator.evaluate((el) => {
    const rects: { x: number; y: number; width: number; height: number }[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of Array.from(range.getClientRects())) {
        if (r.width > 0) rects.push({ x: r.x, y: r.y, width: r.width, height: r.height });
      }
    }
    rects.sort((a, b) => a.y - b.y);
    // Rects of one line share (almost) the same top.
    return rects.filter((r, i) => i === 0 || r.y - rects[i - 1]!.y > 4);
  });
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export async function fitsScreen(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

/**
 * Phone-width checks (Phase 1 review): the one-time notice's title stays clear of its close
 * button, and the header labels each stay on one line. Call on a page showing the notice.
 */
export async function expectPhoneLayout(page: Page) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  const close = await dialog.getByRole("button", { name: "Close" }).boundingBox();
  const title = await textLineBoxes(dialog.getByRole("heading"));
  expect(close).not.toBeNull();
  expect(title.length).toBeGreaterThan(0);
  for (const line of title) expect(overlaps(line, close!), "notice title overlaps the close button").toBe(false);
  await page.getByRole("button", { name: "Got it" }).click();

  const header = page.getByRole("banner");
  const labels = [
    header.getByText("Local Saver", { exact: true }),
    header.getByRole("link", { name: "This network" }),
    header.getByRole("link", { name: "My uploads" }),
    page.getByTestId("device-label"),
    page.getByTestId("network-line"),
    page.getByTestId("audience-line"),
  ];
  for (const label of labels) {
    await expect(label).toBeInViewport();
    expect(await textLineBoxes(label), `${await label.textContent()} breaks onto several lines`).toHaveLength(1);
  }
  expect(await fitsScreen(page)).toBe(true);
}
