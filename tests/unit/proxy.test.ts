import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/server/env";
import { proxy } from "@/proxy";

const SECRET = "origin-secret-for-tests-0000000000000001";

function request(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(new URL(path, "http://localhost:3000"), { headers });
}

/** Request headers forwarded by NextResponse.next({ request: { headers } }). */
function forwarded(response: Response, name: string) {
  return response.headers.get(`x-middleware-request-${name}`);
}

describe("proxy (open mode: TRUST_PROXY_MODE=none)", () => {
  beforeEach(() => resetEnvCache());
  afterEach(() => resetEnvCache());

  it("adds a nonce-based CSP, security headers and a request ID to documents", () => {
    const response = proxy(request("/"));
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonce = forwarded(response, "x-nonce");
    expect(nonce).toBeTruthy();
    expect(csp).toContain(`'nonce-${nonce}'`);
    // Next.js reads the CSP from the forwarded request headers to apply the nonce.
    expect(forwarded(response, "content-security-policy")).toBe(csp);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-request-id")).toBe(forwarded(response, "x-request-id"));
  });

  it("uses a fresh nonce per request", () => {
    const a = forwarded(proxy(request("/")), "x-nonce");
    const b = forwarded(proxy(request("/")), "x-nonce");
    expect(a).not.toBe(b);
  });

  it("gives API responses the locked-down CSP and no-store", () => {
    const response = proxy(request("/api/v1/health"));
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(forwarded(response, "x-nonce")).toBeNull();
  });

  it("does not generate a CSP for static assets", () => {
    const response = proxy(request("/_next/static/chunks/main.js"));
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("strips the test client IP header when the override is not allowed", () => {
    const response = proxy(request("/api/v1/health", { "x-test-client-ip": "1.1.1.1" }));
    const overridden = response.headers.get("x-middleware-override-headers") ?? "";
    expect(overridden.split(",")).not.toContain("x-test-client-ip");
    expect(forwarded(response, "x-test-client-ip")).toBeNull();
  });
});

describe("proxy (origin lock: TRUST_PROXY_MODE=cloudflare)", () => {
  beforeEach(() => {
    vi.stubEnv("TRUST_PROXY_MODE", "cloudflare");
    vi.stubEnv("ORIGIN_SHARED_SECRET", SECRET);
    resetEnvCache();
  });
  afterEach(() => resetEnvCache());

  it("rejects requests without the origin secret (T-008)", async () => {
    const response = proxy(request("/", { "cf-connecting-ip": "1.1.1.1" }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects a wrong secret, including on static assets and API routes", () => {
    for (const path of ["/", "/api/v1/health", "/_next/static/x.js"]) {
      expect(proxy(request(path, { "x-origin-auth": "forged" })).status).toBe(403);
    }
  });

  it("lets requests with the right secret through", () => {
    const response = proxy(request("/", { "x-origin-auth": SECRET }));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
