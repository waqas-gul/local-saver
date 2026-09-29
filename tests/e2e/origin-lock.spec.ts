import { expect, test } from "@playwright/test";
import { E2E_ORIGIN_SECRET, LOCKED_URL } from "../../playwright.config";

/**
 * T-008 against a real `next start` process with TRUST_PROXY_MODE=cloudflare.
 * Proves that requests which bypass Cloudflare (no valid X-Origin-Auth) are rejected
 * on every kind of path, and that forged client-IP headers don't help.
 */

test.use({ baseURL: LOCKED_URL });

for (const path of ["/", "/api/v1/health", "/robots.txt", "/favicon.ico"]) {
  test(`rejects ${path} without the origin secret`, async ({ request }) => {
    const response = await request.get(path, { headers: { "cf-connecting-ip": "1.1.1.1" } });
    expect(response.status()).toBe(403);
    expect(response.headers()["cache-control"]).toBe("no-store");
  });
}

test("rejects a forged origin secret", async ({ request }) => {
  const response = await request.get("/api/v1/health", {
    headers: { "x-origin-auth": "forged-secret-value-forged-secret-value", "x-forwarded-for": "1.1.1.1" },
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).error.code).toBe("FORBIDDEN");
});

test("serves requests that carry the origin secret", async ({ request }) => {
  const headers = { "x-origin-auth": E2E_ORIGIN_SECRET };
  const api = await request.get("/api/v1/health", { headers });
  expect(api.status()).toBe(200);
  const page = await request.get("/", { headers });
  expect(page.status()).toBe(200);
  expect(page.headers()["content-security-policy"]).toContain("'nonce-");
});
