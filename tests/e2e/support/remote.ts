import { expect, type Browser, type Page } from "@playwright/test";
import pg from "pg";
import { decodeQR } from "qr/decode.js";
import { LOCAL, STORAGE } from "../../../scripts/local-stack.cjs";
import { STACK_URL } from "../../../playwright.config";
import type { SimDevice } from "./local-devices";

/**
 * Phase 2 E2E helpers: link viewers (a browser with no app session, on its own simulated
 * network), the creator's share-link dialog, decoding the rendered QR code, and admin database
 * access for expiry and takedown.
 */

export type Viewer = {
  page: Page;
  /** Every URL the viewer's browser requested (third-party check, AC-2.9). */
  requests: string[];
  cspViolations: () => Promise<string[]>;
};

/** A browser that only ever opens share and code pages: never "/" (no anonymous sign-in). */
export async function openViewer(browser: Browser, ip: string, options: { viewport?: { width: number; height: number } } = {}): Promise<Viewer> {
  const context = await browser.newContext({ acceptDownloads: true, ...(options.viewport ? { viewport: options.viewport } : {}) });
  await context.route(/\/api\/v1\//, (route) => route.continue({ headers: { ...route.request().headers(), "x-test-client-ip": ip } }));
  const page = await context.newPage();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const w = window as unknown as { __csp?: string[] };
      (w.__csp ??= []).push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return {
    page,
    requests,
    cspViolations: () => page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []),
  };
}

/** Only the app itself and the storage endpoint (presigned downloads and previews) may be contacted. */
export function thirdPartyRequests(viewer: Viewer): string[] {
  const storage = new URL(STORAGE.endpoint).origin;
  return viewer.requests.filter((url) => {
    if (url.startsWith("data:") || url.startsWith("blob:")) return false;
    const origin = new URL(url).origin;
    return origin !== STACK_URL && origin !== storage;
  });
}

/** Make the viewer's page refetch now, as a returning tab would (TanStack Query listens on window). */
export async function refocus(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
}

/** Open "Share link" on the creator's card for `text`, create a link, and return its URL (and code). */
export async function createLinkFor(device: SimDevice, text: string, options: { code?: boolean } = {}) {
  const card = device.page.getByTestId("share-card").filter({ hasText: text });
  await card.getByRole("button", { name: "Share link" }).click();
  return createLinkInDialog(device.page, options);
}

export async function createLinkInDialog(page: Page, options: { code?: boolean } = {}) {
  const dialog = page.getByTestId("share-link-dialog");
  await expect(dialog).toBeVisible();
  if (options.code) await dialog.getByTestId("with-code").check();
  const created = page.waitForResponse((r) => /\/api\/v1\/shares\/[^/]+\/links$/.test(r.url()) && r.request().method() === "POST");
  await dialog.getByTestId("create-link").click();
  expect((await created).status()).toBe(201);
  const url = await dialog.getByTestId("share-link-url").inputValue();
  const code = options.code ? ((await dialog.getByTestId("share-code").textContent()) ?? "") : null;
  return { url, code, dialog };
}

/** Decode the QR code exactly as the dialog drew it (its SVG modules), as a camera would read it. */
export async function decodeShownQr(page: Page): Promise<string> {
  const svg = page.getByTestId("share-qr");
  const viewBox = (await svg.getAttribute("viewBox")) ?? "";
  const path = (await svg.locator("path").getAttribute("d")) ?? "";
  const modules = Number(viewBox.split(" ")[2]);
  const dark = new Set(Array.from(path.matchAll(/M(\d+) (\d+)h1v1h-1z/g), (m) => `${m[1]},${m[2]}`));
  const scale = 4;
  const width = modules * scale;
  const data = new Uint8Array(width * width * 4);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const value = dark.has(`${Math.floor(x / scale)},${Math.floor(y / scale)}`) ? 0 : 255;
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  return decodeQR({ width, height: width, data });
}

let pool: pg.Pool | undefined;

/** Superuser access to the local database, for expiry and takedown steps. */
export function adminDb(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: LOCAL.adminDatabaseUrl, max: 2 });
  return pool;
}

export async function closeAdminDb() {
  await pool?.end();
  pool = undefined;
}

/**
 * The burn specs need Free burn after download on. Global setup switches it on once for the
 * whole run (tests/e2e/support/global-setup.ts); tests only read it, so parallel files can't race.
 */
export async function expectFreeBurnOn(): Promise<void> {
  const { rows } = await adminDb().query("select enabled from app.runtime_flags where key = 'free_burn_after_download'");
  expect(rows[0]?.enabled, "free_burn_after_download must be on: the E2E global setup sets it").toBe(true);
}

export const linkIdOf = (url: string) => new URL(url).pathname.split("/").pop() ?? "";
