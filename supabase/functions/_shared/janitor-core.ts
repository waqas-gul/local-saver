/**
 * Storage janitor core (phase 3 §17.5, C-2). The one deletion executor (owner decision D-1).
 *
 * Runtime-agnostic: no Deno or Node globals and no imports, so the storage-janitor Edge Function
 * (Deno) and Vitest (Node) run the same code. Storage and the database are passed in.
 *
 * The database decides; this module only carries out. app.janitor_claim_deletions applies the
 * guard rails (generated key format, no open share using the key, not on legal hold) and the
 * tombstone rule (hold_until while an upload URL may still be live, review M1). The key format is
 * checked here a third time. Logs carry IDs, counts and key classes only: never full keys, file
 * names, URLs or secrets.
 *
 * Multipart uploads (Phase 4, P4-14): a row may carry the upload ID of a multipart upload that may still
 * be open; it is aborted before the key is deleted, and such a row never gets a tombstone (no PUT URL
 * exists for a multipart file's key). Aborting is destructive, so the web tier leaves it to the janitor.
 *
 * Legal holds (D-2, RISK-031): R2's lifecycle rules delete d7/, d30/ and d90/ objects at their class
 * period + 1 day after upload, held or not. Each run first copies held objects to hold/<key>,
 * which no rule covers (app.janitor_claim_hold_copies); after a release, deleting the row deletes
 * the copy too. Copies are made in dry runs as well: a copy deletes nothing.
 *
 * Extend by copy (Phase 4, P4-15, DEC-010): after its deletions, a run copies extended shares' objects to
 * their new keys in a longer-lived class (app.janitor_claim_extension_copies), in waves of `concurrency`
 * within the time budget, and checks each copy's size before recording it. The database swaps a share's
 * keys when its last copy is recorded and queues the old keys through the outbox, so deleting them stays
 * on the path above, guard rails and all. Copies are made in dry runs too.
 */

export type Mode = "delete" | "reconcile";
export type Outcome = "deleted" | "tombstoned" | "failed" | "dry_run";
export type HoldCopyOutcome = "copied" | "unavailable" | "failed";
export type ExtensionCopyOutcome = "copied" | "failed";
type Counts = Record<string, number | string | boolean | null>;

export type ClaimedDeletion = {
  id: string;
  /** Null when a guard rail refused the row: it must not be acted on. */
  objectKey: string | null;
  reason: string;
  /** Set while an upload URL may still be live: write a tombstone instead of deleting. */
  holdUntil: Date | null;
  tombstoned: boolean;
  refused: string | null;
  attempts: number;
  /** Set when a released hold left a copy (hold/<objectKey>): delete it with the original. */
  holdCopyKey: string | null;
  /**
   * Phase 4 (P4-14): set when the key's multipart upload may still be open. It is aborted first (a 404
   * means it is already gone), so no part can be added or completed, then the key is deleted. Never logged.
   */
  multipartUploadId?: string;
};

/** A held row whose object must be copied out of the lifecycle rules' reach (RISK-031). */
export type ClaimedHoldCopy = {
  id: string;
  /** Null when a guard rail refused the row: it must not be acted on. */
  objectKey: string | null;
  /** hold/<objectKey>. */
  copyKey: string | null;
  refused: string | null;
  attempts: number;
};

/** An extended share's object to copy to its new key in a longer-lived class (P4-15). */
export type ClaimedExtensionCopy = {
  id: string;
  /** Null when a guard rail refused the row: it must not be acted on. */
  oldKey: string | null;
  newKey: string | null;
  /** The file's size: the copy must have exactly this many bytes. */
  sizeBytes: number | null;
  refused: string | null;
  attempts: number;
};

export type ListedObject = { key: string; lastModified: Date };
export type PageResult = { listed: number; orphansQueued: number; unknownKeys: number; missingObjects: number; holdCopies: number };

