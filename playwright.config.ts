import { defineConfig, devices } from "@playwright/test";

/**
 * E2E runs against the production build (`pnpm build` first), as the Next.js guide recommends.
 * Two servers from the same build:
 * - OPEN   (port 3100): local mode, no trusted proxy.
 * - LOCKED (port 3101): TRUST_PROXY_MODE=cloudflare, so the origin lock is active (T-008).
 */

export const OPEN_URL = "http://127.0.0.1:3100";
export const LOCKED_URL = "http://127.0.0.1:3101";
export const E2E_ORIGIN_SECRET = "e2e-origin-secret-not-used-anywhere-else-0001";

const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: OPEN_URL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm exec next start -p 3100 -H 127.0.0.1",
      url: `${OPEN_URL}/api/v1/health`,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      env: { ...process.env, APP_ENV: "test", NEXT_PUBLIC_APP_ORIGIN: OPEN_URL } as Record<string, string>,
    },
    {
      command: "pnpm exec next start -p 3101 -H 127.0.0.1",
      // The origin lock answers 403 without the secret; Playwright treats 403 as "ready".
      url: `${LOCKED_URL}/api/v1/health`,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      env: {
        ...process.env,
        APP_ENV: "test",
        NEXT_PUBLIC_APP_ORIGIN: LOCKED_URL,
        TRUST_PROXY_MODE: "cloudflare",
        ORIGIN_SHARED_SECRET: E2E_ORIGIN_SECRET,
      } as Record<string, string>,
    },
  ],
});
