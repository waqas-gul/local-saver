import "server-only";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordLengthOk } from "@/lib/shared/link-password";
import { audit } from "../audit/log";
import { getDb } from "../db/client";
import type { Env } from "../env";
import { ApiError, linkUnavailable, passwordRequired } from "../http/errors";
import { log } from "../log";
import { requesterKey } from "../network/requester";
import { addFailure, clearCounter, countRecent, enforceRateLimit, reserveSlot, retryAfterSeconds, type Slot } from "../ratelimit/limits";
import { turnstileConfigured, verifyTurnstile } from "../security/turnstile";
import type { OpenGrant } from "./grants";

/**
 * Link passwords (Phase 4, phase 4 §17.8.3, 03 §4.7, DEC-021).
 *
 * Hashing: scrypt with N = 2^17, r = 8, p = 1 (128 MiB, OWASP's minimum), a 16-byte random salt and a
 * 32-byte key, stored as a PHC string `$scrypt$ln=17,r=8,p=1$<salt>$<hash>`. D4-24 allowed Argon2id only
 * with an approved native package; this build adds no package, so it takes the plan's built-in option
 * (deviation DV4-70). The database refuses any other format (`share_links_password_hash`), and so does
 * verification, so a weaker stored value is never hashed.
 *
 * Input: 8–128 characters after NFC normalization, counted as characters (code points). The password is
 * never logged, stored or returned; only this module sees it, and only to hash it.
 *
 * CPU: one hash costs about 0.4 s of a core and 128 MiB. Every attempt passes its limits before it is
 * hashed (runPasswordAttempt), and at most 4 hashes run at once in a process, with 32 more waiting;
 * beyond that the request is refused (503 SERVER_BUSY) rather than queued without bound.
 */

export { passwordLengthOk };
export const SCRYPT_PARAMS = { ln: 17, r: 8, p: 1 } as const;
export const MAX_CONCURRENT_HASHES = 4;
export const MAX_QUEUED_HASHES = 32;

const KEY_BYTES = 32;
const SALT_BYTES = 16;
// Node refuses scrypt when 128 · N · r exceeds maxmem (32 MiB by default); N = 2^17, r = 8 needs 128 MiB.
const MAXMEM = 256 * 1024 * 1024;
const PREFIX = `$scrypt$ln=${SCRYPT_PARAMS.ln},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}$`;
const STORED = /^\$scrypt\$ln=17,r=8,p=1\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/;

/** A counting semaphore with a bounded queue: the per-process cap on concurrent hashes. */
export class HashSlots {
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(
    readonly limit: number,
    readonly queueLimit: number,
  ) {}

  get active(): number {
    return this.running;
  }

  get waiting(): number {
    return this.queue.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      if (this.queue.length >= this.queueLimit) {
        throw new ApiError(503, "SERVER_BUSY", "Too many requests right now. Try again in a moment.", undefined, { "Retry-After": "1" });
      }
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.running++;
    }
    try {
      return await task();
    } finally {
      // Hand the slot straight to the next waiter, so the count never dips and lets a newcomer jump the queue.
      const next = this.queue.shift();
      if (next) next();
      else this.running--;
    }
  }
}

export const hashSlots = new HashSlots(MAX_CONCURRENT_HASHES, MAX_QUEUED_HASHES);

function normalize(password: string): string {
  return password.normalize("NFC");
}

export function passwordInvalid(): ApiError {
  return new ApiError(422, "PASSWORD_INVALID", `A password needs ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters`, {
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
  });
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return hashSlots.run(
    () =>
      new Promise<Buffer>((resolve, reject) =>
        scrypt(normalize(password), salt, KEY_BYTES, { N: 2 ** SCRYPT_PARAMS.ln, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, maxmem: MAXMEM }, (error, key) =>
          error ? reject(error) : resolve(key),
        ),
      ),
  );
}

const b64 = (bytes: Buffer) => bytes.toString("base64").replace(/=+$/, "");

/** The PHC string to store. 422 PASSWORD_INVALID outside 8–128 characters. */
export async function hashLinkPassword(password: string): Promise<string> {
  if (!passwordLengthOk(password)) throw passwordInvalid();
  const salt = randomBytes(SALT_BYTES);
  return `${PREFIX}${b64(salt)}$${b64(await derive(password, salt))}`;
}