export interface JanitorDb {
  beginRun(mode: Mode): Promise<{ enabled: boolean }>;
  claimDeletions(limit: number): Promise<ClaimedDeletion[]>;
  finishDeletion(id: string, outcome: Outcome, error?: string | null): Promise<boolean>;
  claimHoldCopies(limit: number): Promise<ClaimedHoldCopy[]>;
  finishHoldCopy(id: string, outcome: HoldCopyOutcome, error?: string | null): Promise<boolean>;
  claimExtensionCopies(limit: number): Promise<ClaimedExtensionCopy[]>;
  /** copied, swapped (that was the share's last copy), failed, extension_failed (the fifth failure) or stale. */
  finishExtensionCopy(id: string, outcome: ExtensionCopyOutcome, error?: string | null): Promise<string>;
  recordRun(mode: Mode, ok: boolean, result: Counts, error?: string | null): Promise<void>;
  reconcileClaim(): Promise<{ runId: string; cursor: string | null; startedAt: Date } | null>;
  reconcilePage(runId: string, keys: ListedObject[], rangeStart: string | null, nextCursor: string | null, done: boolean): Promise<PageResult>;
  reconcileNote(runId: string, counts: Counts): Promise<void>;
  reconcileRelease(runId: string): Promise<void>;
}

export interface JanitorStorage {
  /** Idempotent: deleting a missing key succeeds. */
  deleteObject(key: string): Promise<void>;
  /** Unconditional empty write that keeps the key taken (review M1). */
  putTombstone(key: string): Promise<void>;
  /**
   * Server-side copy within the bucket, stored headers kept: to hold/<key>, or (P4-15) to a generated key of
   * a longer-lived class. "missing" when the source is gone.
   */
  copyObject(sourceKey: string, destinationKey: string): Promise<"copied" | "missing">;
  objectExists(key: string): Promise<boolean>;
  /** HEAD: the object's size in bytes, or null when there is none. */
  objectSize(key: string): Promise<number | null>;
  listObjects(startAfter: string | null, maxKeys: number): Promise<{ keys: ListedObject[]; truncated: boolean }>;
  listMultipartUploads(): Promise<{ key: string; uploadId: string; initiated: Date }[]>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}

export type LogFn = (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) => void;

export type JanitorOptions = {
  dryRun: boolean;
  /** Rows claimed per batch (P3-00: 100). */
  batchSize: number;
  /** Storage calls in flight at once (P3-00: 8). */
  concurrency: number;
  /** Rows per invocation, so the CPU stays under the 1 s soft limit (P3-00: 500). */
  maxRows: number;
  /** Stop claiming after this long, below every wall-clock limit (100 s). */
  timeBudgetMs: number;
  /** Listing pages per reconcile invocation (1,000 keys each). */
  maxPages?: number;
  now: () => number;
};

export const DEFAULT_OPTIONS = {
  batchSize: 100,
  concurrency: 8,
  maxRows: 500,
  timeBudgetMs: 100_000,
  maxPages: 20,
} as const;

/** Rows failing this many times are reported as failing (health check and logs). */
const FAILING_ATTEMPTS = 5;
const MULTIPART_MAX_AGE_MS = 24 * 3600_000;

const OBJECT_KEY = /^(d7|d30|d90|ws)\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The same format as lib/server/storage/keys.ts (a unit test keeps them equal). */
export function isValidObjectKey(key: string): boolean {
  return OBJECT_KEY.test(key);
}

const HOLD_PREFIX = "hold/";

/** A hold copy's key: hold/ plus a generated key (app.janitor_hold_copy_key_valid). Never a generated key itself. */
export function isValidHoldCopyKey(key: string): boolean {
  return key.startsWith(HOLD_PREFIX) && OBJECT_KEY.test(key.slice(HOLD_PREFIX.length));
}

export function holdCopyKey(key: string): string {
  if (!isValidObjectKey(key)) throw new Error("invalid object key");
  return HOLD_PREFIX + key;
}

/** An extension copy's destination: a generated key of a class longer-lived than d7 (P4-15). */
export function isValidExtensionKey(key: string): boolean {
  return isValidObjectKey(key) && (key.startsWith("d30/") || key.startsWith("d90/"));
}

/** The retention class of a key, the only part of a key that is logged. */
function keyClass(key: string | null): string | null {
  return key?.split("/")[0] ?? null;
}

/** A short, secret-free label for an error: S3 status and code, or a network error name. */
export function errorLabel(error: unknown): string {
  const e = error as { status?: unknown; code?: unknown; name?: unknown };
  if (typeof e?.status === "number") return `s3:${e.status}${typeof e.code === "string" ? `:${e.code}` : ""}`.slice(0, 200);
  if (typeof e?.code === "string" && /^[A-Z0-9_]{2,40}$/.test(e.code)) return e.code;
  if (typeof e?.name === "string" && /^[A-Za-z]{2,40}$/.test(e.name)) return e.name;
  return "error";
}

