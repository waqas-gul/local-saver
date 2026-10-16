import "server-only";
import { sql } from "kysely";
import type { ViewerContent } from "@/lib/shared/api/schemas";
import { IntegrationNotConfiguredError } from "../config/integrations";
import { getDb } from "../db/client";
import type { Env } from "../env";
import { assertRemoteLinksEnabled } from "../flags";
import { ApiError, linkExpired, linkUnavailable } from "../http/errors";
import { log } from "../log";
import { requesterKey } from "../network/requester";
import { enforceRateLimit } from "../ratelimit/limits";
import { accessFor, grantAccess } from "./grants";
import { isLinkId, verifyLinkSecret } from "./secrets";
import { issueSession } from "./sessions";
import { loadViewerContent } from "./viewer";

/**
 * POST /links/{linkId}/unlock { secret } (03 §4.2, DEC-013):
 *
 * 1. Rate limits per link and per network key.
 * 2. The secret's HMAC is computed and compared timing-safely even when the link doesn't exist;
 *    an unknown link and a wrong secret get the same 404 LINK_UNAVAILABLE (T-030).
 * 3. Only once the secret is proven is the link's state revealed: 410 LINK_EXPIRED if it was
 *    revoked, has expired or its share has ended.
 * 4. A viewer session (httpOnly cookie) and a grant of at most 12 hours.
 *
 * The secret is never logged, stored or returned. A POST with a JSON body from this origin is the
 * only way in, so link-preview bots that only GET the page change nothing (T-033).
 */

async function enforceUnlockLimits(request: Request, env: Env, linkId: string): Promise<void> {
  try {
    await enforceRateLimit("unlockLink", isLinkId(linkId) ? linkId : "malformed");
    await enforceRateLimit("unlockNetwork", requesterKey(request, env));
  } catch (error) {
    // Aggregated: one warning per refused attempt, never the secret (03 §14, link.unlock_failed).
    if (error instanceof ApiError && error.status === 429) log.warn("link.unlock_rate_limited", { linkId: isLinkId(linkId) ? linkId : null });
    throw error;
  }
}

export async function unlockLink(
  request: Request,
  env: Env,
  linkId: string,
  secret: string,
): Promise<{ content: ViewerContent; setCookie: string }> {
  await assertRemoteLinksEnabled(env);
  if (env.linkPeppers.length === 0) throw new IntegrationNotConfiguredError("Share links", ["LINK_PEPPER"]);
  await enforceUnlockLimits(request, env, linkId);

  const row = isLinkId(linkId)
    ? await getDb()
        .selectFrom("app.share_links")
        .select(["id", "secret_hmac", "pepper_version"])
        .where("id", "=", linkId)
        .executeTakeFirst()
    : undefined;
  const proven = verifyLinkSecret(
    env.linkPeppers,
    row ? { secretHmac: row.secret_hmac, pepperVersion: row.pepper_version } : null,
    linkId,
    secret,
  );
  if (!proven || !row) {
    log.info("link.unlock_failed", { linkId: isLinkId(linkId) ? linkId : null });
    throw linkUnavailable();
  }

  const session = await getDb().transaction().execute(async (trx) => {
    // The secret is proven: the state may be revealed now.
    const state = await trx
      .selectFrom("app.share_links as l")
      .innerJoin("app.shares as s", "s.id", "l.share_id")
      .select(sql<boolean>`l.revoked_at is null and l.expires_at > now() and s.status = 'active' and s.expires_at > now()`.as("live"))
      .where("l.id", "=", row.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (!state.live) throw linkExpired();
    const issued = await issueSession(trx, request, env);
    await grantAccess(trx, issued.hash, row.id, "secret");
    await trx
      .updateTable("app.share_links")
      .set({ unlock_count: sql`unlock_count + 1`, last_unlocked_at: sql`now()` })
      .where("id", "=", row.id)
      .execute();
    return issued;
  });

  return { content: await loadViewerContent(await accessFor(session.hash, row.id)), setCookie: session.setCookie };
}
