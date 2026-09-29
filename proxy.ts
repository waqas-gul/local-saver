import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@/lib/server/env";
import { log } from "@/lib/server/log";
import { TEST_CLIENT_IP_HEADER } from "@/lib/server/network/client-ip";
import {
  API_CSP,
  buildDocumentCsp,
  generateNonce,
  isApiPath,
  isAssetPath,
  securityHeaders,
} from "@/lib/server/security/headers";
import { newRequestId } from "@/lib/server/security/ids";
import { ORIGIN_AUTH_HEADER, isOriginLockEnabled, verifyOriginAuth } from "@/lib/server/security/origin-lock";

/**
 * Runs before every request (no matcher on purpose, so the origin lock covers every path).
 *
 * 1. Origin lock (DEC-004): with TRUST_PROXY_MODE=cloudflare, anything that did not come
 *    through Cloudflare's Transform Rule is rejected. The client IP decides local
 *    visibility (DEC-031), so this is a security boundary.
 * 2. Request ID for logs and error bodies.
 * 3. CSP with a per-request nonce for documents; a locked-down CSP for the API.
 * 4. Baseline security headers (03 §11).
 *
 * Authorization never happens here (02 §3.1).
 */
export function proxy(request: NextRequest) {
  const env = getEnv();
  const { pathname } = request.nextUrl;
  const requestId = newRequestId();
  const baseHeaders = securityHeaders(pathname, { https: env.isHttps });

  if (isOriginLockEnabled(env) && !verifyOriginAuth(request.headers.get(ORIGIN_AUTH_HEADER), env)) {
    log.warn("origin_lock.rejected", { requestId, method: request.method, path: pathname });
    const response = NextResponse.json(
      { error: { code: "FORBIDDEN", message: "Forbidden", requestId } },
      { status: 403 },
    );
    for (const [name, value] of Object.entries(baseHeaders)) response.headers.set(name, value);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Request-Id", requestId);
    return response;
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);
  if (!env.testClientIpAllowed) requestHeaders.delete(TEST_CLIENT_IP_HEADER);

  let csp: string | undefined;
  if (isApiPath(pathname)) {
    csp = API_CSP;
  } else if (!isAssetPath(pathname)) {
    const nonce = generateNonce();
    csp = buildDocumentCsp({
      nonce,
      dev: env.NODE_ENV === "development",
      https: env.isHttps,
      supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
      r2Endpoint: env.R2_S3_ENDPOINT,
      turnstile: Boolean(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY),
    });
    // Next.js reads the nonce from the request's CSP header while rendering.
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("content-security-policy", csp);
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [name, value] of Object.entries(baseHeaders)) response.headers.set(name, value);
  if (csp) response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Request-Id", requestId);
  return response;
}