async function inParallel<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) await fn(items[next++] as T);
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------------- delete mode

type DeleteSummary = {
  claimed: number;
  deleted: number;
  tombstoned: number;
  failed: number;
  refused: number;
  dryRun: number;
  batches: number;
  holdClaimed: number;
  holdCopied: number;
  holdUnavailable: number;
  holdCopyFailed: number;
  extensionClaimed: number;
  extensionCopied: number;
  extensionSwapped: number;
  extensionCopyFailed: number;
  extensionFailed: number;
};

async function handleRow(row: ClaimedDeletion, db: JanitorDb, storage: JanitorStorage, log: LogFn, options: JanitorOptions, s: DeleteSummary) {
  if (row.refused !== null || row.objectKey === null) {
    s.refused++;
    log("error", "janitor.guard_refused", { objectDeletionId: row.id, guard: row.refused ?? "no_key", reason: row.reason });
    return;
  }
  if (!isValidObjectKey(row.objectKey) || (row.holdCopyKey !== null && row.holdCopyKey !== holdCopyKey(row.objectKey))) {
    s.refused++;
    log("error", "janitor.guard_refused", { objectDeletionId: row.id, guard: "key_format", reason: row.reason });
    await db.finishDeletion(row.id, "failed", "guard:key_format");
    return;
  }
  const hold = row.holdUntil !== null;
  const fields = {
    objectDeletionId: row.id,
    keyClass: keyClass(row.objectKey),
    reason: row.reason,
    holdCopy: row.holdCopyKey !== null,
    ...(row.multipartUploadId ? { multipart: true } : {}),
  };
  if (options.dryRun) {
    log("info", hold ? "janitor.would_tombstone" : "janitor.would_delete", fields);
    await db.finishDeletion(row.id, "dry_run");
    s.dryRun++;
    return;
  }
  try {
    // An open multipart upload goes first: once aborted, no part URL can add to it and it can't be completed.
    if (row.multipartUploadId) await storage.abortMultipartUpload(row.objectKey, row.multipartUploadId);
    if (hold) {
      if (!row.tombstoned) await storage.putTombstone(row.objectKey);
    } else {
      await storage.deleteObject(row.objectKey);
    }
    // No upload URL can write to a hold copy, so it goes at once, even when the original is tombstoned.
    if (row.holdCopyKey !== null) await storage.deleteObject(row.holdCopyKey);
  } catch (error) {
    const label = errorLabel(error);
    s.failed++;
    await db.finishDeletion(row.id, "failed", label);
    log("warn", "janitor.delete_failed", { ...fields, attempts: row.attempts + 1, error: label });
    if (row.attempts + 1 >= FAILING_ATTEMPTS) log("error", "janitor.failing", { ...fields, attempts: row.attempts + 1, error: label });
    return;
  }
  await db.finishDeletion(row.id, hold ? "tombstoned" : "deleted");
  if (hold) s.tombstoned++;
  else s.deleted++;
}

async function handleHoldCopy(row: ClaimedHoldCopy, db: JanitorDb, storage: JanitorStorage, log: LogFn, s: DeleteSummary) {
  if (row.refused !== null || row.objectKey === null || row.copyKey === null) {
    s.refused++;
    log("error", "janitor.guard_refused", { objectDeletionId: row.id, guard: row.refused ?? "no_key", reason: "legal_hold" });
    return;
  }
  if (!isValidObjectKey(row.objectKey) || row.copyKey !== holdCopyKey(row.objectKey)) {
    s.refused++;
    log("error", "janitor.guard_refused", { objectDeletionId: row.id, guard: "key_format", reason: "legal_hold" });
    await db.finishHoldCopy(row.id, "failed", "guard:key_format");
    return;
  }
  const fields = { objectDeletionId: row.id, keyClass: keyClass(row.objectKey) };
  let outcome: "copied" | "missing";
  try {
    outcome = await storage.copyObject(row.objectKey, row.copyKey);
    // An earlier attempt may have made the copy before the original went.
    if (outcome === "missing" && (await storage.objectExists(row.copyKey))) outcome = "copied";
  } catch (error) {
    const label = errorLabel(error);
    s.holdCopyFailed++;
    await db.finishHoldCopy(row.id, "failed", label);
    log("warn", "janitor.hold_copy_failed", { ...fields, attempts: row.attempts + 1, error: label });
    if (row.attempts + 1 >= FAILING_ATTEMPTS) log("error", "janitor.failing", { ...fields, attempts: row.attempts + 1, error: label });
    return;
  }
  if (outcome === "copied") {
    await db.finishHoldCopy(row.id, "copied");
    s.holdCopied++;
    log("info", "janitor.hold_copied", fields);
  } else {
    // Nothing left to preserve: the operator must know (takedown runbook).
    await db.finishHoldCopy(row.id, "unavailable");
    s.holdUnavailable++;
    log("error", "janitor.hold_source_missing", fields);
  }
}

