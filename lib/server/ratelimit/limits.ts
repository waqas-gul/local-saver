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
} as const satisfies Record<string, Limit>;

export type LimitName = keyof typeof LIMITS;

type HitResult = { allowed: boolean; reset_at: Date };

async function hit(key: string, limit: number, window: string, cost: number): Promise<HitResult> {
  const { rows } = await sql<HitResult>`
    select allowed, reset_at from app.rate_limit_hit(${key}, ${limit}::integer, ${window}::interval, ${cost}::integer)
  `.execute(getDb());
  return rows[0] as HitResult;
}

function retryAfterSeconds(resetAt: Date): string {
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
