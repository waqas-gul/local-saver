import "server-only";
import { sql, type Transaction } from "kysely";
import type { z } from "zod";
import type { unlockBody, ViewerContent } from "@/lib/shared/api/schemas";
import { IntegrationNotConfiguredError } from "../config/integrations";
import { getDb } from "../db/client";
import type { DB } from "../db/types.gen";
import type { Env } from "../env";
import { assertRemoteLinksEnabled } from "../flags";
import { alreadyDownloaded, ApiError, linkExpired, linkUnavailable, withHeaders } from "../http/errors";
import { log } from "../log";
import { requesterKey } from "../network/requester";
import { enforceRateLimit } from "../ratelimit/limits";
import { hashSessionToken, readLinkSessionToken } from "./cookies";
import { accessFor, grantAccess } from "./grants";
import { proveLinkPassword } from "./password";
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
 * A claimed burn share (Phase 3) unlocks only for its claimant's session, so a reload of the
 * share page keeps working during the grace; anyone else learns it was downloaded (410).
 *
 * A suspended creator's links grant no new access (Phase 4, C4-15, D4-4 recommended): 410 once the
 * secret is proven, as for a link that was turned off. Grants already issued run out (≤ 12 h).
 *
 * A password link (Phase 4, P4-16): the grant is made unverified and the answer is 409 PASSWORD_REQUIRED,
 * unless the body carries the right password (proved with every limit of the password route). The session
 * cookie comes with every answer after the secret is proven, refusals included, so the page can go on to
 * the password route.
 *
 * A room link (Phase 4, P4-19): its state is the link's and the room's: 410 once the link is revoked or has expired,
 * or the room was deleted, and when its creator (the room's owner) is suspended. Only the link row is locked.
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
  body: z.infer<typeof unlockBody>,
): Promise<{ content: ViewerContent; setCookie: string }> {
  const { secret } = body;
  await assertRemoteLinksEnabled(env);
  if (env.linkPeppers.length === 0) throw new IntegrationNotConfiguredError("Share links", ["LINK_PEPPER"]);
  await enforceUnlockLimits(request, env, linkId);

  const row = isLinkId(linkId)
    ? await getDb()
        .selectFrom("app.share_links")
        .select(["id", "secret_hmac", "pepper_version", "target_type"])
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

  const issueGrant = async (trx: Transaction<DB>, hasPassword: boolean) => {
    const issued = await issueSession(trx, request, env);
    await grantAccess(trx, issued.hash, row.id, "secret");
    await trx
      .updateTable("app.share_links")
      .set({ unlock_count: sql`unlock_count + 1`, last_unlocked_at: sql`now()` })
      .where("id", "=", row.id)
      .execute();
    return { ...issued, hasPassword };
  };

  const session = await getDb().transaction().execute(async (trx) => {
    if (row.target_type === "room") {
      // The secret is proven: the state may be revealed now. The room row isn't locked (posting holds it FOR KEY SHARE).
      const room = await trx
        .selectFrom("app.share_links as l")
        .innerJoin("app.rooms as r", "r.id", "l.room_id")
        .select([
          sql<boolean>`l.revoked_at is null and l.expires_at > now() and r.deleted_at is null`.as("link_live"),
          sql<boolean>`exists (select 1 from app.user_flags uf where uf.user_id = l.created_by_user_id and uf.suspended_at is not null)`.as(
            "creator_suspended",
          ),
          sql<boolean>`l.password_hash is not null`.as("has_password"),
        ])
        .where("l.id", "=", row.id)
        .forUpdate("l")
        .executeTakeFirstOrThrow();
      if (room.creator_suspended || !room.link_live) throw linkExpired();
      return issueGrant(trx, room.has_password);
    }
    // The secret is proven: the state may be revealed now.
    const state = await trx
      .selectFrom("app.share_links as l")
      .innerJoin("app.shares as s", "s.id", "l.share_id")
      .select([
        sql<boolean>`l.revoked_at is null and l.expires_at > now() and s.expires_at > now()`.as("link_live"),
        sql<boolean>`s.expires_at > now()`.as("share_live"),
        sql<boolean>`coalesce(s.claim_grace_until > now(), false)`.as("in_grace"),
        sql<boolean>`exists (select 1 from app.user_flags uf where uf.user_id = s.created_by_user_id and uf.suspended_at is not null)`.as(
          "creator_suspended",
        ),
        "s.status",
        "s.burn_after_download",
        "s.claimed_link_session_hash",
        sql<boolean>`l.password_hash is not null`.as("has_password"),
      ])
      .where("l.id", "=", row.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (state.creator_suspended) throw linkExpired();
    if (state.burn_after_download && (state.status === "claimed" || state.status === "consumed") && state.share_live) {
      const token = readLinkSessionToken(request, env);
      const isClaimant = token !== null && state.claimed_link_session_hash?.equals(hashSessionToken(token)) === true;
      if (!(state.status === "claimed" && isClaimant && state.in_grace)) throw alreadyDownloaded(isClaimant);
      if (!state.link_live) throw linkExpired();
    } else if (!state.link_live || state.status !== "active") {
      throw linkExpired();
    }
    return issueGrant(trx, state.has_password);
  });

  try {
    if (body.password !== undefined) {
      const grant = { linkId: row.id, sessionHash: session.hash, hasPassword: session.hasPassword, current: true };
      await proveLinkPassword(request, env, grant, body.password, body.turnstileToken);
    }
    return { content: await loadViewerContent(await accessFor(session.hash, row.id)), setCookie: session.setCookie };
  } catch (error) {
    if (error instanceof ApiError) throw withHeaders(error, { "Set-Cookie": session.setCookie });
    throw error;
  }
}