async function handleExtensionCopy(row: ClaimedExtensionCopy, db: JanitorDb, storage: JanitorStorage, log: LogFn, s: DeleteSummary) {
  if (row.refused !== null || row.oldKey === null || row.newKey === null || row.sizeBytes === null) {
    s.refused++;
    log("error", "janitor.guard_refused", { extensionCopyId: row.id, guard: row.refused ?? "no_key", reason: "extension" });
    return;
  }
  if (!isValidObjectKey(row.oldKey) || !isValidExtensionKey(row.newKey) || row.oldKey === row.newKey) {
    s.refused++;
    log("error", "janitor.guard_refused", { extensionCopyId: row.id, guard: "key_format", reason: "extension" });
    await db.finishExtensionCopy(row.id, "failed", "guard:key_format");
    return;
  }
  const fields = { extensionCopyId: row.id, from: keyClass(row.oldKey), to: keyClass(row.newKey) };
  let failure: string | null = null;
  try {
    if ((await storage.copyObject(row.oldKey, row.newKey)) === "missing") failure = "source_missing";
    // Only a copy with exactly the file's bytes counts: the swap points the file at it.
    else if ((await storage.objectSize(row.newKey)) !== row.sizeBytes) failure = "size_mismatch";
  } catch (error) {
    failure = errorLabel(error);
  }
  if (failure !== null) {
    s.extensionCopyFailed++;
    const result = await db.finishExtensionCopy(row.id, "failed", failure);
    // A verified file of an open share has lost its object: the operator must know.
    log(failure === "source_missing" ? "error" : "warn", "janitor.extension_copy_failed", { ...fields, attempts: row.attempts + 1, error: failure });
    if (result === "extension_failed") {
      s.extensionFailed++;
      log("error", "janitor.extension_failed", { ...fields, attempts: row.attempts + 1, error: failure });
    }
    return;
  }
  const result = await db.finishExtensionCopy(row.id, "copied");
  s.extensionCopied++;
  if (result === "swapped") s.extensionSwapped++;
  log("info", result === "swapped" ? "janitor.extension_swapped" : "janitor.extension_copied", {
    ...fields,
    // Its extension ended meanwhile; the database queued the new key again.
    ...(result === "stale" ? { stale: true } : {}),
  });
}

async function runDelete(db: JanitorDb, storage: JanitorStorage, log: LogFn, options: JanitorOptions): Promise<DeleteSummary> {
  const s: DeleteSummary = {
    claimed: 0,
    deleted: 0,
    tombstoned: 0,
    failed: 0,
    refused: 0,
    dryRun: 0,
    batches: 0,
    holdClaimed: 0,
    holdCopied: 0,
    holdUnavailable: 0,
    holdCopyFailed: 0,
    extensionClaimed: 0,
    extensionCopied: 0,
    extensionSwapped: 0,
    extensionCopyFailed: 0,
    extensionFailed: 0,
  };
  const start = options.now();
  const left = () => options.maxRows - s.claimed - s.holdClaimed - s.extensionClaimed;
  // Held objects first: until copied, R2's lifecycle rules may delete a takedown's evidence (RISK-031).
  while (left() > 0 && options.now() - start < options.timeBudgetMs) {
    const rows = await db.claimHoldCopies(Math.min(options.batchSize, left()));
    if (rows.length === 0) break;
    s.holdClaimed += rows.length;
    await inParallel(rows, options.concurrency, (row) => handleHoldCopy(row, db, storage, log, s));
  }
  while (left() > 0 && options.now() - start < options.timeBudgetMs) {
    const rows = await db.claimDeletions(Math.min(options.batchSize, left()));
    if (rows.length === 0) break;
    s.claimed += rows.length;
    s.batches++;
    await inParallel(rows, options.concurrency, (row) => handleRow(row, db, storage, log, options, s));
  }
  // Extension copies last (P4-15): an ended share's objects should go first. One wave of `concurrency`
  // copies at a time, so a run never starts more copies (up to 5 GiB each) than it can finish in time.
  while (left() > 0 && options.now() - start < options.timeBudgetMs) {
    const rows = await db.claimExtensionCopies(Math.min(options.concurrency, left()));
    if (rows.length === 0) break;
    s.extensionClaimed += rows.length;
    await inParallel(rows, options.concurrency, (row) => handleExtensionCopy(row, db, storage, log, s));
  }
  return s;
}

