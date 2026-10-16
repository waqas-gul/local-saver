import { describe, expect, it } from "vitest";
import {
  authorize,
  createJanitorDb,
  holdCopyKey,
  isValidHoldCopyKey,
  isValidObjectKey,
  parseJanitorBody,
  readJanitorConfig,
  runJanitor,
  type ClaimedDeletion,
  type ClaimedHoldCopy,
  type JanitorDb,
  type JanitorStorage,
  type LogFn,
} from "../../supabase/functions/_shared/janitor-core";
import { isValidObjectKey as appKeyCheck } from "../../lib/server/storage/keys";

/**
 * The storage janitor's runtime-agnostic core (phase 3 §17.5, C-2): Vitest runs it in Node with
 * fakes; the storage-janitor Edge Function runs the same module in Deno.
 */

const KEY = (n: number) => `d7/2026/10/16/00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function row(n: number, extra: Partial<ClaimedDeletion> = {}): ClaimedDeletion {
  return { id: String(n), objectKey: KEY(n), reason: "share_ended", holdUntil: null, tombstoned: false, refused: null, attempts: 0, holdCopyKey: null, ...extra };
}

/** A held row whose object must be copied out of the lifecycle rules' reach (D-2, RISK-031). */
function hc(n: number, extra: Partial<ClaimedHoldCopy> = {}): ClaimedHoldCopy {
  return { id: String(n), objectKey: KEY(n), copyKey: `hold/${KEY(n)}`, refused: null, attempts: 0, ...extra };
}

type Finish = { id: string; outcome: string; error: string | null };

type FakeOptions = {
  enabled?: boolean;
  failKeys?: Set<string>;
  /** Batches of held rows to copy. */
  copies?: ClaimedHoldCopy[][];
  /** Source keys that no longer exist (CopyObject answers NoSuchKey). */
  missing?: Set<string>;
  /** Keys that exist (HEAD). */
  existing?: Set<string>;
};

function fakes(batches: ClaimedDeletion[][], options: FakeOptions = {}) {
  const finished: Finish[] = [];
  const copyFinished: Finish[] = [];
  const copyClaims: number[] = [];
  const runs: { mode: string; ok: boolean; result: unknown; error: string | null }[] = [];
  const claims: number[] = [];
  const db: JanitorDb = {
    async beginRun() {
      return { enabled: options.enabled ?? true };
    },
    async claimDeletions(limit) {
      claims.push(limit);
      return batches.shift() ?? [];
    },
    async finishDeletion(id, outcome, error) {
      finished.push({ id, outcome, error: error ?? null });
      return true;
    },
    async claimHoldCopies(limit) {
      copyClaims.push(limit);
      return options.copies?.shift() ?? [];
    },
    async finishHoldCopy(id, outcome, error) {
      copyFinished.push({ id, outcome, error: error ?? null });
      return true;
    },
    async recordRun(mode, ok, result, error) {
      runs.push({ mode, ok, result, error: error ?? null });
    },
    async reconcileClaim() {
      return null;
    },
    async reconcilePage() {
      throw new Error("not used");
    },
    async reconcileNote() {},
    async reconcileRelease() {},
  };
  const calls: string[] = [];
  const storage: JanitorStorage = {
    async deleteObject(key) {
      calls.push(`delete ${key}`);
      if (options.failKeys?.has(key)) throw Object.assign(new Error("503"), { status: 503, code: "SlowDown" });
    },
    async putTombstone(key) {
      calls.push(`tombstone ${key}`);
      if (options.failKeys?.has(key)) throw Object.assign(new Error("boom"), { name: "TypeError" });
    },
    async copyObject(source, destination) {
      calls.push(`copy ${source} -> ${destination}`);
      if (options.failKeys?.has(source)) throw Object.assign(new Error("503"), { status: 503, code: "SlowDown" });
      return options.missing?.has(source) ? "missing" : "copied";
    },
    async objectExists(key) {
      calls.push(`exists ${key}`);
      return options.existing?.has(key) ?? false;
    },
    async listObjects() {
      return { keys: [], truncated: false };
    },
    async listMultipartUploads() {
      return [];
    },
    async abortMultipartUpload() {},
  };
  const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const log: LogFn = (level, event, fields) => logs.push({ level, event, fields });
  return { db, storage, log, finished, copyFinished, copyClaims, runs, calls, logs, claims };
}

const OPTIONS = { dryRun: false, batchSize: 100, concurrency: 4, maxRows: 500, timeBudgetMs: 100_000, now: () => 0 };

describe("object key check", () => {
  it("accepts exactly the keys the app generates", () => {
    for (const key of [KEY(1), "ws/2026/01/02/abcdef01-2345-4678-9abc-def012345678"]) {
      expect(isValidObjectKey(key)).toBe(true);
      expect(appKeyCheck(key)).toBe(true);
    }
    for (const key of ["", "d7/2026/10/16/------------------------------------", `../${KEY(1)}`, `${KEY(1)}/x`, KEY(1).toUpperCase(), "notes/a.txt"]) {
      expect(isValidObjectKey(key)).toBe(false);
      expect(appKeyCheck(key)).toBe(false);
    }
  });

  it("a hold copy key is exactly hold/ plus a generated key, and is never a generated key itself", () => {
    expect(holdCopyKey(KEY(1))).toBe(`hold/${KEY(1)}`);
    expect(isValidHoldCopyKey(`hold/${KEY(1)}`)).toBe(true);
    for (const key of [KEY(1), "hold/", `hold/hold/${KEY(1)}`, `hold/../${KEY(1)}`, `hold/${KEY(1)}/x`, `Hold/${KEY(1)}`, `xhold/${KEY(1)}`]) {
      expect(isValidHoldCopyKey(key)).toBe(false);
    }
    expect(isValidObjectKey(`hold/${KEY(1)}`)).toBe(false);
    expect(appKeyCheck(`hold/${KEY(1)}`)).toBe(false);
    expect(() => holdCopyKey("notes/a.txt")).toThrow(/invalid object key/);
  });
});

describe("delete mode", () => {
  it("deletes due objects, tombstones held ones, and records the run", async () => {
    const f = fakes([[row(1), row(2, { holdUntil: new Date(Date.now() + 60_000) }), row(3, { holdUntil: new Date(), tombstoned: true })]]);
    await runJanitor("delete", { ...f, options: OPTIONS });
    expect(f.calls.sort()).toEqual([`delete ${KEY(1)}`, `tombstone ${KEY(2)}`]);
    expect(f.finished.map((x) => `${x.id}:${x.outcome}`).sort()).toEqual(["1:deleted", "2:tombstoned", "3:tombstoned"]);
    expect(f.runs).toEqual([
      {
        mode: "delete",
        ok: true,
        result: { claimed: 3, deleted: 1, tombstoned: 2, failed: 0, refused: 0, dryRun: 0, batches: 1, holdClaimed: 0, holdCopied: 0, holdUnavailable: 0, holdCopyFailed: 0 },
        error: null,
      },
    ]);
  });

  it("records failures for backoff without the key, and keeps going", async () => {
    const f = fakes([[row(1), row(2), row(3, { attempts: 4 })]], { failKeys: new Set([KEY(2), KEY(3)]) });
    await runJanitor("delete", { ...f, options: OPTIONS });
    expect(f.finished.filter((x) => x.outcome === "failed").map((x) => [x.id, x.error]).sort()).toEqual([
      ["2", "s3:503:SlowDown"],
      ["3", "s3:503:SlowDown"],
    ]);
    expect(f.finished.find((x) => x.id === "1")?.outcome).toBe("deleted");
    expect(f.logs.filter((l) => l.event === "janitor.delete_failed")).toHaveLength(2);
    // From the fifth failure on, the row is reported as failing (alerting).
    expect(f.logs.filter((l) => l.event === "janitor.failing").map((l) => l.fields.objectDeletionId)).toEqual(["3"]);
    expect(JSON.stringify(f.logs)).not.toContain(KEY(2));
    expect(f.runs[0]).toMatchObject({ ok: true, result: { deleted: 1, failed: 2 } });
  });

  it("never touches storage for rows a guard rail refused, and logs them as errors", async () => {
    const f = fakes([[row(1, { objectKey: null, refused: "share_open" }), row(2)]]);
    await runJanitor("delete", { ...f, options: OPTIONS });
    expect(f.calls).toEqual([`delete ${KEY(2)}`]);
    expect(f.finished.map((x) => x.id)).toEqual(["2"]);
    expect(f.logs.find((l) => l.event === "janitor.guard_refused")).toMatchObject({
      level: "error",
      fields: { objectDeletionId: "1", guard: "share_open" },
    });
  });

  it("checks the key a third time and refuses a malformed one", async () => {
    const f = fakes([[row(1, { objectKey: "d7/2026/10/16/../../etc" })]]);
    await runJanitor("delete", { ...f, options: OPTIONS });
    expect(f.calls).toEqual([]);
    expect(f.finished).toEqual([{ id: "1", outcome: "failed", error: "guard:key_format" }]);
    expect(f.logs.find((l) => l.event === "janitor.guard_refused")?.level).toBe("error");
  });

  it("dry run claims and logs, then releases rows without writing to storage", async () => {
    const f = fakes([[row(1), row(2, { holdUntil: new Date(Date.now() + 60_000) })]]);
    await runJanitor("delete", { ...f, options: { ...OPTIONS, dryRun: true } });
    expect(f.calls).toEqual([]);
    expect(f.finished.map((x) => x.outcome)).toEqual(["dry_run", "dry_run"]);
    expect(f.logs.map((l) => l.event).filter((e) => e.startsWith("janitor.would"))).toEqual(["janitor.would_delete", "janitor.would_tombstone"]);
    expect(f.runs[0]?.result).toMatchObject({ dryRun: 2, deleted: 0 });
  });

  it("claims batch after batch until nothing is due, at most maxRows per invocation", async () => {
    const batch = (from: number) => Array.from({ length: 100 }, (_, i) => row(from + i));
    const f = fakes([batch(0), batch(100), batch(200), [row(999)]]);
    await runJanitor("delete", { ...f, options: { ...OPTIONS, maxRows: 250 } });
    // 100 + 100 + 50: the last claim asks only for what is left of the budget.
    expect(f.claims).toEqual([100, 100, 50]);
    expect(f.finished).toHaveLength(300); // the fake ignores the limit; the database honours it
  });

  it("stops claiming when the time budget runs out", async () => {
    let t = 0;
    const f = fakes([[row(1)], [row(2)], [row(3)]]);
    await runJanitor("delete", { ...f, options: { ...OPTIONS, timeBudgetMs: 1000, now: () => (t += 600) } });
    expect(f.claims.length).toBeLessThan(3);
  });

  it("exits at once when the kill switch is off", async () => {
    const f = fakes([[row(1)]], { enabled: false });
    await runJanitor("delete", { ...f, options: OPTIONS });
    expect(f.claims).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(f.runs).toEqual([{ mode: "delete", ok: true, result: { skipped: "disabled" }, error: null }]);
  });

  it("records a failed run when the database fails", async () => {
    const f = fakes([]);
    f.db.claimDeletions = async () => {
      throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    };
    await runJanitor("delete", { ...f, options: OPTIONS });
    expect(f.runs).toEqual([{ mode: "delete", ok: false, result: {}, error: "ECONNREFUSED" }]);
    expect(f.logs.find((l) => l.event === "janitor.run_failed")?.level).toBe("error");
  });
});

describe("legal hold copies (D-2, RISK-031)", () => {
  it("copies each held object to its hold/ twin before deleting anything, and records it", async () => {
    const f = fakes([[row(1)]], { copies: [[hc(5)]] });
    await runJanitor("delete", { ...f, options: OPTIONS });
    expect(f.calls).toEqual([`copy ${KEY(5)} -> hold/${KEY(5)}`, `delete ${KEY(1)}`]);
    expect(f.copyFinished).toEqual([{ id: "5", outcome: "copied", error: null }]);
    expect(f.runs[0]).toMatchObject({ ok: true, result: { holdClaimed: 1, holdCopied: 1, deleted: 1 } });
    expect(f.logs.find((l) => l.event === "janitor.hold_copied")).toMatchObject({ level: "info", fields: { objectDeletionId: "5", keyClass: "d7" } });
    expect(JSON.stringify(f.logs)).not.toContain(KEY(5));
  });

  it("a source already gone is reported as evidence unavailable, unless an earlier attempt made the copy", async () => {
    const f = fakes([], { copies: [[hc(6), hc(7)]], missing: new Set([KEY(6), KEY(7)]), existing: new Set([`hold/${KEY(7)}`]) });
    await runJanitor("delete", { ...f, options: { ...OPTIONS, concurrency: 1 } });
    expect(f.copyFinished).toEqual([
      { id: "6", outcome: "unavailable", error: null },
      { id: "7", outcome: "copied", error: null },
    ]);
    expect(f.logs.find((l) => l.event === "janitor.hold_source_missing")).toMatchObject({ level: "error", fields: { objectDeletionId: "6" } });
    expect(f.runs[0]).toMatchObject({ result: { holdCopied: 1, holdUnavailable: 1 } });
  });

  it("a failed copy backs off like a deletion, without the key, and is reported as failing from the fifth failure", async () => {
    const f = fakes([], { copies: [[hc(8), hc(9, { attempts: 4 })]], failKeys: new Set([KEY(8), KEY(9)]) });
    await runJanitor("delete", { ...f, options: OPTIONS });
    expect(f.copyFinished.map((x) => [x.id, x.outcome, x.error]).sort()).toEqual([
      ["8", "failed", "s3:503:SlowDown"],
      ["9", "failed", "s3:503:SlowDown"],
    ]);
    expect(f.logs.filter((l) => l.event === "janitor.hold_copy_failed")).toHaveLength(2);
    expect(f.logs.filter((l) => l.event === "janitor.failing").map((l) => l.fields.objectDeletionId)).toEqual(["9"]);
    expect(JSON.stringify(f.logs)).not.toContain(KEY(8));
    expect(f.runs[0]).toMatchObject({ ok: true, result: { holdCopyFailed: 2 } });
  });

  it("never copies a row a guard rail refused, or one whose keys aren't a generated key and its own hold/ twin", async () => {
    const f = fakes([], {
      copies: [[hc(1, { objectKey: null, copyKey: null, refused: "key_format" }), hc(2, { copyKey: `hold/${KEY(3)}` }), hc(4, { objectKey: "d7/../x" })]],
    });
    await runJanitor("delete", { ...f, options: { ...OPTIONS, concurrency: 1 } });
    expect(f.calls).toEqual([]);
    expect(f.copyFinished).toEqual([
      { id: "2", outcome: "failed", error: "guard:key_format" },
      { id: "4", outcome: "failed", error: "guard:key_format" },
    ]);
    expect(f.logs.filter((l) => l.event === "janitor.guard_refused").map((l) => l.level)).toEqual(["error", "error", "error"]);
  });

  it("copies held objects in a dry run too: a copy only preserves, it deletes nothing", async () => {
    const f = fakes([[row(1)]], { copies: [[hc(5)]] });
    await runJanitor("delete", { ...f, options: { ...OPTIONS, dryRun: true } });
    expect(f.calls).toEqual([`copy ${KEY(5)} -> hold/${KEY(5)}`]);
    expect(f.copyFinished.map((x) => x.outcome)).toEqual(["copied"]);
    expect(f.finished.map((x) => x.outcome)).toEqual(["dry_run"]);
  });

  it("shares the per-invocation row budget with deletions", async () => {
    const f = fakes([[row(1)]], { copies: [Array.from({ length: 3 }, (_, i) => hc(10 + i))] });
    await runJanitor("delete", { ...f, options: { ...OPTIONS, maxRows: 5 } });
    expect(f.copyClaims).toEqual([5, 2]);
    expect(f.claims).toEqual([2, 1]);
  });

  it("after a release, deleting the row removes its hold copy too; a tombstoned original keeps its key", async () => {
    const f = fakes([
      [
        row(1, { holdCopyKey: `hold/${KEY(1)}` }),
        row(2, { holdCopyKey: `hold/${KEY(2)}`, holdUntil: new Date(Date.now() + 60_000) }),
      ],
    ]);
    await runJanitor("delete", { ...f, options: { ...OPTIONS, concurrency: 1 } });
    expect(f.calls).toEqual([`delete ${KEY(1)}`, `delete hold/${KEY(1)}`, `tombstone ${KEY(2)}`, `delete hold/${KEY(2)}`]);
    expect(f.finished.map((x) => `${x.id}:${x.outcome}`)).toEqual(["1:deleted", "2:tombstoned"]);
  });

  it("refuses a deletion whose hold copy key isn't the row's own hold/ twin", async () => {
    const f = fakes([[row(1, { holdCopyKey: `hold/${KEY(2)}` }), row(3, { holdCopyKey: KEY(4) })]]);
    await runJanitor("delete", { ...f, options: { ...OPTIONS, concurrency: 1 } });
    expect(f.calls).toEqual([]);
    expect(f.finished).toEqual([
      { id: "1", outcome: "failed", error: "guard:key_format" },
      { id: "3", outcome: "failed", error: "guard:key_format" },
    ]);
  });

  it("a dry run deletes neither the original nor the copy", async () => {
    const f = fakes([[row(1, { holdCopyKey: `hold/${KEY(1)}` })]]);
    await runJanitor("delete", { ...f, options: { ...OPTIONS, dryRun: true } });
    expect(f.calls).toEqual([]);
    expect(f.logs.find((l) => l.event === "janitor.would_delete")?.fields).toMatchObject({ holdCopy: true });
  });

  it("claims no copies while the kill switch is off", async () => {
    const f = fakes([], { enabled: false, copies: [[hc(5)]] });
    await runJanitor("delete", { ...f, options: OPTIONS });
    expect(f.copyClaims).toEqual([]);
    expect(f.calls).toEqual([]);
  });
});

describe("reconcile mode", () => {
  it("lists page by page, queues through the database and saves the cursor", async () => {
    const f = fakes([]);
    const pages: unknown[] = [];
    f.db.reconcileClaim = async () => ({ runId: "7", cursor: null, startedAt: new Date() });
    f.db.reconcilePage = async (runId, keys, start, next, done) => {
      pages.push({ runId, keys: keys.length, start, next, done });
      return { listed: keys.length, orphansQueued: done ? 1 : 0, unknownKeys: 0, missingObjects: done ? 1 : 0, holdCopies: done ? 1 : 0 };
    };
    const listed = [
      { keys: [{ key: KEY(1), lastModified: new Date() }, { key: KEY(2), lastModified: new Date() }], truncated: true },
      { keys: [{ key: KEY(3), lastModified: new Date() }], truncated: false },
    ];
    const starts: (string | null)[] = [];
    f.storage.listObjects = async (startAfter) => {
      starts.push(startAfter);
      return listed.shift()!;
    };
    let aborted = 0;
    f.storage.listMultipartUploads = async () => [
      { key: KEY(8), uploadId: "old", initiated: new Date(Date.now() - 25 * 3600_000) },
      { key: KEY(9), uploadId: "new", initiated: new Date() },
    ];
    f.storage.abortMultipartUpload = async () => {
      aborted++;
    };
    const notes: unknown[] = [];
    f.db.reconcileNote = async (_id, counts) => {
      notes.push(counts);
    };
    await runJanitor("reconcile", { ...f, options: { ...OPTIONS, now: Date.now } });
    expect(starts).toEqual([null, KEY(2)]);
    expect(pages).toEqual([
      { runId: "7", keys: 2, start: null, next: KEY(2), done: false },
      { runId: "7", keys: 1, start: KEY(2), next: null, done: true },
    ]);
    // C-5: multipart uploads are reported; ones older than 24 hours are aborted.
    expect(aborted).toBe(1);
    expect(notes).toEqual([{ multipartInProgress: 2, multipartAborted: 1 }]);
    expect(f.logs.map((l) => l.event)).toEqual(expect.arrayContaining(["reconcile.missing_object", "reconcile.orphans_queued"]));
    expect(f.runs[0]).toMatchObject({ mode: "reconcile", ok: true, result: { pages: 2, listed: 3, holdCopies: 1, done: true } });
  });

  it("does nothing without a run to work on", async () => {
    const f = fakes([]);
    await runJanitor("reconcile", { ...f, options: OPTIONS });
    expect(f.runs[0]).toMatchObject({ ok: true, result: { skipped: "no_run" } });
  });
});

describe("the trigger contract", () => {
  it("accepts only the shared secret, compared in constant time, and the previous one during rotation", () => {
    const secrets = ["current-secret-value", "previous-secret-value"];
    expect(authorize("Bearer current-secret-value", secrets)).toBe(true);
    expect(authorize("Bearer previous-secret-value", secrets)).toBe(true);
    for (const header of [null, "", "Bearer", "Bearer current-secret-valu", "Bearer current-secret-valuee", "bearer current-secret-value", "Basic x"]) {
      expect(authorize(header, secrets)).toBe(false);
    }
    expect(authorize("Bearer ", ["", "x"].filter(Boolean))).toBe(false);
  });

  it("accepts exactly {\"mode\":\"delete\"} or {\"mode\":\"reconcile\"}", () => {
    expect(parseJanitorBody('{"mode":"delete"}')).toBe("delete");
    expect(parseJanitorBody('{ "mode": "reconcile" }')).toBe("reconcile");
    for (const body of ["", "{}", '{"mode":"purge"}', '{"mode":"delete","extra":1}', '["delete"]', "delete", '{"mode":null}']) {
      expect(parseJanitorBody(body)).toBeNull();
    }
  });

  it("reads only its own settings, never the secrets Supabase injects (C-4)", () => {
    const asked: string[] = [];
    const env: Record<string, string> = {
      JANITOR_DATABASE_URL: "postgresql://app_janitor:x@db:5432/postgres",
      JANITOR_TRIGGER_SECRET: "a".repeat(32),
      JANITOR_S3_ENDPOINT: "http://local-saver-s3:9000",
      JANITOR_S3_BUCKET: "bucket",
      JANITOR_S3_ACCESS_KEY_ID: "id",
      JANITOR_S3_SECRET_ACCESS_KEY: "secret",
      SUPABASE_DB_URL: "postgresql://postgres:x@db:5432/postgres",
      SUPABASE_SERVICE_ROLE_KEY: "service",
    };
    const get = (name: string) => {
      asked.push(name);
      return env[name];
    };
    const config = readJanitorConfig(get);
    expect(config.databaseUrl).toContain("app_janitor");
    expect(config.dryRun).toBe(false);
    expect(asked.every((name) => name.startsWith("JANITOR_"))).toBe(true);

    expect(() => readJanitorConfig((name) => (name === "JANITOR_DATABASE_URL" ? undefined : env[name]))).toThrow(/JANITOR_DATABASE_URL/);
    expect(() => readJanitorConfig((name) => (name === "JANITOR_TRIGGER_SECRET" ? "short" : env[name]))).toThrow(/JANITOR_TRIGGER_SECRET/);
    expect(readJanitorConfig((name) => (name === "JANITOR_DRY_RUN" ? "true" : env[name])).dryRun).toBe(true);
  });

  it("configuration errors name the settings, never their values or the injected secrets (C-4)", () => {
    const marker = (name: string) => `value-of-${name}-${"x".repeat(32)}`;
    const names = ["JANITOR_DATABASE_URL", "JANITOR_TRIGGER_SECRET", "JANITOR_S3_ENDPOINT", "JANITOR_S3_BUCKET", "JANITOR_S3_ACCESS_KEY_ID", "JANITOR_S3_SECRET_ACCESS_KEY"];
    const env: Record<string, string> = Object.fromEntries(names.map((n) => [n, marker(n)]));
    env.JANITOR_DATABASE_URL = `postgresql://app_janitor:${marker("password")}@db:5432/postgres`;
    env.SUPABASE_DB_URL = `postgresql://postgres:${marker("SUPABASE_DB_URL")}@db:5432/postgres`;
    env.SUPABASE_SERVICE_ROLE_KEY = marker("SUPABASE_SERVICE_ROLE_KEY");
    const failures = [
      (name: string) => (name === "JANITOR_S3_SECRET_ACCESS_KEY" ? undefined : env[name]),
      (name: string) => (name === "JANITOR_TRIGGER_SECRET" ? "short-secret-value" : env[name]),
      (name: string) => (name === "JANITOR_DATABASE_URL" ? `mysql://root:${marker("password")}@db/x` : env[name]),
    ];
    for (const get of failures) {
      const message = (() => {
        try {
          readJanitorConfig(get);
        } catch (error) {
          return String((error as Error).message);
        }
        return "no error";
      })();
      expect(message).toMatch(/^storage-janitor/);
      expect(message).not.toMatch(/value-of-|short-secret-value|SUPABASE_/);
    }
  });
});

