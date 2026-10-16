import "server-only";
import { sql } from "kysely";
import type { z } from "zod";
import type { resolveCodeBody } from "@/lib/shared/api/schemas";
import { normalizeShortCode } from "@/lib/shared/short-code";
import { audit } from "../audit/log";
import { IntegrationNotConfiguredError } from "../config/integrations";
import { getDb } from "../db/client";
import type { Env } from "../env";
import { assertRemoteLinksEnabled } from "../flags";
import { ApiError } from "../http/errors";
import { log } from "../log";
import { requesterKey } from "../network/requester";
import { addFailure, blockedUntil, countInWindow, retryAfterSeconds, setBlock } from "../ratelimit/limits";
import { turnstileConfigured, verifyTurnstile } from "../security/turnstile";
import { grantAccess } from "./grants";
import { shortCodeHmacs } from "./secrets";
import { currentSessionHash, issueSession } from "./sessions";

/**
 * POST /codes/resolve { code } (DEC-014, 03 §4.4). A valid code creates a link grant for this
 * browser and returns only the link ID: the long-lived link secret is never revealed by a code.
 *
 * Guessing limits (03 §10), counting failures only:
 * - 5 failures in 10 minutes, per link session or per network key: Turnstile is required for
 *   every further attempt (without Turnstile configured, attempts wait for the window instead);
 * - 20 failures in a day per network key: that network is blocked for 24 hours;
 * - 1,000 failures in 10 minutes across everyone: an error log for alerting (global spike).
 */

const FAILURE_WINDOW = "10 minutes";
const FAILURES_BEFORE_CHALLENGE = 5;
const FAILURES_PER_DAY = 20;
const BLOCK = "24 hours";
const GLOBAL_ALERT = 1000;

function codeUnavailable(): ApiError {
  return new ApiError(404, "CODE_UNAVAILABLE", "This code isn't valid or has expired");
}

async function recordFailure(networkKey: string, subjects: string[]): Promise<void> {
  const [networkCount] = await Promise.all(subjects.map((subject) => addFailure(`codeFail:${subject}`, FAILURE_WINDOW)));
  const daily = await addFailure(`codeFailDay:${networkKey}`, "1 day");
  const global = await addFailure("codeFail:global", FAILURE_WINDOW);

  if (networkCount === FAILURES_BEFORE_CHALLENGE) {
    log.warn("code.resolve_failures", { threshold: "challenge" });
    await audit(getDb(), { action: "code.resolve_failed", actorKind: "system", networkSpaceId: null, targetType: "network", metadata: { threshold: "challenge" } });
  }
  if (daily >= FAILURES_PER_DAY) {
    await setBlock(`codeBlock:${networkKey}`, BLOCK);
    if (daily === FAILURES_PER_DAY) {
      log.warn("code.resolve_blocked", { hours: 24 });
      await audit(getDb(), { action: "code.resolve_blocked", actorKind: "system", networkSpaceId: null, targetType: "network", metadata: { hours: 24 } });
    }
  }
  if (global === GLOBAL_ALERT) log.error("code.resolve_failure_spike", { failures: global, window: FAILURE_WINDOW });
}

/** The live link a code belongs to, or null. Codes, links and shares are all checked here. */
async function findLiveCode(env: Env, code: string): Promise<string | null> {
  const hashes = shortCodeHmacs(env.codePeppers, code);
  const rows = await getDb()
    .selectFrom("app.share_links as l")
    .innerJoin("app.shares as s", "s.id", "l.share_id")
    .select(["l.id", "l.short_code_hmac", "l.short_code_pepper_version"])
    .where("l.short_code_hmac", "in", hashes.map((h) => h.hmac))
    .where(sql<boolean>`l.short_code_expires_at > now()`)
    .where("l.revoked_at", "is", null)
    .where(sql<boolean>`l.expires_at > now()`)
    .where("s.status", "=", "active")
    .where(sql<boolean>`s.expires_at > now()`)
    .execute();
  // The hash must match under the pepper version it was stored with.
  const match = rows.find((row) =>
    hashes.some((h) => h.version === row.short_code_pepper_version && row.short_code_hmac !== null && h.hmac.equals(row.short_code_hmac)),
  );
  return match?.id ?? null;
}

export async function resolveCode(
  request: Request,
  env: Env,
  body: z.infer<typeof resolveCodeBody>,
): Promise<{ linkId: string; setCookie: string }> {
  await assertRemoteLinksEnabled(env, { shortCodes: true });
  if (env.codePeppers.length === 0) throw new IntegrationNotConfiguredError("Short codes", ["CODE_PEPPER"]);

  const networkKey = requesterKey(request, env);
  const session = await currentSessionHash(request, env);
  const subjects = [`net:${networkKey}`, ...(session ? [`session:${session.toString("hex")}`] : [])];

  const blocked = await blockedUntil(`codeBlock:${networkKey}`);
  if (blocked) {
    throw new ApiError(429, "RATE_LIMITED", "Too many wrong codes. Try again later.", undefined, {
      "Retry-After": retryAfterSeconds(blocked),
    });
  }

  const recent = await Promise.all(subjects.map((subject) => countInWindow(`codeFail:${subject}`, FAILURE_WINDOW)));
  const worst = recent.reduce((a, b) => (b.count > a.count ? b : a));
  if (worst.count >= FAILURES_BEFORE_CHALLENGE) {
    if (!turnstileConfigured(env)) {
      throw new ApiError(429, "RATE_LIMITED", "Too many wrong codes. Try again later.", undefined, {
        "Retry-After": retryAfterSeconds(worst.resetAt),
      });
    }
    if (!(await verifyTurnstile(env, body.turnstileToken))) {
      throw new ApiError(403, "TURNSTILE_REQUIRED", "Confirm you're a person to keep trying", { turnstile: true });
    }
  }

  const code = normalizeShortCode(body.code);
  const linkId = code ? await findLiveCode(env, code) : null;
  if (!linkId) {
    await recordFailure(networkKey, subjects);
    throw codeUnavailable();
  }

  const issued = await getDb().transaction().execute(async (trx) => {
    const created = await issueSession(trx, request, env);
    await grantAccess(trx, created.hash, linkId, "code");
    return created;
  });
  return { linkId, setCookie: issued.setCookie };
}