// ---------------------------------------------------------------------------------- reconcile mode

type ReconcileSummary = {
  pages: number;
  listed: number;
  orphansQueued: number;
  unknownKeys: number;
  missingObjects: number;
  holdCopies: number;
  done: boolean;
};

async function reconcileMultipart(db: JanitorDb, storage: JanitorStorage, log: LogFn, options: JanitorOptions, runId: string) {
  // C-5, and since Phase 4 (P4-14) the backstop for multipart uploads: one older than the 24-hour
  // upload deadline is abandoned (the outbox normally aborts it first), and is aborted like the R2 rule
  // would. Younger ones are left alone: they may still finish.
  const uploads = await storage.listMultipartUploads();
  let aborted = 0;
  for (const upload of uploads) {
    if (!isValidObjectKey(upload.key) || options.now() - upload.initiated.getTime() < MULTIPART_MAX_AGE_MS) continue;
    if (!options.dryRun) await storage.abortMultipartUpload(upload.key, upload.uploadId);
    aborted++;
  }
  if (uploads.length > 0) {
    log(aborted > 0 ? "warn" : "info", "reconcile.multipart_uploads", { inProgress: uploads.length, aborted, dryRun: options.dryRun });
  }
  await db.reconcileNote(runId, { multipartInProgress: uploads.length, multipartAborted: options.dryRun ? 0 : aborted });
}

async function runReconcile(db: JanitorDb, storage: JanitorStorage, log: LogFn, options: JanitorOptions): Promise<ReconcileSummary | { skipped: string }> {
  const run = await db.reconcileClaim();
  if (!run) return { skipped: "no_run" };
  const s: ReconcileSummary = { pages: 0, listed: 0, orphansQueued: 0, unknownKeys: 0, missingObjects: 0, holdCopies: 0, done: false };
  const start = options.now();
  let cursor = run.cursor;
  try {
    if (cursor === null) await reconcileMultipart(db, storage, log, options, run.runId);
    while (s.pages < (options.maxPages ?? DEFAULT_OPTIONS.maxPages) && options.now() - start < options.timeBudgetMs) {
      const page = await storage.listObjects(cursor, 1000);
      const last = page.keys[page.keys.length - 1]?.key ?? null;
      // A truncated page always lists something; anything else would loop forever.
      const done = !page.truncated || last === null;
      const result = await db.reconcilePage(run.runId, page.keys, cursor, done ? null : last, done);
      s.pages++;
      s.listed += result.listed;
      s.orphansQueued += result.orphansQueued;
      s.unknownKeys += result.unknownKeys;
      s.missingObjects += result.missingObjects;
      s.holdCopies += result.holdCopies ?? 0;
      if (result.orphansQueued > 0) log("info", "reconcile.orphans_queued", { runId: run.runId, count: result.orphansQueued });
      if (result.unknownKeys > 0) log("warn", "reconcile.unknown_key", { runId: run.runId, count: result.unknownKeys });
      if (result.missingObjects > 0) log("error", "reconcile.missing_object", { runId: run.runId, count: result.missingObjects });
      if (done) {
        s.done = true;
        break;
      }
      cursor = last;
    }
  } finally {
    if (!s.done) await db.reconcileRelease(run.runId);
  }
  return s;
}

// ---------------------------------------------------------------------------------- entry point

