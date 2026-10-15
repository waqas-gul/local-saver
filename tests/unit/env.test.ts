import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvError, getEnv, parseEnv, resetEnvCache } from "@/lib/server/env";

const SECRET = "s3cr3t-value-that-is-long-enough-000001";
const SECRET_PREVIOUS = "s3cr3t-value-that-is-long-enough-000002";

const NETWORK_SECRET = "network-key-secret-that-is-long-enough-0001";
const NETWORK_SECRET_PREVIOUS = "network-key-secret-that-is-long-enough-0002";

// Phase 1 services every deployed environment needs.
const phase1Services = {
  DATABASE_URL: "postgresql://app_server:pw@db.internal:6543/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "https://abcdefgh.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_abcdefgh",
  SUPABASE_SECRET_KEY: "sb_secret_abcdefghijklmnopqrstuvwxyz0123",
  R2_ACCOUNT_ID: "acc",
  R2_BUCKET: "files-prod",
  R2_S3_ENDPOINT: "https://acc.r2.cloudflarestorage.com",
  R2_ACCESS_KEY_ID: "key-id",
  R2_SECRET_ACCESS_KEY: "r2-secret-value-that-is-long-enough-0001",
  NETWORK_KEY_SECRET_CURRENT: NETWORK_SECRET,
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "0x4AAAAAAAsitekey",
};

const deployed = {
  NODE_ENV: "production",
  APP_ENV: "production",
  TRUST_PROXY_MODE: "cloudflare",
  ORIGIN_SHARED_SECRET: SECRET,
  NEXT_PUBLIC_APP_ORIGIN: "https://app.example.com",
  APP_ALLOWED_ORIGINS: "https://app.example.com",
  ...phase1Services,
};

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvError) return error.issues;
    throw error;
  }
  throw new Error("expected EnvError");
}

