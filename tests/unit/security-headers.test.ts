import { describe, expect, it } from "vitest";
import { API_CSP, buildDocumentCsp, generateNonce, isAssetPath, securityHeaders } from "@/lib/server/security/headers";

function directives(csp: string) {
  return Object.fromEntries(
    csp
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...values] = d.split(/\s+/);
        return [name, values];
      }),
  ) as Record<string, string[]>;
}

describe("buildDocumentCsp", () => {
  const base = { nonce: "abc123", dev: false, https: true };

  it("matches the policy in 03 §11 for production", () => {
    const d = directives(buildDocumentCsp(base));
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["script-src"]).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
    expect(d["style-src"]).toEqual(["'self'", "'nonce-abc123'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'none'"]);
    expect(d["form-action"]).toEqual(["'self'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["upgrade-insecure-requests"]).toEqual([]);
    expect(buildDocumentCsp(base)).not.toMatch(/unsafe-eval|\*/);
  });

  it("allows inline style attributes only, never inline style or script elements (F-7)", () => {
    const d = directives(buildDocumentCsp(base));
    expect(d["style-src-attr"]).toEqual(["'unsafe-inline'"]);
    const { "style-src-attr": _attr, ...rest } = d;
    expect(Object.values(rest).flat()).not.toContain("'unsafe-inline'");
  });

  it("adds unsafe-eval and inline styles only in development", () => {
    const d = directives(buildDocumentCsp({ ...base, dev: true }));
    expect(d["script-src"]).toContain("'unsafe-eval'");
    expect(d["style-src"]).toContain("'unsafe-inline'");
  });

  it("omits upgrade-insecure-requests over plain HTTP", () => {
    expect(directives(buildDocumentCsp({ ...base, https: false }))["upgrade-insecure-requests"]).toBeUndefined();
  });

  it("adds exact Supabase, R2 and Turnstile hosts only when configured", () => {
    const d = directives(
      buildDocumentCsp({
        ...base,
        supabaseUrl: "https://abcd.supabase.co",
        r2Endpoint: "https://acc123.r2.cloudflarestorage.com",
        turnstile: true,
      }),
    );
    expect(d["connect-src"]).toEqual([
      "'self'",
      "https://abcd.supabase.co",
      "wss://abcd.supabase.co",
      "https://acc123.r2.cloudflarestorage.com",
    ]);
    expect(d["img-src"]).toEqual(["'self'", "blob:", "data:", "https://acc123.r2.cloudflarestorage.com"]);
    expect(d["script-src"]).toContain("https://challenges.cloudflare.com");
    expect(d["frame-src"]).toEqual(["https://challenges.cloudflare.com"]);
    expect(directives(buildDocumentCsp(base))["frame-src"]).toBeUndefined();
  });
});

describe("isAssetPath", () => {
  it("skips the document CSP only for build assets and known public files", () => {
    expect(isAssetPath("/_next/static/chunks/a.js")).toBe(true);
    expect(isAssetPath("/favicon.ico")).toBe(true);
    expect(isAssetPath("/robots.txt")).toBe(true);
  });

  it("keeps the CSP on any other path, even one that looks like a file (it may render a page)", () => {
    expect(isAssetPath("/uploads.x")).toBe(false);
    expect(isAssetPath("/anything/evil.html")).toBe(false);
    expect(isAssetPath("/")).toBe(false);
  });
});

describe("generateNonce", () => {
  it("returns a fresh base64 value each time", () => {
    const a = generateNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22,}={0,2}$/);
    expect(generateNonce()).not.toBe(a);
  });
});

describe("securityHeaders", () => {
  it("sets the baseline headers everywhere", () => {
    const h = securityHeaders("/", { https: false });
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(h["Cross-Origin-Resource-Policy"]).toBe("same-origin");
    expect(h["Permissions-Policy"]).toContain("camera=()");
    expect(h["Strict-Transport-Security"]).toBeUndefined();
    expect(h["X-Robots-Tag"]).toBeUndefined();
  });

  it("adds HSTS only over HTTPS", () => {
    expect(securityHeaders("/", { https: true })["Strict-Transport-Security"]).toBe(
      "max-age=63072000; includeSubDomains",
    );
  });

  it.each(["/s/abc", "/s", "/j/xyz", "/c"])("uses no-referrer and noindex on %s", (path) => {
    const h = securityHeaders(path, { https: false });
    expect(h["Referrer-Policy"]).toBe("no-referrer");
    expect(h["X-Robots-Tag"]).toBe("noindex, nofollow");
  });

  it("does not treat look-alike paths as share routes", () => {
    expect(securityHeaders("/settings", { https: false })["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("marks API responses no-store and noindex, with a locked-down CSP", () => {
    const h = securityHeaders("/api/v1/health", { https: false });
    expect(h["Cache-Control"]).toBe("no-store");
    expect(h["X-Robots-Tag"]).toBe("noindex, nofollow");
    expect(API_CSP).toBe("default-src 'none'; frame-ancestors 'none'");
  });
});
