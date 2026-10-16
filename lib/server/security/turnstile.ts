import "server-only";
import type { Env } from "../env";
import { log } from "../log";

/**
 * Server-side Cloudflare Turnstile verification (DV2-6): short-code escalation after repeated
 * failures and abuse reports (03 §10). Fails closed: anything but a clear success, for this
 * deployment's hostname, is a refusal. The client address is not sent to Cloudflare.
 */

const MAX_TOKEN_LENGTH = 2048;
const TIMEOUT_MS = 5000;

export function turnstileConfigured(env: Env): boolean {
  return env.turnstile !== null;
}

export async function verifyTurnstile(env: Env, token: string | undefined): Promise<boolean> {
  if (!env.turnstile || !token || token.length > MAX_TOKEN_LENGTH) return false;
  try {
    const response = await fetch(env.turnstile.verifyUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.turnstile.secretKey, response: token }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) {
      log.warn("turnstile.verify_http_error", { status: response.status });
      return false;
    }
    const result = (await response.json()) as { success?: unknown; hostname?: unknown };
    if (result.success !== true) return false;
    // A token solved on another site can't be replayed here.
    if (typeof result.hostname === "string" && result.hostname !== new URL(env.appOrigin).hostname) return false;
    return true;
  } catch (error) {
    log.warn("turnstile.verify_failed", { err: error });
    return false;
  }
}