/** Timing-safe. A stored value in any other format, or a password that breaks the rules, is simply wrong. */
export async function verifyLinkPasswordHash(password: string, stored: string): Promise<boolean> {
  const match = STORED.exec(stored);
  if (!match || !passwordLengthOk(password)) return false;
  const expected = Buffer.from(match[2]!, "base64");
  const actual = await derive(password, Buffer.from(match[1]!, "base64"));
  return expected.length === KEY_BYTES && timingSafeEqual(actual, expected);
}

/**
 * The order of every password attempt (T4-P8). `admit` runs every check that can refuse without hashing
 * (link state, lock, limits, Turnstile) and reserves the attempt against the failure limits; only then is
 * the password hashed. A wrong password keeps its reservation as a failure; a right one, or a hash that
 * never ran (the server was busy), gives it back.
 */
export type AttemptSteps<A> = {
  admit: () => Promise<A>;
  compare: (admission: A) => Promise<boolean>;
  verified: (admission: A) => Promise<void>;
  failed: (admission: A) => Promise<void>;
  release: (admission: A) => Promise<void>;
};

export async function runPasswordAttempt<A>(steps: AttemptSteps<A>): Promise<void> {
  const admission = await steps.admit();
  let matches: boolean;
  try {
    matches = await steps.compare(admission);
  } catch (error) {
    await steps.release(admission);
    throw error;
  }
  if (matches) await steps.verified(admission);
  else await steps.failed(admission);
}

/**
 * Attempt limits (phase 4 §17.8.3, 03 §4.7, §10). Failures are counted per link and per network key, and an
 * attempt is reserved against both before it is hashed, so concurrent attempts can't exceed them. Each count
 * covers the current window and the one before (countRecent), so failures either side of a window boundary
 * still count together: any 10 within 15 minutes, or 20 within an hour, always reach the limit.
 * - 10 failures in 15 minutes on a link lock it for 15 minutes (423 LINK_LOCKED + Retry-After), and its count
 *   starts again from zero. Grants that already proved the password keep working (RISK-044); only new
 *   attempts wait.
 * - After a lock, Turnstile is required for every attempt on that link until an hour after the lock ended.
 *   Without Turnstile configured (local only; deployments require it) the attempt waits instead (DV2-19).
 * - 20 failures in an hour from one network key: 429 for that network on every link.
 * Two plain request limits (per session, per network key) bound the CPU spent on right passwords too.
 */
export const LOCK_AFTER_FAILURES = 10;
const FAILURE_WINDOW = "15 minutes";
const LOCK = "15 minutes";
const CHALLENGE_AFTER_LOCK = "1 hour";
const NETWORK_FAILURES = 20;
const NETWORK_WINDOW = "1 hour";
const GLOBAL_WINDOW = "10 minutes";
const GLOBAL_ALERT = 1000;

type Admission = { hash: string; version: number; linkSlot: Slot; networkSlot: Slot };

function seconds(until: Date, now: Date): string {
  return String(Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000)));
}

function linkLocked(retryAfter: string): ApiError {
  return new ApiError(423, "LINK_LOCKED", "Too many wrong passwords. Try again later.", undefined, { "Retry-After": retryAfter });
}

function tooManyFailures(retryAfter: string): ApiError {
  return new ApiError(429, "RATE_LIMITED", "Too many wrong passwords. Try again later.", undefined, { "Retry-After": retryAfter });
}

/**
 * POST /links/{linkId}/password, and an unlock that carries the password. The grant was proved open by the
 * caller (requireOpenGrant: 404 without one, 410 for an ended link, whatever the password). The password is
 * never logged, stored or returned; failures are logged by link ID and audited at their thresholds only.
 */