export type JanitorDeps = { db: JanitorDb; storage: JanitorStorage; log: LogFn; options: JanitorOptions };

/** One invocation. Never throws: failures are recorded as a failed run (heartbeat) and logged. */
export async function runJanitor(mode: Mode, { db, storage, log, options }: JanitorDeps): Promise<void> {
  const started = options.now();
  try {
    const { enabled } = await db.beginRun(mode);
    if (!enabled) {
      log("info", "janitor.disabled", { mode });
      await db.recordRun(mode, true, { skipped: "disabled" });
      return;
    }
    const result = mode === "delete" ? await runDelete(db, storage, log, options) : await runReconcile(db, storage, log, options);
    await db.recordRun(mode, true, result);
    log("info", "janitor.run", { mode, ...result, ms: options.now() - started, dryRunMode: options.dryRun });
  } catch (error) {
    const label = errorLabel(error);
    log("error", "janitor.run_failed", { mode, error: label });
    try {
      await db.recordRun(mode, false, {}, label);
    } catch {
      // The database is what failed; the missing heartbeat is the signal (/health/cron).
    }
  }
}

// ---------------------------------------------------------------------------------- trigger contract

const encoder = new TextEncoder();

function constantTimeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** `Authorization: Bearer <secret>` with the current or (during a rotation) the previous secret. */
export function authorize(header: string | null, secrets: string[]): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length);
  let ok = false;
  for (const secret of secrets) if (secret.length > 0 && constantTimeEqual(presented, secret)) ok = true;
  return ok;
}

/** The body must be exactly {"mode": "delete"} or {"mode": "reconcile"}. */
export function parseJanitorBody(text: string): Mode | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  const mode = (body as { mode?: unknown }).mode;
  if (keys.length !== 1 || (mode !== "delete" && mode !== "reconcile")) return null;
  return mode;
}

export type JanitorConfig = {
  databaseUrl: string;
  secrets: string[];
  s3: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };
  dryRun: boolean;
};

/**
 * Settings, read by name from JANITOR_* variables only. Supabase injects SUPABASE_DB_URL and the
 * service-role key into every function; the janitor never reads them (C-4): it connects as the
 * least-privilege app_janitor role and refuses to start without its own URL.
 */
export function readJanitorConfig(get: (name: string) => string | undefined): JanitorConfig {
  const missing: string[] = [];
  const need = (name: string) => {
    const value = get(name)?.trim();
    if (!value) missing.push(name);
    return value ?? "";
  };
  const config: JanitorConfig = {
    databaseUrl: need("JANITOR_DATABASE_URL"),
    secrets: [need("JANITOR_TRIGGER_SECRET"), get("JANITOR_TRIGGER_SECRET_PREVIOUS")?.trim() ?? ""].filter((s) => s.length > 0),
    s3: {
      endpoint: need("JANITOR_S3_ENDPOINT").replace(/\/+$/, ""),
      bucket: need("JANITOR_S3_BUCKET"),
      accessKeyId: need("JANITOR_S3_ACCESS_KEY_ID"),
      secretAccessKey: need("JANITOR_S3_SECRET_ACCESS_KEY"),
    },
    dryRun: get("JANITOR_DRY_RUN")?.trim() === "true",
  };
  if (missing.length > 0) throw new Error(`storage-janitor is not configured: missing ${missing.join(", ")}`);
  if (config.secrets.some((s) => s.length < 32)) throw new Error("storage-janitor: JANITOR_TRIGGER_SECRET must be at least 32 characters");
  if (!/^postgres(ql)?:\/\//.test(config.databaseUrl)) throw new Error("storage-janitor: JANITOR_DATABASE_URL must be a postgres URL");
  return config;
}

// ---------------------------------------------------------------------------------- database adapter

type Row = Record<string, unknown>;
export type QueryFn = (text: string, params: unknown[]) => Promise<Row[]>;

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(String(value));
}

/**
 * The janitor's database calls, over any driver's parameterized query (pg in Node, postgres in Deno).
 * JSON goes in as text and is cast in SQL: postgres.js would JSON-encode a string bound straight
 * to a jsonb parameter a second time.
 */