describe("parseEnv", () => {
  afterEach(() => resetEnvCache());

  it("applies safe local defaults", () => {
    const env = parseEnv({});
    expect(env.APP_ENV).toBe("local");
    expect(env.TRUST_PROXY_MODE).toBe("none");
    expect(env.appOrigin).toBe("http://localhost:3000");
    expect(env.allowedOrigins).toEqual(["http://localhost:3000"]);
    expect(env.isDeployed).toBe(false);
    expect(env.testClientIpAllowed).toBe(false);
  });

  it("treats empty values (as copied from .env.example) as unset", () => {
    const env = parseEnv({
      APP_ENV: "",
      TRUST_PROXY_MODE: "",
      LOG_LEVEL: " ",
      ALLOW_TEST_CLIENT_IP: "",
      NEXT_PUBLIC_APP_ORIGIN: "",
      R2_BUCKET: "",
    });
    expect(env.APP_ENV).toBe("local");
    expect(env.TRUST_PROXY_MODE).toBe("none");
    expect(env.appOrigin).toBe("http://localhost:3000");
  });

  it("accepts a complete production configuration", () => {
    const env = parseEnv({ ...deployed, ORIGIN_SHARED_SECRET_PREVIOUS: SECRET_PREVIOUS });
    expect(env.isDeployed).toBe(true);
    expect(env.isHttps).toBe(true);
    expect(env.originSecrets).toEqual([SECRET, SECRET_PREVIOUS]);
  });

  it("refuses ALLOW_TEST_CLIENT_IP whenever NODE_ENV is production (boot refusal)", () => {
    const issues = issuesOf(() =>
      parseEnv({ NODE_ENV: "production", APP_ENV: "local", ALLOW_TEST_CLIENT_IP: "1" }),
    );
    expect(issues.join("\n")).toMatch(/ALLOW_TEST_CLIENT_IP/);
  });

  it("refuses ALLOW_TEST_CLIENT_IP in staging and production", () => {
    const issues = issuesOf(() => parseEnv({ ...deployed, ALLOW_TEST_CLIENT_IP: "1" }));
    expect(issues.join("\n")).toMatch(/ALLOW_TEST_CLIENT_IP/);
  });

  it("allows the test client IP override only in local/test with a non-production NODE_ENV", () => {
    expect(parseEnv({ NODE_ENV: "test", APP_ENV: "test", ALLOW_TEST_CLIENT_IP: "1" }).testClientIpAllowed).toBe(
      true,
    );
    expect(parseEnv({ NODE_ENV: "development", APP_ENV: "local" }).testClientIpAllowed).toBe(false);
  });

  it("requires the origin lock settings in staging and production", () => {
    const issues = issuesOf(() =>
      parseEnv({
        NODE_ENV: "production",
        APP_ENV: "staging",
        NEXT_PUBLIC_APP_ORIGIN: "https://staging.example.com",
        APP_ALLOWED_ORIGINS: "https://staging.example.com",
      }),
    );
    const text = issues.join("\n");
    expect(text).toMatch(/TRUST_PROXY_MODE/);
    expect(text).toMatch(/ORIGIN_SHARED_SECRET/);
  });

  it("requires NODE_ENV=production for deployed environments", () => {
    const issues = issuesOf(() => parseEnv({ ...deployed, NODE_ENV: "development" }));
    expect(issues.join("\n")).toMatch(/NODE_ENV/);
  });

  it("requires HTTPS origins when deployed", () => {
    const issues = issuesOf(() =>
      parseEnv({ ...deployed, APP_ALLOWED_ORIGINS: "http://app.example.com", NEXT_PUBLIC_APP_ORIGIN: "http://app.example.com" }),
    );
    expect(issues.join("\n")).toMatch(/https/i);
  });

  it("requires a secret whenever Cloudflare is trusted", () => {
    const issues = issuesOf(() => parseEnv({ TRUST_PROXY_MODE: "cloudflare" }));
    expect(issues.join("\n")).toMatch(/ORIGIN_SHARED_SECRET/);
  });

  it("rejects short secrets", () => {
    const issues = issuesOf(() => parseEnv({ TRUST_PROXY_MODE: "cloudflare", ORIGIN_SHARED_SECRET: "short" }));
    expect(issues.join("\n")).toMatch(/ORIGIN_SHARED_SECRET/);
  });

  it("rejects placeholder secrets when deployed", () => {
    const issues = issuesOf(() =>
      parseEnv({ ...deployed, ORIGIN_SHARED_SECRET: "changeme-changeme-changeme-changeme-00" }),
    );
    expect(issues.join("\n")).toMatch(/placeholder/i);
  });

  it("rejects malformed origin lists", () => {
    const issues = issuesOf(() => parseEnv({ APP_ALLOWED_ORIGINS: "http://localhost:3000/path,not a url" }));
    expect(issues.join("\n")).toMatch(/APP_ALLOWED_ORIGINS/);
  });

  it("requires integration variables as complete groups", () => {
    const issues = issuesOf(() => parseEnv({ R2_BUCKET: "files-staging" }));
    const text = issues.join("\n");
    expect(text).toMatch(/R2_ACCOUNT_ID/);
    expect(text).toMatch(/R2_SECRET_ACCESS_KEY/);
  });

  it("requires the Phase 1 services, the network key secret and Turnstile when deployed", () => {
    const withoutServices = Object.fromEntries(
      Object.entries(deployed).filter(([key]) => !(key in phase1Services)),
    );
    const text = issuesOf(() => parseEnv(withoutServices)).join("\n");
    for (const name of [
      "DATABASE_URL",
      "NEXT_PUBLIC_SUPABASE_URL",
      "R2_BUCKET",
      "NETWORK_KEY_SECRET_CURRENT",
      "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
    ]) {
      expect(text).toContain(name);
    }
  });

  it("rejects short network key secrets", () => {
    const issues = issuesOf(() => parseEnv({ NETWORK_KEY_SECRET_CURRENT: "short" }));
    expect(issues.join("\n")).toMatch(/NETWORK_KEY_SECRET_CURRENT/);
  });

  it("rejects placeholder network key secrets when deployed", () => {
    const issues = issuesOf(() =>
      parseEnv({ ...deployed, NETWORK_KEY_SECRET_CURRENT: "your-network-secret-goes-here-0000000000" }),
    );
    expect(issues.join("\n")).toMatch(/NETWORK_KEY_SECRET_CURRENT: looks like a placeholder/);
  });

  it("lists network key secrets by version, current first (rotation, 03 §3.2)", () => {
    const env = parseEnv({
      NETWORK_KEY_SECRET_CURRENT: NETWORK_SECRET,
      NETWORK_KEY_SECRET_PREVIOUS: NETWORK_SECRET_PREVIOUS,
      NETWORK_KEY_VERSION: "2",
    });
    expect(env.networkKeys).toEqual([
      { version: 2, secret: NETWORK_SECRET },
      { version: 1, secret: NETWORK_SECRET_PREVIOUS },
    ]);
  });

  it("defaults the key version to 1 and the IPv6 prefix to /64", () => {
    const env = parseEnv({ NETWORK_KEY_SECRET_CURRENT: NETWORK_SECRET });
    expect(env.networkKeys).toEqual([{ version: 1, secret: NETWORK_SECRET }]);
    expect(env.NETWORK_IPV6_PREFIX_LEN).toBe(64);
  });

  it("requires a previous secret to have a version below the current one", () => {
    const issues = issuesOf(() =>
      parseEnv({ NETWORK_KEY_SECRET_CURRENT: NETWORK_SECRET, NETWORK_KEY_SECRET_PREVIOUS: NETWORK_SECRET_PREVIOUS }),
    );
    expect(issues.join("\n")).toMatch(/NETWORK_KEY_VERSION/);
  });

  it("caches runtime flags for 30 s by default, at most 300 s (03 §10)", () => {
    expect(parseEnv({}).RUNTIME_FLAGS_CACHE_SECONDS).toBe(30);
    expect(parseEnv({ RUNTIME_FLAGS_CACHE_SECONDS: "0" }).RUNTIME_FLAGS_CACHE_SECONDS).toBe(0);
    expect(issuesOf(() => parseEnv({ RUNTIME_FLAGS_CACHE_SECONDS: "301" })).join("\n")).toMatch(/RUNTIME_FLAGS_CACHE_SECONDS/);
  });

  it("rejects IPv6 prefix lengths outside 32–128", () => {
    expect(issuesOf(() => parseEnv({ NETWORK_IPV6_PREFIX_LEN: "16" })).join("\n")).toMatch(/NETWORK_IPV6_PREFIX_LEN/);
    expect(issuesOf(() => parseEnv({ NETWORK_IPV6_PREFIX_LEN: "64.5" })).join("\n")).toMatch(/NETWORK_IPV6_PREFIX_LEN/);
  });

  it("refuses TEST_CLIENT_IP_DEFAULT wherever the test override is refused", () => {
    expect(
      issuesOf(() => parseEnv({ NODE_ENV: "production", APP_ENV: "local", TEST_CLIENT_IP_DEFAULT: "203.0.113.10" })).join("\n"),
    ).toMatch(/TEST_CLIENT_IP_DEFAULT/);
    expect(issuesOf(() => parseEnv({ ...deployed, TEST_CLIENT_IP_DEFAULT: "203.0.113.10" })).join("\n")).toMatch(
      /TEST_CLIENT_IP_DEFAULT/,
    );
  });

  it("uses TEST_CLIENT_IP_DEFAULT only together with the test override", () => {
    expect(parseEnv({ TEST_CLIENT_IP_DEFAULT: "203.0.113.10" }).testClientIpDefault).toBeUndefined();
    expect(
      parseEnv({ APP_ENV: "local", ALLOW_TEST_CLIENT_IP: "1", TEST_CLIENT_IP_DEFAULT: "203.0.113.10" }).testClientIpDefault,
    ).toBe("203.0.113.10");
  });

  it("allows the test override only when APP_ENV is set explicitly to local or test", () => {
    expect(parseEnv({ ALLOW_TEST_CLIENT_IP: "1" }).testClientIpAllowed).toBe(false);
    expect(parseEnv({ APP_ENV: "local", ALLOW_TEST_CLIENT_IP: "1" }).testClientIpAllowed).toBe(true);
  });

  it("refuses the test override whenever Cloudflare is trusted", () => {
    const issues = issuesOf(() =>
      parseEnv({ APP_ENV: "test", ALLOW_TEST_CLIENT_IP: "1", TRUST_PROXY_MODE: "cloudflare", ORIGIN_SHARED_SECRET: SECRET }),
    );
    expect(issues.join("\n")).toMatch(/ALLOW_TEST_CLIENT_IP/);
  });

  it("never includes secret values in error messages", () => {
    const leaked = "changeme-this-must-not-appear-in-errors-1234";
    try {
      parseEnv({ ...deployed, ORIGIN_SHARED_SECRET: leaked, R2_SECRET_ACCESS_KEY: leaked });
      throw new Error("expected EnvError");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      expect(String((error as Error).message)).not.toContain(leaked);
      expect((error as EnvError).issues.join("\n")).not.toContain(leaked);
    }
  });
});

describe("getEnv", () => {
  afterEach(() => resetEnvCache());

  it("reads process.env once and caches the result", () => {
    vi.stubEnv("APP_ALLOWED_ORIGINS", "http://localhost:4000");
    resetEnvCache();
    expect(getEnv().allowedOrigins).toEqual(["http://localhost:4000"]);
    vi.stubEnv("APP_ALLOWED_ORIGINS", "http://localhost:5000");
    expect(getEnv().allowedOrigins).toEqual(["http://localhost:4000"]);
    resetEnvCache();
    expect(getEnv().allowedOrigins).toEqual(["http://localhost:5000"]);
  });
});