export async function proveLinkPassword(request: Request, env: Env, grant: OpenGrant, password: string, turnstileToken: string | undefined): Promise<void> {
  if (!grant.hasPassword) {
    // Nothing to prove. A grant made before the password was removed still opens nothing (accessFor).
    if (grant.current) return;
    throw linkUnavailable();
  }
  const { linkId, sessionHash } = grant;
  const networkKey = requesterKey(request, env);
  const db = getDb();

  await runPasswordAttempt<Admission>({
    admit: async () => {
      const link = await db
        .selectFrom("app.share_links")
        .select([
          "password_hash",
          "password_version",
          "password_locked_until",
          sql<Date | null>`password_locked_until + ${CHALLENGE_AFTER_LOCK}::interval`.as("challenge_until"),
          sql<Date>`now()`.as("db_now"),
        ])
        .where("id", "=", linkId)
        .executeTakeFirst();
      // Removed since the grant was checked: the grant is stale now.
      if (!link?.password_hash) throw linkUnavailable();
      const now = link.db_now;
      if (link.password_locked_until && link.password_locked_until > now) throw linkLocked(seconds(link.password_locked_until, now));

      const network = await countRecent(`pwFailNet:${networkKey}`, NETWORK_WINDOW);
      if (network.count >= NETWORK_FAILURES) throw tooManyFailures(retryAfterSeconds(network.resetAt));

      if (link.challenge_until && link.challenge_until > now) {
        if (!turnstileConfigured(env)) throw tooManyFailures(seconds(link.challenge_until, now));
        if (!(await verifyTurnstile(env, turnstileToken))) {
          throw new ApiError(403, "TURNSTILE_REQUIRED", "Confirm you're a person to keep trying", { turnstile: true });
        }
      }

      await enforceRateLimit("passwordAttempt", sessionHash.toString("hex"));
      await enforceRateLimit("passwordAttemptNetwork", networkKey);

      // Reserved before hashing: of N attempts at once, at most the limit are evaluated.
      const linkSlot = await reserveSlot(`pwFail:${linkId}`, LOCK_AFTER_FAILURES, FAILURE_WINDOW);
      if (!linkSlot.allowed) {
        await linkSlot.release();
        throw linkLocked(retryAfterSeconds(linkSlot.resetAt));
      }
      const networkSlot = await reserveSlot(`pwFailNet:${networkKey}`, NETWORK_FAILURES, NETWORK_WINDOW);
      if (!networkSlot.allowed) {
        await Promise.all([linkSlot.release(), networkSlot.release()]);
        throw tooManyFailures(retryAfterSeconds(networkSlot.resetAt));
      }
      return { hash: link.password_hash, version: link.password_version, linkSlot, networkSlot };
    },

    compare: (admission) => verifyLinkPasswordHash(password, admission.hash),

    verified: async (admission) => {
      // Only for the version whose hash was checked: a change in the meantime leaves the grant unverified.
      const { rows } = await sql<{ link_id: string }>`
        update app.link_grants g
           set password_version = ${admission.version}, password_verified_at = now()
          from app.share_links l
         where g.session_id_hash = ${sessionHash} and g.link_id = ${linkId} and l.id = g.link_id
           and l.password_hash is not null and l.password_version = ${admission.version} and g.expires_at > now()
        returning g.link_id
      `.execute(db);
      await Promise.all([admission.linkSlot.release(), admission.networkSlot.release()]);
      if (rows.length === 0) throw passwordRequired(linkId);
    },

    failed: async (admission) => {
      log.info("link.password_failed", { linkId });
      if (admission.linkSlot.value >= LOCK_AFTER_FAILURES) {
        const locked = await db
          .updateTable("app.share_links")
          .set({ password_locked_until: sql`now() + ${LOCK}::interval` })
          .where("id", "=", linkId)
          .where((eb) => eb.or([eb("password_locked_until", "is", null), eb("password_locked_until", "<=", sql<Date>`now()`)]))
          .returning("id")
          .executeTakeFirst();
        if (locked) {
          // The lock (then Turnstile) takes over from these failures: after it, the count starts again.
          await clearCounter(`pwFail:${linkId}`);
          log.warn("link.password_locked", { linkId, failures: LOCK_AFTER_FAILURES });
          await audit(db, {
            action: "link.password_failed",
            actorKind: "system",
            networkSpaceId: null,
            targetType: "link",
            targetId: linkId,
            metadata: { threshold: "lock", failures: LOCK_AFTER_FAILURES },
          });
        }
      }
      if (admission.networkSlot.value === NETWORK_FAILURES) {
        log.warn("link.password_network_limited", { failures: NETWORK_FAILURES });
        await audit(db, {
          action: "link.password_failed",
          actorKind: "system",
          networkSpaceId: null,
          targetType: "network",
          metadata: { threshold: "network", failures: NETWORK_FAILURES },
        });
      }
      const global = await addFailure("pwFail:global", GLOBAL_WINDOW);
      if (global === GLOBAL_ALERT) log.error("link.password_failure_spike", { failures: global, window: GLOBAL_WINDOW });
      throw new ApiError(403, "PASSWORD_INCORRECT", "That password isn't right");
    },

    release: async (admission) => {
      await Promise.all([admission.linkSlot.release(), admission.networkSlot.release()]);
    },
  });
}
