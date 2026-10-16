import "server-only";
import { createHash } from "node:crypto";
import type { Env } from "../env";

/**
 * The link-viewer session cookie (03 §4.2). 256 random bits, httpOnly, SameSite=Lax, Path=/,
 * never a Domain. Over HTTPS (every deployment) it is __Host-link_session with Secure, so no
 * subdomain or plain-HTTP page can set or read it. Plain-HTTP origins, which only local
 * development and tests use, can't hold __Host- or Secure cookies, so there it is plain
 * link_session (DV2-3). Only the SHA-256 of the value is stored.
 */

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function linkSessionCookieName(env: Env): string {
  return env.isHttps ? "__Host-link_session" : "link_session";
}

export function linkSessionCookie(env: Env, token: string, maxAgeSeconds: number): string {
  const parts = [`${linkSessionCookieName(env)}=${token}`, "Path=/", `Max-Age=${maxAgeSeconds}`, "HttpOnly"];
  if (env.isHttps) parts.push("Secure");
  parts.push("SameSite=Lax");
  return parts.join("; ");
}

/** This environment's session token, if the request carries a well-formed one. */
export function readLinkSessionToken(request: Request, env: Env): string | null {
  const name = linkSessionCookieName(env);
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    return TOKEN.test(value) ? value : null;
  }
  return null;
}

export function hashSessionToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}
