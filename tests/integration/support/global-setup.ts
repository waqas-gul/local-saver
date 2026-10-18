import { spawn } from "node:child_process";
import { createWriteStream, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { ensureBucket, LOCAL, STORAGE, supabaseStatus } from "../../../scripts/local-stack.cjs";
import { FAKE_BILLING, FakeBillingProvider } from "../../support/fake-billing";

/**
 * Starts `next start` (production build, NODE_ENV=test) against the local stack:
 * Supabase (Postgres, Auth, Realtime) and RustFS. Requires `pnpm build` and `pnpm stack:start`.
 *
 * Phase 2: the server verifies Turnstile (code escalation, reports) against a local stand-in for
 * Cloudflare's siteverify endpoint: tokens starting "pass-" succeed once, anything else fails.
 * Its output goes to a log file the tests read (secrets must never appear there).
 *
 * Phase 4C: billing runs against the fake provider (tests/support/fake-billing.ts), started here on
 * its own port; tests drive it through its control API. The reconcile route's bearer secret has a
 * current and a previous value, as during a rotation.
 */

export type StackInfo = {
  origin: string;
  supabaseUrl: string;
  publishableKey: string;
  /** Phase 4: the Auth admin API for account fixtures (never used by the app's browser code). */
  secretKey: string;
  /** Phase 4: mailpit, where the sign-in and confirmation codes land. */
  mailpitUrl: string | null;
  adminDatabaseUrl: string;
  storage: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };
  /** The integration server's stdout and stderr. */
  serverLog: string;
  /** Phase 4C: the fake billing provider and the reconcile route's secrets. */
  billing: { url: string; reconcileSecret: string; previousReconcileSecret: string };
};

declare module "vitest" {
  export interface ProvidedContext {
    stack: StackInfo;
  }
}

const PORT = 3200;
const TURNSTILE_PORT = 3299;
const BILLING_PORT = 3298;
export const TEST_TURNSTILE_SECRET = "integration-turnstile-secret";
const PREVIOUS_RECONCILE_SECRET = "integration-previous-billing-reconcile-secret-0001";

/** Cloudflare's siteverify, as far as the server relies on it: success for unused "pass-" tokens. */
function startTurnstileStub(): Promise<Server> {
  const used = new Set<string>();
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const form = new URLSearchParams(raw);
      const token = form.get("response") ?? "";
      const success = form.get("secret") === TEST_TURNSTILE_SECRET && token.startsWith("pass-") && !used.has(token);
      used.add(token);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(success ? { success: true } : { success: false, "error-codes": ["invalid-input-response"] }));
    });
  });
  return new Promise((resolve) => server.listen(TURNSTILE_PORT, "127.0.0.1", () => resolve(server)));
}

async function waitForReady(url: string, log: () => string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = (await response.json()) as { status?: string; checks?: { database?: string } };
      if (response.ok && body.checks?.database === "ok") return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`integration server did not become ready:\n${log()}`);
}

export default async function setup(project: TestProject) {
  const supabase = supabaseStatus();
  await ensureBucket();
  const turnstile = await startTurnstileStub();
  const origin = `http://127.0.0.1:${PORT}`;
  const billing = new FakeBillingProvider(BILLING_PORT, `${origin}/api/v1/billing/webhook`);
  await billing.start();
  const serverLog = join(mkdtempSync(join(tmpdir(), "local-saver-it-")), "server.log");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    APP_ENV: "test",
    ALLOW_TEST_CLIENT_IP: "1",
    TEST_CLIENT_IP_DEFAULT: undefined,
    TRUST_PROXY_MODE: undefined,
    NEXT_PUBLIC_APP_ORIGIN: origin,
    APP_ALLOWED_ORIGINS: origin,
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
    NETWORK_KEY_VERSION: "1",
    LINK_PEPPER: LOCAL.linkPepper,
    CODE_PEPPER: LOCAL.codePepper,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: "integration-turnstile-site-key",
    TURNSTILE_SECRET_KEY: TEST_TURNSTILE_SECRET,
    TURNSTILE_VERIFY_URL: `http://127.0.0.1:${TURNSTILE_PORT}/siteverify`,
    // Kill-switch tests flip flags in the database and need them to apply immediately.
    RUNTIME_FLAGS_CACHE_SECONDS: "0",
    // info, so the secret-leak test also covers the informational events (unlock failures).
    LOG_LEVEL: "info",
    // Phase 4C: the fake billing provider (tests and local development only).
    BILLING_PROVIDER: "fake",
    BILLING_API_KEY: FAKE_BILLING.apiKey,
    BILLING_WEBHOOK_SECRET: FAKE_BILLING.webhookSecret,
    BILLING_WEBHOOK_SECRET_PREVIOUS: FAKE_BILLING.previousWebhookSecret,
    BILLING_PRICE_PRO_MONTH: FAKE_BILLING.prices.month,
    BILLING_PRICE_PRO_YEAR: FAKE_BILLING.prices.year,
    BILLING_FAKE_API_URL: billing.url,
    BILLING_RECONCILE_SECRET: LOCAL.billingReconcileSecret,
    BILLING_RECONCILE_SECRET_PREVIOUS: PREVIOUS_RECONCILE_SECRET,
  };

  const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(PORT), "-H", "127.0.0.1"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let ready = false;
  const logFile = createWriteStream(serverLog);
  const capture = (chunk: Buffer) => {
    if (!ready) output += chunk; // only needed to explain a failed start
    logFile.write(chunk);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  await waitForReady(`${origin}/api/v1/health?ready=1`, () => output);
  ready = true;

  project.provide("stack", {
    origin,
    supabaseUrl: supabase.url,
    publishableKey: supabase.publishableKey,
    secretKey: supabase.secretKey,
    mailpitUrl: supabase.mailpitUrl,
    adminDatabaseUrl: LOCAL.adminDatabaseUrl,
    storage: {
      endpoint: STORAGE.endpoint,
      bucket: STORAGE.bucket,
      accessKeyId: STORAGE.accessKeyId,
      secretAccessKey: STORAGE.secretAccessKey,
    },
    serverLog,
    billing: { url: billing.url, reconcileSecret: LOCAL.billingReconcileSecret, previousReconcileSecret: PREVIOUS_RECONCILE_SECRET },
  });

  return () => {
    child.kill();
    turnstile.close();
    void billing.stop();
    logFile.end();
  };
}
