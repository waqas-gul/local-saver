#!/usr/bin/env node
/**
 * Local stack helper (Phase 1, P1-01; Phase 3 P3-05).
 *
 *   node scripts/local-stack.cjs prepare         write supabase/functions/.env (Edge Function settings)
 *   node scripts/local-stack.cjs storage-start   start RustFS (the local R2 stand-in), create the bucket and
 *                                                attach it to the Supabase network for the janitor
 *   node scripts/local-stack.cjs storage-stop    remove the RustFS container
 *   node scripts/local-stack.cjs env             print a .env.local for the local stack
 *
 * Supabase itself is started with `pnpm stack:start` (Supabase CLI), which also serves the Edge
 * Functions in supabase/functions. Every value here is a local-only default; none of them is
 * valid outside this machine or CI.
 * CommonJS so that Node, Vitest and the Playwright config can all load it.
 */
const { execFileSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const STORAGE = {
  image: "rustfs/rustfs:1.0.1",
  container: "local-saver-s3",
  endpoint: "http://127.0.0.1:9000",
  accessKeyId: "localsaverdev",
  secretAccessKey: "localsaver-dev-secret-key",
  bucket: "local-saver-dev",
  // Browser uploads come from these app origins (dev server, e2e server, integration server).
  corsOrigins: ["http://localhost:3000", "http://127.0.0.1:3000", "http://127.0.0.1:3102", "http://127.0.0.1:3200"],
  // The Supabase CLI's Docker network, so the Edge Functions reach RustFS by this name. The CLI
  // adds no host alias on Linux, so host.docker.internal would fail on CI (phase 3 §18.2).
  network: "supabase_network_local-saver",
  networkAlias: "local-saver-s3",
};

const LOCAL = {
  appServerDatabaseUrl: "postgresql://app_server:app-server-local-only@127.0.0.1:54322/postgres",
  adminDatabaseUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  networkKeySecret: "local-only-network-key-secret-0000000000000001",
  linkPepper: "local-only-link-pepper-000000000000000000000001",
  codePepper: "local-only-code-pepper-000000000000000000000001",
  // Phase 3: the janitor and egress-loader roles (passwords set in supabase/seed.sql).
  janitorDatabaseUrl: "postgresql://app_janitor:app-janitor-local-only@127.0.0.1:54322/postgres",
  egressLoaderDatabaseUrl: "postgresql://app_egress_loader:app-egress-loader-local-only@127.0.0.1:54322/postgres",
  // Must match the storage_janitor_secret Vault entry in supabase/seed.sql.
  janitorTriggerSecret: "local-only-janitor-trigger-secret-0000000000000001",
  janitorUrl: "http://127.0.0.1:54321/functions/v1/storage-janitor",
};

/** Settings for the storage-janitor function, as it sees the stack from inside Docker. */
const FUNCTIONS_ENV = {
  JANITOR_DATABASE_URL: "postgresql://app_janitor:app-janitor-local-only@db:5432/postgres",
  JANITOR_TRIGGER_SECRET: LOCAL.janitorTriggerSecret,
  JANITOR_S3_ENDPOINT: `http://${STORAGE.networkAlias}:9000`,
  JANITOR_S3_BUCKET: STORAGE.bucket,
  JANITOR_S3_ACCESS_KEY_ID: STORAGE.accessKeyId,
  JANITOR_S3_SECRET_ACCESS_KEY: STORAGE.secretAccessKey,
  JANITOR_DRY_RUN: "false",
};

function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Supabase CLI status of the running local stack (API URL and keys). Throws when it isn't running. */
function supabaseStatus() {
  const raw = execFileSync("pnpm", ["exec", "supabase", "status", "-o", "json"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  const url = json.API_URL;
  const publishableKey = json.PUBLISHABLE_KEY;
  const secretKey = json.SECRET_KEY;
  if (!url || !publishableKey || !secretKey) throw new Error("Supabase is not running (pnpm stack:start)");
  return { url, publishableKey, secretKey };
}

function s3() {
  const { S3Client } = require("@aws-sdk/client-s3");
  return new S3Client({
    region: "auto",
    endpoint: STORAGE.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: STORAGE.accessKeyId, secretAccessKey: STORAGE.secretAccessKey },
  });
}

async function ensureBucket() {
  const { CreateBucketCommand, HeadBucketCommand, PutBucketCorsCommand } = require("@aws-sdk/client-s3");
  const client = s3();
  try {
    await client.send(new HeadBucketCommand({ Bucket: STORAGE.bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: STORAGE.bucket }));
  }
  // Same rules as infra/r2/cors.*.json, with local origins.
  await client.send(
    new PutBucketCorsCommand({
      Bucket: STORAGE.bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: STORAGE.corsOrigins,
            AllowedMethods: ["PUT", "GET", "HEAD"],
            AllowedHeaders: ["content-type", "content-disposition", "cache-control", "if-none-match"],
            ExposeHeaders: ["ETag"],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  );
}

/** supabase/functions/.env (git-ignored): read by the CLI when `supabase start` serves functions. */
function prepare() {
  const file = join(__dirname, "..", "supabase", "functions", ".env");
  const lines = [
    "# Written by `pnpm stack:start` for the local stack only. Do not use these values anywhere else.",
    ...Object.entries(FUNCTIONS_ENV).map(([name, value]) => `${name}=${value}`),
  ];
  writeFileSync(file, `${lines.join("\n")}\n`);
  console.log(`functions env written: ${file}`);
}

/** Attach RustFS to the Supabase network (idempotent; the network is recreated by each `supabase start`). */
function connectStorageNetwork() {
  try {
    docker(["network", "connect", "--alias", STORAGE.networkAlias, STORAGE.network, STORAGE.container]);
  } catch (error) {
    const message = String(error.stderr ?? error.message);
    if (!/already exists|already attached|endpoint with name/i.test(message)) {
      console.warn(`RustFS not attached to ${STORAGE.network} (start Supabase first): ${message.trim()}`);
    }
  }
}

async function storageStart() {
  const existing = docker(["ps", "-a", "--filter", `name=^${STORAGE.container}$`, "--format", "{{.State}}"]);
  if (!existing) {
    docker([
      "run", "-d", "--name", STORAGE.container, "-p", "9000:9000",
      "-e", `RUSTFS_ACCESS_KEY=${STORAGE.accessKeyId}`,
      "-e", `RUSTFS_SECRET_KEY=${STORAGE.secretAccessKey}`,
      STORAGE.image,
    ]);
  } else if (existing !== "running") {
    docker(["start", STORAGE.container]);
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await ensureBucket();
      connectStorageNetwork();
      console.log(`storage ready: ${STORAGE.endpoint}/${STORAGE.bucket}`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("RustFS did not become ready in 30 s");
}

function storageStop() {
  try {
    docker(["rm", "-f", STORAGE.container]);
  } catch {
    // already gone
  }
  console.log("storage stopped");
}

function printEnv() {
  const sb = supabaseStatus();
  const lines = [
    "# Generated by `pnpm stack:env` for the local stack only. Do not use these values anywhere else.",
    "APP_ENV=local",
    "NEXT_PUBLIC_APP_ORIGIN=http://localhost:3000",
    "APP_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000",
    `DATABASE_URL=${LOCAL.appServerDatabaseUrl}`,
    `NEXT_PUBLIC_SUPABASE_URL=${sb.url}`,
    `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${sb.publishableKey}`,
    `SUPABASE_SECRET_KEY=${sb.secretKey}`,
    "R2_ACCOUNT_ID=local",
    `R2_BUCKET=${STORAGE.bucket}`,
    `R2_S3_ENDPOINT=${STORAGE.endpoint}`,
    `R2_ACCESS_KEY_ID=${STORAGE.accessKeyId}`,
    `R2_SECRET_ACCESS_KEY=${STORAGE.secretAccessKey}`,
    `NETWORK_KEY_SECRET_CURRENT=${LOCAL.networkKeySecret}`,
    "NETWORK_KEY_VERSION=1",
    `LINK_PEPPER=${LOCAL.linkPepper}`,
    `CODE_PEPPER=${LOCAL.codePepper}`,
    "# A local browser has no trusted client IP (it connects from 127.0.0.1). Pretend every",
    "# request without X-Test-Client-IP comes from one network, so two local browsers share it.",
    "ALLOW_TEST_CLIENT_IP=1",
    "TEST_CLIENT_IP_DEFAULT=203.0.113.10",
  ];
  console.log(lines.join("\n"));
}

module.exports = { STORAGE, LOCAL, FUNCTIONS_ENV, supabaseStatus, ensureBucket };

if (require.main === module) {
  const command = process.argv[2];
  const run = { prepare, "storage-start": storageStart, "storage-stop": storageStop, env: printEnv }[command];
  if (!run) {
    console.error("usage: node scripts/local-stack.cjs prepare|storage-start|storage-stop|env");
    process.exit(2);
  }
  Promise.resolve(run()).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
