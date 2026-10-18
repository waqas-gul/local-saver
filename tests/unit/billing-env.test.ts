import { describe, expect, it } from "vitest";
import { EnvError, parseEnv } from "@/lib/server/env";

/** Phase 4C billing settings (phase 4 §17.7.2): all or none; the fake provider only in tests and local development. */

const WEBHOOK_SECRET = "billing-webhook-secret-that-is-long-enough-01";
const WEBHOOK_SECRET_PREVIOUS = "billing-webhook-secret-that-is-long-enough-00";
const RECONCILE_SECRET = "billing-reconcile-secret-long-enough-000000001";

const fake = {
  BILLING_PROVIDER: "fake",
  BILLING_API_KEY: "fake-api-key",
  BILLING_WEBHOOK_SECRET: WEBHOOK_SECRET,
  BILLING_PRICE_PRO_MONTH: "price_month",
  BILLING_PRICE_PRO_YEAR: "price_year",
  BILLING_FAKE_API_URL: "http://127.0.0.1:3298",
};

const deployed = {
  NODE_ENV: "production",
  APP_ENV: "production",
  TRUST_PROXY_MODE: "cloudflare",
  ORIGIN_SHARED_SECRET: "s3cr3t-value-that-is-long-enough-000001",
  NEXT_PUBLIC_APP_ORIGIN: "https://app.example.com",
  DATABASE_URL: "postgresql://app_server:pw@db.internal:6543/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "https://abcdefgh.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_abcdefgh",
  R2_ACCOUNT_ID: "acc",
  R2_BUCKET: "files-prod",
  R2_S3_ENDPOINT: "https://acc.r2.cloudflarestorage.com",
  R2_ACCESS_KEY_ID: "key-id",
  R2_SECRET_ACCESS_KEY: "r2-secret-value-that-is-long-enough-0001",
  NETWORK_KEY_SECRET_CURRENT: "network-key-secret-that-is-long-enough-0001",
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "0x4AAAAAAAsitekey",
  LINK_PEPPER: "link-pepper-that-is-long-enough-000000001",
  CODE_PEPPER: "code-pepper-that-is-long-enough-000000001",
  TURNSTILE_SECRET_KEY: "0x4AAAAAAAturnstile-secret-key-0001",
};

function issuesOf(source: Record<string, string>): string[] {
  try {
    parseEnv(source);
  } catch (error) {
    if (error instanceof EnvError) return error.issues;
    throw error;
  }
  return [];
}

describe("billing settings", () => {
  it("are optional: no billing means billing routes answer 503", () => {
    const env = parseEnv({ APP_ENV: "test" });
    expect(env.billing).toBeNull();
    expect(env.billingReconcileSecrets).toEqual([]);
    // Deployed without billing is valid too: no provider is chosen yet (Q-005).
    expect(parseEnv(deployed).billing).toBeNull();
  });

  it("parse the fake provider in tests and local development", () => {
    const env = parseEnv({ APP_ENV: "test", NODE_ENV: "test", ...fake, BILLING_WEBHOOK_SECRET_PREVIOUS: WEBHOOK_SECRET_PREVIOUS });
    expect(env.billing).toEqual({
      provider: "fake",
      apiKey: "fake-api-key",
      webhookSecrets: [WEBHOOK_SECRET, WEBHOOK_SECRET_PREVIOUS],
      prices: { month: "price_month", year: "price_year" },
      fakeApiUrl: "http://127.0.0.1:3298",
    });
  });

  it("refuse the fake provider and its URL in production builds and deployments", () => {
    expect(issuesOf({ APP_ENV: "local", NODE_ENV: "production", ...fake })).toEqual(
      expect.arrayContaining([expect.stringMatching(/^BILLING_PROVIDER: the fake provider is for tests/), expect.stringMatching(/^BILLING_FAKE_API_URL: tests and local/)]),
    );
    expect(issuesOf({ ...deployed, ...fake })).toEqual(expect.arrayContaining([expect.stringMatching(/^BILLING_PROVIDER: the fake provider/)]));
    expect(issuesOf({ ...deployed, BILLING_FAKE_API_URL: "http://127.0.0.1:3298" })).toEqual(
      expect.arrayContaining([expect.stringMatching(/^BILLING_FAKE_API_URL: tests and local/)]),
    );
  });

  it("need every provider setting, and no setting without a provider", () => {
    const { BILLING_PRICE_PRO_YEAR: _year, ...partial } = fake;
    expect(issuesOf({ APP_ENV: "test", ...partial })).toEqual(["Billing: set all of its variables or none (missing BILLING_PRICE_PRO_YEAR)"]);
    expect(issuesOf({ APP_ENV: "test", BILLING_API_KEY: "k", BILLING_WEBHOOK_SECRET: WEBHOOK_SECRET })).toEqual([
      "BILLING_PROVIDER: required when BILLING_API_KEY, BILLING_WEBHOOK_SECRET is set",
    ]);
    const { BILLING_FAKE_API_URL: _url, ...noUrl } = fake;
    expect(issuesOf({ APP_ENV: "test", ...noUrl })).toEqual(["BILLING_FAKE_API_URL: required with BILLING_PROVIDER=fake"]);
  });

  it("refuse an unknown provider, short secrets and one price for both intervals", () => {
    expect(issuesOf({ APP_ENV: "test", ...fake, BILLING_PROVIDER: "stripe" })[0]).toMatch(/^BILLING_PROVIDER:/);
    expect(issuesOf({ APP_ENV: "test", ...fake, BILLING_WEBHOOK_SECRET: "short" })).toEqual(["BILLING_WEBHOOK_SECRET: must be at least 32 characters"]);
    expect(issuesOf({ APP_ENV: "test", ...fake, BILLING_PRICE_PRO_YEAR: "price_month" })).toEqual([
      "BILLING_PRICE_PRO_YEAR: must differ from BILLING_PRICE_PRO_MONTH",
    ]);
  });

  it("parse the reconcile secrets current first, and need the current one for a previous one", () => {
    const env = parseEnv({ APP_ENV: "test", BILLING_RECONCILE_SECRET: RECONCILE_SECRET, BILLING_RECONCILE_SECRET_PREVIOUS: `${RECONCILE_SECRET}x` });
    expect(env.billingReconcileSecrets).toEqual([RECONCILE_SECRET, `${RECONCILE_SECRET}x`]);
    expect(issuesOf({ APP_ENV: "test", BILLING_RECONCILE_SECRET_PREVIOUS: RECONCILE_SECRET })).toEqual([
      "BILLING_RECONCILE_SECRET: required when BILLING_RECONCILE_SECRET_PREVIOUS is set",
    ]);
    expect(issuesOf({ APP_ENV: "test", BILLING_RECONCILE_SECRET: "short" })).toEqual(["BILLING_RECONCILE_SECRET: must be at least 32 characters"]);
  });

  it("treat billing secrets that look like placeholders as errors when deployed", () => {
    expect(issuesOf({ ...deployed, BILLING_RECONCILE_SECRET: "change-me-change-me-change-me-change-me" })).toEqual([
      "BILLING_RECONCILE_SECRET: looks like a placeholder value",
    ]);
  });
});
