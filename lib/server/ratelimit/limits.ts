import "server-only";
import { sql, type Kysely, type Transaction } from "kysely";
import { getDb } from "../db/client";
import type { DB } from "../db/types.gen";
import { ApiError } from "../http/errors";

/**
 * Rate limits (03 §10, DEC-020) on app.rate_limit_hit: atomic fixed windows in Postgres.
 * Exceeding a limit gives 429 with Retry-After (T-049).
 */

type Limit = { limit: number; window: string };

export const LIMITS = {
  // Per Auth session since Phase 4 (one browser; per user before, when every user was one browser).
  registerDevice: { limit: 10, window: "1 hour" },
  renameDevice: { limit: 20, window: "1 hour" },
  observe: { limit: 30, window: "1 minute" },
  feed: { limit: 60, window: "1 minute" },
  myShares: { limit: 60, window: "1 minute" },
  shareRead: { limit: 120, window: "1 minute" },
  // createShare and createLink: the Free values; the caller's plan gives the limit (E28, D4-29).
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

  // Phase 4A: accounts (phase 4 §17.13). me per device; the rest per user, the merge also per device.
  me: { limit: 60, window: "1 minute" },
  updateProfile: { limit: 20, window: "1 hour" },
  listDevices: { limit: 60, window: "1 minute" },
  revokeDevice: { limit: 20, window: "1 hour" },
  mergeIntent: { limit: 5, window: "1 hour" },
  mergeRedeemUser: { limit: 10, window: "10 minutes" },
  mergeRedeemDevice: { limit: 10, window: "10 minutes" },
  // P4-22: account deletion, per user (phase 4 §17.13).
  requestDeletion: { limit: 3, window: "1 day" },
  cancelDeletion: { limit: 10, window: "1 day" },

  // Phase 4D (P4-15): extending a share, per user (phase 4 §17.13).
  extendShare: { limit: 30, window: "1 hour" },

  // Phase 4D (P4-16): link passwords (phase 4 §17.13). Setting one per user; attempts per link session and
  // per network key, right or wrong, checked before hashing (wrong ones also count in links/password.ts).
  updateLink: { limit: 30, window: "1 hour" },
  passwordAttempt: { limit: 20, window: "10 minutes" },
  passwordAttemptNetwork: { limit: 60, window: "10 minutes" },

  // Phase 4D (P4-17): private rooms (phase 4 §17.8.4, §17.13). Writes per user, reads per device; texts and URLs per
  // room as they are per network space; invites per invite and per network key (03 §10).
  createRoom: { limit: 10, window: "1 hour" },
  listRooms: { limit: 60, window: "1 minute" },
  roomRead: { limit: 120, window: "1 minute" },
  updateRoom: { limit: 30, window: "1 hour" },
  deleteRoom: { limit: 10, window: "1 hour" },
  listMembers: { limit: 60, window: "1 minute" },
  removeMember: { limit: 30, window: "1 hour" },
  roomShares: { limit: 60, window: "1 minute" },
  textWriteRoom: { limit: 300, window: "1 minute" },
  downloadUrlRoom: { limit: 600, window: "1 minute" },
  createInvite: { limit: 30, window: "1 hour" },
  // P4-18: QR pairing codes, apart from invite links (a code lasts 10 minutes, so an owner pairing several phones
  // makes several).
  createPairing: { limit: 30, window: "1 hour" },
  // P4-19: room links, on their own keys. Creating: the Free value; the caller's plan gives the limit (Pro 300, D4-29).
  createRoomLink: { limit: 30, window: "1 hour" },
  listRoomLinks: { limit: 60, window: "1 minute" },
  // P4-20: transfer history, per device (phase 4 §17.13).
  historyShares: { limit: 60, window: "1 minute" },
  historyDownloads: { limit: 60, window: "1 minute" },
  listInvites: { limit: 60, window: "1 minute" },
  revokeInvite: { limit: 60, window: "1 minute" },
  inviteAccept: { limit: 10, window: "10 minutes" },
  inviteAcceptNetwork: { limit: 30, window: "1 hour" },
  invitePreview: { limit: 10, window: "10 minutes" },
  invitePreviewNetwork: { limit: 30, window: "1 hour" },

  // Phase 4C: billing (phase 4 §17.13). Checkout and portal per user; reconciliation for the whole deployment.
  checkout: { limit: 10, window: "1 hour" },
  portal: { limit: 20, window: "1 hour" },
  billingReconcile: { limit: 6, window: "1 hour" },

  // Phase 4D: uploads (phase 4 §17.13, P4-14), per user. A 5 GiB file has 320 parts: 16 part requests.
  uploadUrl: { limit: 120, window: "1 minute" },
  multipartParts: { limit: 600, window: "1 minute" },
  multipartStatus: { limit: 60, window: "1 minute" },
  multipartAbort: { limit: 60, window: "1 minute" },
} as const satisfies Record<string, Limit>;

export type LimitName = keyof typeof LIMITS;

type HitResult = { allowed: boolean; current_value: string; reset_at: Date };