export function createJanitorDb(query: QueryFn): JanitorDb {
  return {
    async beginRun(mode) {
      const rows = await query("select enabled from app.janitor_begin_run($1)", [mode]);
      return { enabled: rows[0]?.enabled === true };
    },
    async claimDeletions(limit) {
      const rows = await query(
        "select id::text as id, object_key, reason, hold_until, tombstoned, refused, attempts, hold_copy_key, multipart_upload_id from app.janitor_claim_deletions($1::integer)",
        [limit],
      );
      return rows.map((r) => ({
        id: String(r.id),
        objectKey: (r.object_key as string | null) ?? null,
        reason: String(r.reason),
        holdUntil: toDate(r.hold_until),
        tombstoned: r.tombstoned === true,
        refused: (r.refused as string | null) ?? null,
        attempts: Number(r.attempts ?? 0),
        holdCopyKey: (r.hold_copy_key as string | null) ?? null,
        ...(typeof r.multipart_upload_id === "string" && r.multipart_upload_id !== "" ? { multipartUploadId: r.multipart_upload_id } : {}),
      }));
    },
    async finishDeletion(id, outcome, error = null) {
      const rows = await query("select app.janitor_finish_deletion($1::bigint, $2, $3) as ok", [id, outcome, error]);
      return rows[0]?.ok === true;
    },
    async claimHoldCopies(limit) {
      const rows = await query("select id::text as id, object_key, copy_key, refused, attempts from app.janitor_claim_hold_copies($1::integer)", [limit]);
      return rows.map((r) => ({
        id: String(r.id),
        objectKey: (r.object_key as string | null) ?? null,
        copyKey: (r.copy_key as string | null) ?? null,
        refused: (r.refused as string | null) ?? null,
        attempts: Number(r.attempts ?? 0),
      }));
    },
    async finishHoldCopy(id, outcome, error = null) {
      const rows = await query("select app.janitor_finish_hold_copy($1::bigint, $2, $3) as ok", [id, outcome, error]);
      return rows[0]?.ok === true;
    },
    async claimExtensionCopies(limit) {
      const rows = await query(
        "select id::text as id, old_key, new_key, size_bytes, refused, attempts from app.janitor_claim_extension_copies($1::integer)",
        [limit],
      );
      return rows.map((r) => ({
        id: String(r.id),
        oldKey: (r.old_key as string | null) ?? null,
        newKey: (r.new_key as string | null) ?? null,
        // bigint arrives as a string; files are at most 5 GiB, well within a double.
        sizeBytes: r.size_bytes === null || r.size_bytes === undefined ? null : Number(r.size_bytes),
        refused: (r.refused as string | null) ?? null,
        attempts: Number(r.attempts ?? 0),
      }));
    },
    async finishExtensionCopy(id, outcome, error = null) {
      const rows = await query("select app.janitor_finish_extension_copy($1::bigint, $2, $3) as result", [id, outcome, error]);
      return String(rows[0]?.result ?? "stale");
    },
    async recordRun(mode, ok, result, error = null) {
      await query("select app.janitor_record_run($1, $2::boolean, $3::text::jsonb, $4)", [mode, ok, JSON.stringify(result), error]);
    },
    async reconcileClaim() {
      const rows = await query("select run_id::text as run_id, run_cursor, started_at from app.janitor_reconcile_claim()", []);
      const r = rows[0];
      return r ? { runId: String(r.run_id), cursor: (r.run_cursor as string | null) ?? null, startedAt: toDate(r.started_at) as Date } : null;
    },
    async reconcilePage(runId, keys, rangeStart, nextCursor, done) {
      const rows = await query("select app.janitor_reconcile_page($1::bigint, $2::text::jsonb, $3, $4, $5::boolean) as result", [
        runId,
        JSON.stringify(keys.map((k) => ({ k: k.key, m: k.lastModified.toISOString() }))),
        rangeStart,
        nextCursor,
        done,
      ]);
      const result = (typeof rows[0]?.result === "string" ? JSON.parse(rows[0].result as string) : rows[0]?.result) as PageResult;
      return result;
    },
    async reconcileNote(runId, counts) {
      await query("select app.janitor_reconcile_note($1::bigint, $2::text::jsonb)", [runId, JSON.stringify(counts)]);
    },
    async reconcileRelease(runId) {
      await query("select app.janitor_reconcile_release($1::bigint)", [runId]);
    },
  };
}
