import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { TestProject } from "vitest/node";
import { ensureBucket, LOCAL, STORAGE, supabaseStatus } from "../../../scripts/local-stack.cjs";

/**
 * Starts `next start` (production build, NODE_ENV=test) against the local stack:
 * Supabase (Postgres, Auth, Realtime) and RustFS. Requires `pnpm build` and `pnpm stack:start`.
 */

export type StackInfo = {
  origin: string;
  supabaseUrl: string;
  publishableKey: string;
  adminDatabaseUrl: string;
  storage: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };
};

declare module "vitest" {
  export interface ProvidedContext {
    stack: StackInfo;
  }
}

const PORT = 3200;

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

  const origin = `http://127.0.0.1:${PORT}`;
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
    // Kill-switch tests flip flags in the database and need them to apply immediately.
    RUNTIME_FLAGS_CACHE_SECONDS: "0",
    LOG_LEVEL: "warn",
  };

  const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(PORT), "-H", "127.0.0.1"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));

  await waitForReady(`${origin}/api/v1/health?ready=1`, () => output);

  project.provide("stack", {
    origin,
    supabaseUrl: supabase.url,
    publishableKey: supabase.publishableKey,
    adminDatabaseUrl: LOCAL.adminDatabaseUrl,
    storage: {
      endpoint: STORAGE.endpoint,
      bucket: STORAGE.bucket,
      accessKeyId: STORAGE.accessKeyId,
      secretAccessKey: STORAGE.secretAccessKey,
    },
  });

  return () => {
    child.kill();
  };
}
