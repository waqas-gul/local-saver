import "server-only";
import { sql, type Transaction } from "kysely";
import { getDb } from "../db/client";
import type { DB } from "../db/types.gen";
import type { Env } from "../env";
import { randomToken } from "../security/crypto";
import { hashSessionToken, linkSessionCookie, readLinkSessionToken } from "./cookies";

/**
 * Link-viewer sessions (03 §4.2, 04 §7.5). A viewer is a browser, not a user: no Supabase
 * account (RISK-006). The session lasts 12 hours from its last unlock or code; what it may open
 * is decided by its grants (grants.ts).
 *
 * Session fixation: a token from the browser is reused only if its hash is already stored for a
 * live session. Any other value is ignored and a fresh random token is issued, so a session ID
 * can never be chosen by the client. The cookie is __Host- and httpOnly (cookies.ts), so another
 * site or subdomain can't plant one either.
 */

export const LINK_SESSION_SECONDS = 12 * 60 * 60;

export type IssuedSession = { hash: Buffer; setCookie: string };

export async function issueSession(trx: Transaction<DB>, request: Request, env: Env): Promise<IssuedSession> {
  const presented = readLinkSessionToken(request, env);
  if (presented) {
    const hash = hashSessionToken(presented);
    const live = await trx
      .updateTable("app.link_sessions")
      .set({ last_seen_at: sql`now()`, expires_at: sql`now() + make_interval(secs => ${LINK_SESSION_SECONDS})` })
      .where("id_hash", "=", hash)
      .where(sql<boolean>`expires_at > now()`)
      .returning("id_hash")
      .executeTakeFirst();
    if (live) return { hash, setCookie: linkSessionCookie(env, presented, LINK_SESSION_SECONDS) };
  }
  const token = randomToken(32);
  const hash = hashSessionToken(token);
  await trx
    .insertInto("app.link_sessions")
    .values({ id_hash: hash, expires_at: sql`now() + make_interval(secs => ${LINK_SESSION_SECONDS})` })
    .execute();
  return { hash, setCookie: linkSessionCookie(env, token, LINK_SESSION_SECONDS) };
}

/** The hash of this browser's live session, or null. Read-only. */
export async function currentSessionHash(request: Request, env: Env): Promise<Buffer | null> {
  const token = readLinkSessionToken(request, env);
  if (!token) return null;
  const hash = hashSessionToken(token);
  const row = await getDb()
    .selectFrom("app.link_sessions")
    .select("id_hash")
    .where("id_hash", "=", hash)
    .where(sql<boolean>`expires_at > now()`)
    .executeTakeFirst();
  return row ? hash : null;
}
