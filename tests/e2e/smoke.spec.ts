import { expect, test } from "@playwright/test";

/** Phase 0 smoke tests (T-047 basics, T-048, AC-0.3). */

function nonceFrom(csp: string): string {
  const match = csp.match(/'nonce-([^']+)'/);
  if (!match?.[1]) throw new Error(`no nonce in CSP: ${csp}`);
  return match[1];
}

test("home page renders with a nonce-based CSP and hydrates without CSP violations", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __csp: string[] }).__csp ??= [];
      (window as unknown as { __csp: string[] }).__csp.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });

  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Local Saver" })).toBeVisible();
  await page.waitForLoadState("networkidle");

  // The Next.js client runtime executed, so its nonce-carrying scripts were allowed.
  const nextVersion = await page.evaluate(() => (window as unknown as { next?: { version?: string } }).next?.version);
  expect(typeof nextVersion).toBe("string");

  const pageViolations = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
  expect([...violations, ...pageViolations]).toEqual([]);
});

test("shadcn/ui theme tokens and the Geist font apply to the page", async ({ page }) => {
  await page.goto("/");
  const style = await page.evaluate(() => ({
    token: getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
    background: getComputedStyle(document.body).backgroundColor,
    fontFamily: getComputedStyle(document.body).fontFamily,
  }));
  // The build rewrites oklch() colours, so check that the token exists and is applied.
  expect(style.token).not.toBe("");
  expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(style.fontFamily).toMatch(/Geist/);
});

test("document responses carry the security headers (T-048)", async ({ request }) => {
  const response = await request.get("/");
  const headers = response.headers();
  const csp = headers["content-security-policy"] ?? "";

  expect(csp).toContain("script-src 'self' 'nonce-");
  expect(csp).toContain("'strict-dynamic'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain("unsafe-eval");
  // Radix style="" attributes are allowed; <style> elements still need the nonce (F-7).
  expect(csp).toContain("style-src 'self' 'nonce-");
  expect(csp).toContain("style-src-attr 'unsafe-inline'");
  // Local HTTP: no HSTS and no upgrade-insecure-requests.
  expect(csp).not.toContain("upgrade-insecure-requests");
  expect(headers["strict-transport-security"]).toBeUndefined();

  expect(headers["x-powered-by"]).toBeUndefined();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
});

test("every script tag in the HTML carries this response's nonce (T-048)", async ({ request }) => {
  const response = await request.get("/");
  const nonce = nonceFrom(response.headers()["content-security-policy"] ?? "");
  const html = await response.text();
  const scripts = html.match(/<script\b[^>]*>/g) ?? [];
  expect(scripts.length).toBeGreaterThan(0);
  for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
});

test("each request gets a fresh nonce", async ({ request }) => {
  const a = nonceFrom((await request.get("/")).headers()["content-security-policy"] ?? "");
  const b = nonceFrom((await request.get("/")).headers()["content-security-policy"] ?? "");
  expect(a).not.toBe(b);
});

test("health endpoint returns no-store JSON with a locked-down CSP", async ({ request }) => {
  const response = await request.get("/api/v1/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ status: "ok" });
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(response.headers()["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
  expect(response.headers()["x-robots-tag"]).toBe("noindex, nofollow");

  const ready = await request.get("/api/v1/health?ready=1");
  expect(await ready.json()).toMatchObject({ status: "ok", checks: { database: "not_configured" } });
});

test("robots.txt keeps share, code, invite, room and API routes out of search engines", async ({ request }) => {
  const body = await (await request.get("/robots.txt")).text();
  for (const path of ["/api/", "/s/", "/j/", "/c", "/rooms/"]) expect(body).toContain(`Disallow: ${path}`);
});
