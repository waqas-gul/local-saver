import "server-only";
import { sql } from "kysely";
import { getDb } from "../db/client";
import { ApiError } from "../http/errors";

/**
 * Rate limits (03 §10, DEC-020) on app.rate_limit_hit: atomic fixed windows in Postgres.
 * Exceeding a limit gives 429 with Retry-After (T-049).
 */

type Limit = { limit: number; window: string };

export const LIMITS = {
  registerDevice: { limit: 10, window: "1 hour" },
  renameDevice: { limit: 20, window: "1 hour" },
  observe: { limit: 30, window: "1 minute" },
  feed: { limit: 60, window: "1 minute" },
  myShares: { limit: 60, window: "1 minute" },
  shareRead: { limit: 120, window: "1 minute" },
  createShare: { limit: 30, window: "1 hour" },
  completeUpload: { limit: 120, window: "1 minute" },
  textWriteUser: { limit: 60, window: "1 minute" },
  textWriteSpace: { limit: 300, window: "1 minute" },
  deleteShare: { limit: 60, window: "1 minute" },
  downloadUrl: { limit: 120, window: "1 minute" },
  // Per network space, so extra devices on one network can't multiply the device limit.
  downloadUrlSpace: { limit: 600, window: "1 minute" },

  // Phase 2: remote links (03 §10). Creator side, per user or device.
  createLink: { limit: 30, window: "1 hour" },
  listLinks: { limit: 60, window: "1 minute" },
  revokeLink: { limit: 60, window: "1 minute" },
  regenerateCode: { limit: 30, window: "1 hour" },
  // Viewer side: per link and per network key (unlock), per link session (content, URLs).
  unlockLink: { limit: 30, window: "10 minutes" },
  unlockNetwork: { limit: 60, window: "10 minutes" },
  viewerContent: { limit: 60, window: "1 minute" },
  viewerUrl: { limit: 120, window: "1 minute" },
  // Abuse reports, per network key and per reporter (device or link session).
  reportNetwork: { limit: 10, window: "1 hour" },
  reportReporter: { limit: 10, window: "1 hour" },

  // Phase 3: burn after download (phase 3 §17.12). Reveals count against downloadUrl / viewerUrl.
  confirmReceived: { limit: 30, window: "1 minute" },
  entitlements: { limit: 60, window: "1 minute" },
} as const satisfies Record<string, Limit>;

export type LimitName = keyof typeof LIMITS;

type HitResult = { allowed: boolean; current_value: string; reset_at: Date };

async function hit(key: string, limit: number, window: string, cost: number): Promise<HitResult> {
  const { rows } = await sql<HitResult>`
    select allowed, current_value, reset_at
      from app.rate_limit_hit(${key}, ${limit}::integer, ${window}::interval, ${cost}::integer)
  `.execute(getDb());
  return rows[0] as HitResult;
}

export function retryAfterSeconds(resetAt: Date): string {
  return String(Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000)));
}

/** Count one action against `name` for this subject (device, user or space ID). */
export async function enforceRateLimit(name: LimitName, subject: string): Promise<void> {
  const { limit, window } = LIMITS[name];
  const result = await hit(`${name}:${subject}`, limit, window, 1);
  if (!result.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests, try again later", undefined, {
      "Retry-After": retryAfterSeconds(result.reset_at),
    });
  }
}

/**
 * Failure counters (short codes, 03 §4.4): only failures are counted, so these read a window
 * without adding to it, and add one when an attempt fails.
 */
export async function countInWindow(key: string, window: string): Promise<{ count: number; resetAt: Date }> {
  const { rows } = await sql<{ value: string | null; reset_at: Date }>`
    select (select rc.value from app.rate_counters rc
             where rc.key = ${key}
               and rc.window_start = date_bin(${window}::interval, now(), timestamptz '2000-01-01 00:00:00+00')) as value,
           date_bin(${window}::interval, now(), timestamptz '2000-01-01 00:00:00+00') + ${window}::interval as reset_at
  `.execute(getDb());
  const row = rows[0];
  return { count: Number(row?.value ?? 0), resetAt: row?.reset_at ?? new Date() };
}

/** Add one to a failure counter; returns the new count in this window. */
export async function addFailure(key: string, window: string): Promise<number> {
  // The limit only decides `allowed`, which failure counters don't use.
  return Number((await hit(key, 2_147_483_647, window, 1)).current_value);
}

/**
 * A block that lasts `duration` from now (not to the end of a fixed window): one row per key,
 * extended if it already exists. Expired rows go with the purge job.
 */
export async function setBlock(key: string, duration: string): Promise<void> {
  await sql`
    insert into app.rate_counters (key, window_start, value, expires_at)
    values (${key}, timestamptz '2000-01-01 00:00:00+00', 1, now() + ${duration}::interval)
    on conflict (key, window_start) do update set expires_at = greatest(app.rate_counters.expires_at, excluded.expires_at)
  `.execute(getDb());
}

/** When the block on `key` ends, or null if there is none. */
export async function blockedUntil(key: string): Promise<Date | null> {
  const row = await getDb()
    .selectFrom("app.rate_counters")
    .select("expires_at")
    .where("key", "=", key)
    .where("window_start", "=", new Date("2000-01-01T00:00:00Z"))
    .where(sql<boolean>`expires_at > now()`)
    .executeTakeFirst();
  return row?.expires_at ?? null;
}

/**
 * Per-link daily cap on download and preview URL issuances (07 §3 "Link download volume",
 * Q-027): 500 a day on Free, from the link's entitlement snapshot. Windows start at 00:00 UTC.
 */
export async function enforceLinkDailyUrls(linkId: string, limit: number): Promise<void> {
  const result = await hit(`linkUrlsDay:${linkId}`, limit, "1 day", 1);
  if (!result.allowed) {
    throw new ApiError(429, "LINK_DAILY_LIMIT", "This link has reached its download limit for today", undefined, {
      "Retry-After": retryAfterSeconds(result.reset_at),
    });
  }
}

/**
 * Daily upload volume (07 §3): counted in KiB so a day's budget fits the counter's integer
 * arguments. Windows start at 00:00 UTC.
 */
export async function enforceDailyVolume(subject: string, bytes: number, limitBytes: number): Promise<void> {
  const kib = Math.max(1, Math.ceil(bytes / 1024));
  const result = await hit(`upload_kib:${subject}`, Math.floor(limitBytes / 1024), "1 day", kib);
  if (!result.allowed) {
    throw new ApiError(429, "DAILY_UPLOAD_LIMIT", "Daily upload limit reached", undefined, {
      "Retry-After": retryAfterSeconds(result.reset_at),
    });
  }
}
