import {
  AbortMultipartUploadCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import pg from "pg";
import { LOCAL } from "../../../scripts/local-stack.cjs";
import {
  createJanitorDb,
  DEFAULT_OPTIONS,
  type JanitorOptions,
  type JanitorStorage,
  type LogFn,
  type Mode,
  runJanitor,
} from "../../../supabase/functions/_shared/janitor-core";
import { adminDb, stack } from "./api";

/**
 * The storage janitor in integration tests (phase 3 §17.15). Two ways to run it:
 *
 * - drainJanitor: ask the real storage-janitor Edge Function (Deno, aws4fetch, app_janitor) to run,
 *   exactly as pg_cron does, until a condition holds. pg_cron also triggers it every minute, so
 *   tests wait for the effect rather than for one particular run.
 * - runNodeJanitor: the same core in this process, against RustFS or a fault proxy, for tests that
 *   need a deterministic run (fault injection, dry run). Pause the cron trigger first.
 */

export async function triggerJanitor(mode: Mode = "delete"): Promise<number> {
  const response = await fetch(LOCAL.janitorUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${LOCAL.janitorTriggerSecret}`, "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  await response.body?.cancel();
  return response.status;
}

/** Trigger the janitor until `done()` holds (or the timeout passes). Returns whether it held. */
export async function drainJanitor(done: () => Promise<boolean>, options: { timeoutMs?: number; mode?: Mode } = {}): Promise<boolean> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (await done()) return true;
    const status = await triggerJanitor(options.mode);
    if (status !== 202) throw new Error(`storage-janitor answered ${status}: is the edge runtime running (pnpm stack:start)?`);
    for (let i = 0; i < 6 && Date.now() < deadline; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (await done()) return true;
    }
  }
  return done();
}

/** Node S3 adapter for the core (the Edge Function uses supabase/functions/_shared/s3-fetch.ts). */
export function sdkStorage(endpoint: string = stack().storage.endpoint): JanitorStorage {
  const { bucket, accessKeyId, secretAccessKey } = stack().storage;
  const s3 = new S3Client({ region: "auto", endpoint, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1 });
  const fail = (error: unknown): never => {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    throw Object.assign(new Error("storage request failed"), status ? { status, code: (error as Error).name } : { name: (error as Error).name });
  };
  return {
    async deleteObject(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(fail);
    },
    async putTombstone(key) {
      await s3
        .send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: new Uint8Array(0),
            ContentType: "application/octet-stream",
            CacheControl: "no-store",
            Metadata: { tombstone: "1" },
          }),
        )
        .catch(fail);
    },
    async copyObject(source, destination) {
      try {
        await s3.send(new CopyObjectCommand({ Bucket: bucket, Key: destination, CopySource: `${bucket}/${source}`, MetadataDirective: "COPY" }));
        return "copied";
      } catch (error) {
        if ((error as Error).name === "NoSuchKey") return "missing";
        return fail(error);
      }
    },
    async objectExists(key) {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false;
        return fail(error);
      }
    },
    async objectSize(key) {
      try {
        return (await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).ContentLength ?? null;
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
        return fail(error);
      }
    },
    async listObjects(startAfter, maxKeys) {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: maxKeys, StartAfter: startAfter ?? undefined })).catch(fail);
      return {
        truncated: page.IsTruncated === true,
        keys: (page.Contents ?? []).map((c) => ({ key: c.Key ?? "", lastModified: c.LastModified ?? new Date(0) })),
      };
    },
    async listMultipartUploads() {
      const page = await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket })).catch(fail);
      return (page.Uploads ?? []).map((u) => ({ key: u.Key ?? "", uploadId: u.UploadId ?? "", initiated: u.Initiated ?? new Date() }));
    },
    async abortMultipartUpload(key, uploadId) {
      await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })).catch(fail);
    },
  };
}

export type JanitorLog = { level: string; event: string; fields: Record<string, unknown> }[];

/** One janitor run in this process, connected as app_janitor. Returns what it logged. */
export async function runNodeJanitor(
  mode: Mode = "delete",
  options: { storage?: JanitorStorage; dryRun?: boolean; overrides?: Partial<JanitorOptions> } = {},
): Promise<JanitorLog> {
  const pool = new pg.Pool({ connectionString: LOCAL.janitorDatabaseUrl, max: 4 });
  const logs: JanitorLog = [];
  const log: LogFn = (level, event, fields) => logs.push({ level, event, fields });
  try {
    const db = createJanitorDb(async (text, params) => (await pool.query(text, params)).rows);
    await runJanitor(mode, {
      db,
      storage: options.storage ?? sdkStorage(),
      log,
      options: { ...DEFAULT_OPTIONS, dryRun: options.dryRun ?? false, now: Date.now, ...options.overrides },
    });
  } finally {
    await pool.end();
  }
  return logs;
}

/** Pause or resume one pg_cron job (chaos tests, T3-07; isolation for deterministic runs). */
export async function setCronJobActive(jobname: string, active: boolean): Promise<void> {
  const { rowCount } = await adminDb().query("select cron.alter_job(jobid, active := $2) from cron.job where jobname = $1", [jobname, active]);
  if (rowCount !== 1) throw new Error(`no cron job ${jobname}`);
}

/** The outbox row for an object key (latest first). */
export async function outboxFor(key: string) {
  const { rows } = await adminDb().query(
    `select id, reason, attempts, last_error, not_before, locked_until, tombstoned_at, completed_at, legal_hold, hold_reason, hold_copy
       from app.object_deletions where object_key = $1 order by id desc limit 1`,
    [key],
  );
  return rows[0] as
    | {
        id: string;
        reason: string;
        attempts: number;
        last_error: string | null;
        not_before: Date;
        locked_until: Date | null;
        tombstoned_at: Date | null;
        completed_at: Date | null;
        legal_hold: boolean;
        hold_reason: string | null;
        hold_copy: "copied" | "unavailable" | null;
      }
    | undefined;
}
