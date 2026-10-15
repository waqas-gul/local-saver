import "server-only";

/**
 * Security headers and Content Security Policy (03 §11).
 * Applied by proxy.ts to every response. Documents get a per-request nonce, which
 * requires dynamic rendering (app/layout.tsx awaits connection()).
 */

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** JSON API responses never render anything. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

export function generateNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64");
}

export type CspOptions = {
  nonce: string;
  /** next dev: React needs eval for debugging, and dev tooling injects inline styles. */
  dev: boolean;
  /** Only HTTPS deployments may upgrade subresource requests. */
  https: boolean;
  supabaseUrl?: string;
  /** Exact R2 S3 endpoint used for presigned URLs (never a wildcard). */
  r2Endpoint?: string;
  turnstile?: boolean;
};

function originOf(url: string): string {
  return new URL(url).origin;
}

export function buildDocumentCsp(options: CspOptions): string {
  const nonce = `'nonce-${options.nonce}'`;
  const script = ["'self'", nonce, "'strict-dynamic'"];
  const style = ["'self'", options.dev ? "'unsafe-inline'" : nonce];
  const img = ["'self'", "blob:", "data:"];
  const connect = ["'self'"];

  if (options.dev) script.push("'unsafe-eval'");
  if (options.turnstile) script.push(TURNSTILE_ORIGIN);
  if (options.supabaseUrl) {
    const origin = originOf(options.supabaseUrl);
    connect.push(origin, origin.replace(/^https:/, "wss:").replace(/^http:/, "ws:"));
  }
  if (options.r2Endpoint) {
    const origin = originOf(options.r2Endpoint);
    img.push(origin);
    connect.push(origin);
  }

  const directives: string[] = [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    `style-src ${style.join(" ")}`,
    // Radix UI (shadcn/ui) server-renders style="" attributes, which nonces cannot cover.
    // Attributes cannot run script; <style> elements still need the nonce (03 §11, F-7).
    "style-src-attr 'unsafe-inline'",
    `img-src ${img.join(" ")}`,
    `connect-src ${connect.join(" ")}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (options.turnstile) directives.push(`frame-src ${TURNSTILE_ORIGIN}`);
  if (options.https) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

const NO_REFERRER_ROUTES = /^\/(s|j|c)(\/|$)/;
const NOINDEX_ROUTES = /^\/(s|j|c|rooms|api)(\/|$)/;

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/** Files that are never HTML: build assets and the app's metadata files. */
const PUBLIC_FILES = new Set(["/favicon.ico", "/robots.txt"]);

/**
 * Static assets that need no document CSP. Anything else keeps it, even a path that looks
 * like a file, because it may render a page (for example the 404 page).
 */
export function isAssetPath(pathname: string): boolean {
  return pathname.startsWith("/_next/") || PUBLIC_FILES.has(pathname);
}

export function securityHeaders(pathname: string, options: { https: boolean }): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": NO_REFERRER_ROUTES.test(pathname) ? "no-referrer" : "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  if (options.https) headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains";
  if (NOINDEX_ROUTES.test(pathname)) headers["X-Robots-Tag"] = "noindex, nofollow";
  if (isApiPath(pathname)) headers["Cache-Control"] = "no-store";
  return headers;
}
