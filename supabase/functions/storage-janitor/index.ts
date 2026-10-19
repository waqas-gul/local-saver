/**
 * storage-janitor (phase 3 §17.5): the one deletion executor (owner decision D-1).
 *
 * pg_cron posts {"mode":"delete"} every minute when outbox rows are due, and {"mode":"reconcile"}
 * while a weekly reconciliation runs (app.trigger_storage_janitor). verify_jwt is off for this
 * function only (supabase/config.toml): it checks its own shared secret first, in constant time,
 * and accepts exactly those two bodies. It answers 202 at once and works in the background
 * (EdgeRuntime.waitUntil, confirmed in P3-00), so pg_net's timeout can't cut a run short.
 *
 * It connects as app_janitor (JANITOR_DATABASE_URL), which may only run the janitor functions,
 * and never reads the SUPABASE_* secrets the platform injects (C-4).
 */
import { AwsClient } from "aws4fetch";
import postgres from "postgres";
import {
  authorize,
  createJanitorDb,
  DEFAULT_OPTIONS,
  type LogFn,
  parseJanitorBody,
  readJanitorConfig,
  runJanitor,
  type Mode,
} from "../_shared/janitor-core.ts";
import { createFetchStorage } from "../_shared/s3-fetch.ts";

// Refuses to start without its own settings: the worker fails to boot (503) and logs which names are missing.
const config = readJanitorConfig((name) => Deno.env.get(name));

const log: LogFn = (level, event, fields) => {
  const line = JSON.stringify({ level, event, time: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

const aws = new AwsClient({
  accessKeyId: config.s3.accessKeyId,
  secretAccessKey: config.s3.secretAccessKey,
  service: "s3",
  region: "auto",
});
const storage = createFetchStorage({
  endpoint: config.s3.endpoint,
  bucket: config.s3.bucket,
  fetch: (url, init) => aws.fetch(url, init),
});

async function run(mode: Mode): Promise<void> {
  // Supavisor transaction mode in hosted environments: no prepared statements.
  const sql = postgres(config.databaseUrl, { prepare: false, max: 4, idle_timeout: 20, connect_timeout: 10, onnotice: () => {} });
  try {
    const db = createJanitorDb(async (text, params) => (await sql.unsafe(text, params as never[])) as unknown as Record<string, unknown>[]);
    await runJanitor(mode, { db, storage, log, options: { ...DEFAULT_OPTIONS, dryRun: config.dryRun, now: Date.now } });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

type EdgeRuntimeGlobal = { waitUntil?: (promise: Promise<unknown>) => void };

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  if (!authorize(request.headers.get("authorization"), config.secrets)) return new Response(null, { status: 401 });
  const mode = parseJanitorBody(await request.text());
  if (mode === null) return new Response(null, { status: 400 });

  const work = run(mode).catch((error) => log("error", "janitor.unhandled", { mode, error: (error as Error)?.name ?? "error" }));
  const edge = (globalThis as { EdgeRuntime?: EdgeRuntimeGlobal }).EdgeRuntime;
  if (edge?.waitUntil) edge.waitUntil(work);
  else await work;
  return Response.json({ accepted: true, mode }, { status: 202 });
});
