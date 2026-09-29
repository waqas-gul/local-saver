import { describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/server/env";
import { resolveClientIp } from "@/lib/server/network/client-ip";
import { isOriginLockEnabled, verifyOriginAuth } from "@/lib/server/security/origin-lock";

const SECRET = "origin-secret-for-tests-0000000000000001";
const PREVIOUS = "origin-secret-for-tests-0000000000000002";

const cloudflareEnv = parseEnv({
  TRUST_PROXY_MODE: "cloudflare",
  ORIGIN_SHARED_SECRET: SECRET,
  ORIGIN_SHARED_SECRET_PREVIOUS: PREVIOUS,
});
const localEnv = parseEnv({});
const testEnv = parseEnv({ NODE_ENV: "test", APP_ENV: "test", ALLOW_TEST_CLIENT_IP: "1" });

function headers(init: Record<string, string>) {
  return new Headers(init);
}

describe("origin lock", () => {
  it("is enabled exactly when Cloudflare is trusted", () => {
    expect(isOriginLockEnabled(cloudflareEnv)).toBe(true);
    expect(isOriginLockEnabled(localEnv)).toBe(false);
  });

  it("accepts the current and previous secrets only", () => {
    expect(verifyOriginAuth(SECRET, cloudflareEnv)).toBe(true);
    expect(verifyOriginAuth(PREVIOUS, cloudflareEnv)).toBe(true);
    expect(verifyOriginAuth("wrong", cloudflareEnv)).toBe(false);
    expect(verifyOriginAuth(null, cloudflareEnv)).toBe(false);
    expect(verifyOriginAuth("", cloudflareEnv)).toBe(false);
  });
});

describe("resolveClientIp (T-008 unit part)", () => {
  it("trusts CF-Connecting-IP only with a valid origin secret", () => {
    const result = resolveClientIp(headers({ "x-origin-auth": SECRET, "cf-connecting-ip": "1.1.1.1" }), cloudflareEnv);
    expect(result).toMatchObject({ status: "ok", source: "cloudflare", ip: { networkPrefix: "1.1.1.1" } });
  });

  it("ignores CF-Connecting-IP when the origin secret is missing or wrong", () => {
    expect(resolveClientIp(headers({ "cf-connecting-ip": "1.1.1.1" }), cloudflareEnv)).toEqual({
      status: "unavailable",
      reason: "origin_unverified",
    });
    expect(
      resolveClientIp(headers({ "x-origin-auth": "forged", "cf-connecting-ip": "1.1.1.1" }), cloudflareEnv),
    ).toEqual({ status: "unavailable", reason: "origin_unverified" });
  });

  it("never uses X-Forwarded-For or X-Real-IP", () => {
    const result = resolveClientIp(
      headers({ "x-origin-auth": SECRET, "x-forwarded-for": "1.1.1.1", "x-real-ip": "1.1.1.1" }),
      cloudflareEnv,
    );
    expect(result).toEqual({ status: "unavailable", reason: "missing_header" });
    expect(resolveClientIp(headers({ "x-forwarded-for": "1.1.1.1" }), localEnv)).toEqual({
      status: "unavailable",
      reason: "no_trusted_proxy",
    });
  });

  it("reports non-global addresses from the proxy as unavailable (proxy misconfiguration)", () => {
    const result = resolveClientIp(headers({ "x-origin-auth": SECRET, "cf-connecting-ip": "10.0.0.1" }), cloudflareEnv);
    expect(result).toEqual({ status: "unavailable", reason: "non_global" });
  });

  it("rejects documentation-range addresses from the real proxy", () => {
    const result = resolveClientIp(
      headers({ "x-origin-auth": SECRET, "cf-connecting-ip": "203.0.113.10" }),
      cloudflareEnv,
    );
    expect(result).toEqual({ status: "unavailable", reason: "non_global" });
  });

  it("honours X-Test-Client-IP only when the test override is allowed", () => {
    expect(resolveClientIp(headers({ "x-test-client-ip": "203.0.113.10" }), testEnv)).toMatchObject({
      status: "ok",
      source: "test-override",
      ip: { networkPrefix: "203.0.113.10" },
    });
    expect(resolveClientIp(headers({ "x-test-client-ip": "1.1.1.1" }), localEnv)).toEqual({
      status: "unavailable",
      reason: "no_trusted_proxy",
    });
    expect(
      resolveClientIp(headers({ "x-origin-auth": SECRET, "x-test-client-ip": "1.1.1.1" }), cloudflareEnv),
    ).toEqual({ status: "unavailable", reason: "missing_header" });
  });

  it("still rejects private addresses through the test override", () => {
    expect(resolveClientIp(headers({ "x-test-client-ip": "192.168.1.5" }), testEnv)).toEqual({
      status: "unavailable",
      reason: "non_global",
    });
  });
});