async function hit(key: string, limit: number, window: string, cost: number, db: Kysely<DB> | Transaction<DB> = getDb()): Promise<HitResult> {
  const { rows } = await sql<HitResult>`
    select allowed, current_value, reset_at
      from app.rate_limit_hit(${key}, ${limit}::integer, ${window}::interval, ${cost}::integer)
  `.execute(db);
  return rows[0] as HitResult;
}

export function retryAfterSeconds(resetAt: Date): string {
  return String(Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000)));
}

/**
 * Count one action against `name` for this subject (device, user or space ID). `limit` is the
 * caller's plan's value for the plan-dependent limits (E28); the window is always the table's.
 */
export async function enforceRateLimit(name: LimitName, subject: string, limit: number = LIMITS[name].limit): Promise<void> {
  const { window } = LIMITS[name];
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
 * Recent failures (Phase 4, link passwords): the current window and the one before it. Any `limit` failures
 * within one window's length are always counted together, so a limit can't be doubled by failing either side
 * of a window boundary; a failure is forgotten one to two windows after it happened.
 */
export async function countRecent(key: string, window: string): Promise<{ count: number; resetAt: Date }> {
  const { rows } = await sql<{ value: string; reset_at: Date }>`
    select coalesce((select sum(rc.value) from app.rate_counters rc
                      where rc.key = ${key}
                        and rc.window_start in (date_bin(${window}::interval, now(), timestamptz '2000-01-01 00:00:00+00'),
                                                date_bin(${window}::interval, now(), timestamptz '2000-01-01 00:00:00+00') - ${window}::interval)), 0) as value,
           date_bin(${window}::interval, now(), timestamptz '2000-01-01 00:00:00+00') + ${window}::interval as reset_at
  `.execute(getDb());
  const row = rows[0];
  return { count: Number(row?.value ?? 0), resetAt: row?.reset_at ?? new Date() };
}

/**
 * A failure counted in advance (Phase 4, link passwords): the attempt takes a slot before its expensive check,
 * atomically, so concurrent attempts can't all pass a limit that only failures should reach. `value` counts
 * the recent failures (this window and the one before, as countRecent), this attempt included. `release`
 * gives the slot back (the attempt succeeded, or never ran) in the window it was taken from.
 */
export type Slot = { allowed: boolean; value: number; resetAt: Date; release: () => Promise<void> };

export async function reserveSlot(key: string, limit: number, window: string): Promise<Slot> {
  // The limit only decides `allowed`, which is computed over both windows below.
  const result = await hit(key, 2_147_483_647, window, 1);
  const { rows } = await sql<{ previous: string }>`
    select coalesce((select value from app.rate_counters
                      where key = ${key} and window_start = ${result.reset_at}::timestamptz - 2 * ${window}::interval), 0) as previous
  `.execute(getDb());
  const value = Number(result.current_value) + Number(rows[0]?.previous ?? 0);
  return {
    allowed: value <= limit,
    value,
    resetAt: result.reset_at,
    release: async () => {
      await sql`
        update app.rate_counters set value = greatest(value - 1, 0)
         where key = ${key} and window_start = ${result.reset_at}::timestamptz - ${window}::interval
      `.execute(getDb());
    },
  };
}

/** Forget every window of a counter (a link's failures once they have locked it). */
export async function clearCounter(key: string): Promise<void> {
  await sql`delete from app.rate_counters where key = ${key}`.execute(getDb());
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

/** The counters' integer arguments: a day's budget in KiB, at most 2^31 − 1 KiB (2 TiB). */
const MAX_KIB = 2_147_483_647;

async function hitDailyVolume(trx: Transaction<DB>, key: string, kib: number, limitBytes: number): Promise<void> {
  const result = await hit(key, Math.min(MAX_KIB, Math.floor(limitBytes / 1024)), "1 day", kib, trx);
  if (!result.allowed) {
    throw new ApiError(429, "DAILY_UPLOAD_LIMIT", "Daily upload limit reached", undefined, {
      "Retry-After": retryAfterSeconds(result.reset_at),
    });
  }
}

/**
 * Daily upload volume (07 §3, E8, E9): counted in KiB per user and, unless the plan isn't counted
 * per network (D4-10), per network key. Windows start at 00:00 UTC. Charged in the share's creation
 * transaction, after its storage is reserved (C4-6, D4-26): a refusal rolls the whole creation
 * back, charge included. The charge is recorded, so app.end_share can refund a share that never
 * becomes active (app.refund_upload_volume).
 */
export async function chargeDailyVolume(
  trx: Transaction<DB>,
  charge: { shareId: string; userId: string; networkKey: string | null; bytes: number; userLimitBytes: number; networkLimitBytes: number | null },
): Promise<void> {
  const kib = Math.max(1, Math.ceil(charge.bytes / 1024));
  await hitDailyVolume(trx, `upload_kib:user:${charge.userId}`, kib, charge.userLimitBytes);
  const network = charge.networkKey !== null && charge.networkLimitBytes !== null ? charge.networkKey : null;
  if (network !== null) await hitDailyVolume(trx, `upload_kib:net:${network}`, kib, charge.networkLimitBytes as number);
  await sql`
    insert into app.upload_volume_charges (share_id, window_start, kib, network_key)
    values (${charge.shareId}::uuid, date_bin('1 day', now(), timestamptz '2000-01-01 00:00:00+00'), ${kib}, ${network})
  `.execute(trx);
}
