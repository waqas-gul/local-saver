import { defineConfig, devices } from "@playwright/test";
import { LOCAL, STORAGE, supabaseStatus } from "./scripts/local-stack.cjs";
import { FAKE_BILLING } from "./tests/support/fake-billing";

/**
 * E2E runs against the production build (`pnpm build` first), as the Next.js guide recommends.
 * Servers from the same build:
 * - OPEN   (port 3100): local mode, no trusted proxy, no services (Phase 0 smoke tests).
 * - LOCKED (port 3101): TRUST_PROXY_MODE=cloudflare, so the origin lock is active (T-008).
 * - STACK  (port 3102): the full local stack (Supabase, RustFS) with the test client-IP
 *   override, for the Phase 1 multi-device and Phase 2 remote-sharing tests
 *   (tests/e2e/local-*.spec.ts). Started only when the local stack is running (`pnpm stack:start`).
 *   Phase 4C: its billing provider is the fake one (tests/support/fake-billing.ts), which global
 *   setup starts on BILLING_PORT, hosted checkout pages included.
 */

export const OPEN_URL = "http://127.0.0.1:3100";
export const LOCKED_URL = "http://127.0.0.1:3101";
export const STACK_URL = "http://127.0.0.1:3102";
export const E2E_ORIGIN_SECRET = "e2e-origin-secret-not-used-anywhere-else-0001";
export const BILLING_PORT = 3197;

const isCI = Boolean(process.env.CI);

/**
 * Supabase status of the local stack, probed once in the main process and handed to the
 * workers through the environment (each worker re-evaluates this file).
 */
function localSupabase(): ReturnType<typeof supabaseStatus> | null {
  const cached = process.env.LOCAL_SAVER_E2E_STACK;
  if (cached !== undefined) return cached === "none" ? null : JSON.parse(cached);
  try {
    const status = supabaseStatus();
    process.env.LOCAL_SAVER_E2E_STACK = JSON.stringify(status);
    return status;
  } catch {
    process.env.LOCAL_SAVER_E2E_STACK = "none";
    console.warn("Local stack not running: skipping the Phase 1 E2E project (pnpm stack:start).");
    return null;
  }
}

function stackServer() {
  const supabase = localSupabase();
  if (!supabase) return null;
  return {
    command: "pnpm exec next start -p 3102 -H 127.0.0.1",
    url: `${STACK_URL}/api/v1/health`,
    reuseExistingServer: !isCI,
    timeout: 120_000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      APP_ENV: "test",
      ALLOW_TEST_CLIENT_IP: "1",
      NEXT_PUBLIC_APP_ORIGIN: STACK_URL,
      APP_ALLOWED_ORIGINS: STACK_URL,
      DATABASE_URL: LOCAL.appServerDatabaseUrl,
      NEXT_PUBLIC_SUPABASE_URL: supabase.url,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: supabase.publishableKey,
      SUPABASE_SECRET_KEY: supabase.secretKey,
      R2_ACCOUNT_ID: "local",
      R2_BUCKET: STORAGE.bucket,
      R2_S3_ENDPOINT: STORAGE.endpoint,
      R2_ACCESS_KEY_ID: STORAGE.accessKeyId,
      R2_SECRET_ACCESS_KEY: STORAGE.secretAccessKey,
      NETWORK_KEY_SECRET_CURRENT: LOCAL.networkKeySecret,
      // Phase 2 remote links and codes. No Turnstile here: reports and code checks run without it.
      LINK_PEPPER: LOCAL.linkPepper,
      CODE_PEPPER: LOCAL.codePepper,
      // Phase 3: global setup turns free_burn_after_download on for the run; apply flags at once.
      RUNTIME_FLAGS_CACHE_SECONDS: "0",
      LOG_LEVEL: "warn",
      // Phase 4C: the fake billing provider (tests and local development only).
      BILLING_PROVIDER: "fake",
      BILLING_API_KEY: FAKE_BILLING.apiKey,
      BILLING_WEBHOOK_SECRET: FAKE_BILLING.webhookSecret,
      BILLING_PRICE_PRO_MONTH: FAKE_BILLING.prices.month,
      BILLING_PRICE_PRO_YEAR: FAKE_BILLING.prices.year,
      BILLING_FAKE_API_URL: `http://127.0.0.1:${BILLING_PORT}`,
      BILLING_RECONCILE_SECRET: LOCAL.billingReconcileSecret,
    } as Record<string, string>,
  };
}

const stack = stackServer();

export default defineConfig({
  testDir: "tests/e2e",
  // Shared runtime flags are set once here, never per file: parallel files would race over them.
  globalSetup: "./tests/e2e/support/global-setup.ts",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: OPEN_URL, trace: "retain-on-failure" },
  projects: [
    // Match on the file name only: the repository folder ("local-saver") also starts with "local-".
    { name: "chromium", testIgnore: /[\\/]local-[^\\/]*\.spec\.ts$/, use: { ...devices["Desktop Chrome"] } },
    ...(stack
      ? [
          {
            name: "local",
            testMatch: /[\\/]local-[^\\/]*\.spec\.ts$/,
            testIgnore: /[\\/]local-mobile\.spec\.ts$/,
            use: { ...devices["Desktop Chrome"], baseURL: STACK_URL },
          },
          // Emulated phones: a layout and flow pre-check, not real-device evidence (AC-1.6).
          { name: "local-mobile-webkit", testMatch: /[\\/]local-mobile\.spec\.ts$/, use: { ...devices["iPhone 15"], baseURL: STACK_URL } },
          { name: "local-mobile-chromium", testMatch: /[\\/]local-mobile\.spec\.ts$/, use: { ...devices["Pixel 7"], baseURL: STACK_URL } },
        ]
      : []),
  ],
  webServer: [
    {
      command: "pnpm exec next start -p 3100 -H 127.0.0.1",
      url: `${OPEN_URL}/api/v1/health`,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      // NODE_ENV=test: Next.js then ignores a developer's .env.local (production build, strict CSP either way).
      env: { ...process.env, NODE_ENV: "test", APP_ENV: "test", NEXT_PUBLIC_APP_ORIGIN: OPEN_URL } as Record<string, string>,
    },
    {
      command: "pnpm exec next start -p 3101 -H 127.0.0.1",
      // The origin lock answers 403 without the secret; Playwright treats 403 as "ready".
      url: `${LOCKED_URL}/api/v1/health`,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      env: {
        ...process.env,
        NODE_ENV: "test",
        APP_ENV: "test",
        NEXT_PUBLIC_APP_ORIGIN: LOCKED_URL,
        TRUST_PROXY_MODE: "cloudflare",
        ORIGIN_SHARED_SECRET: E2E_ORIGIN_SECRET,
      } as Record<string, string>,
    },
    ...(stack ? [stack] : []),
  ],
});