describe("database adapter", () => {
  it("calls only the janitor functions, with parameters, never string-built SQL", async () => {
    const queries: { text: string; params: unknown[] }[] = [];
    const db = createJanitorDb(async (text, params) => {
      queries.push({ text, params });
      if (text.includes("janitor_claim_deletions")) {
        return [{ id: "5", object_key: KEY(5), reason: "orphan", hold_until: null, tombstoned: false, refused: null, attempts: 2 }];
      }
      if (text.includes("janitor_begin_run")) return [{ enabled: true }];
      if (text.includes("janitor_finish_deletion")) return [{ ok: true }];
      if (text.includes("janitor_claim_hold_copies")) return [{ id: "6", object_key: KEY(6), copy_key: `hold/${KEY(6)}`, refused: null, attempts: 1 }];
      if (text.includes("janitor_finish_hold_copy")) return [{ ok: true }];
      return [];
    });
    expect(await db.beginRun("delete")).toEqual({ enabled: true });
    expect(await db.claimDeletions(100)).toEqual([row(5, { reason: "orphan", attempts: 2 })]);
    await db.finishDeletion("5", "failed", "s3:500");
    expect(await db.claimHoldCopies(50)).toEqual([hc(6, { attempts: 1 })]);
    expect(await db.finishHoldCopy("6", "copied")).toBe(true);
    await db.recordRun("delete", true, { deleted: 1 });
    for (const q of queries) {
      expect(q.text).toMatch(/app\.janitor_[a-z_]+\(/);
      expect(q.text).not.toContain(KEY(5));
      expect(q.text).not.toContain(KEY(6));
    }
    expect(queries.find((q) => q.text.includes("finish_hold_copy"))?.params).toEqual(["6", "copied", null]);
    expect(queries.find((q) => q.text.includes("finish"))?.params).toEqual(["5", "failed", "s3:500"]);
    expect(queries.find((q) => q.text.includes("record_run"))?.params).toEqual(["delete", true, '{"deleted":1}', null]);
  });
});
