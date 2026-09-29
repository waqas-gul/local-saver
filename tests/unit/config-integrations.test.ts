import { describe, expect, it } from "vitest";
import { IntegrationNotConfiguredError, getDatabaseUrl, getR2Config, getSupabaseConfig } from "@/lib/server/config/integrations";
import { parseEnv } from "@/lib/server/env";

const empty = parseEnv({});
const full = parseEnv({
  DATABASE_URL: "postgresql://app_server:pw@127.0.0.1:54322/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "https://abcd.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  R2_ACCOUNT_ID: "acc123",
  R2_BUCKET: "files-staging",
  R2_S3_ENDPOINT: "https://acc123.r2.cloudflarestorage.com",
  R2_ACCESS_KEY_ID: "key-id",
  R2_SECRET_ACCESS_KEY: "secret-key",
});

describe("integration config accessors", () => {
  it("throw a named error listing only the missing variable names", () => {
    for (const fn of [() => getDatabaseUrl(empty), () => getSupabaseConfig(empty), () => getR2Config(empty)]) {
      expect(fn).toThrow(IntegrationNotConfiguredError);
    }
    try {
      getR2Config(empty);
    } catch (error) {
      expect((error as IntegrationNotConfiguredError).missing).toContain("R2_BUCKET");
    }
  });

  it("return typed configuration when set", () => {
    expect(getDatabaseUrl(full)).toMatch(/^postgresql:/);
    expect(getSupabaseConfig(full)).toEqual({
      url: "https://abcd.supabase.co",
      publishableKey: "sb_publishable_test",
      secretKey: "sb_secret_test",
    });
    expect(getR2Config(full)).toEqual({
      accountId: "acc123",
      bucket: "files-staging",
      endpoint: "https://acc123.r2.cloudflarestorage.com",
      accessKeyId: "key-id",
      secretAccessKey: "secret-key",
    });
  });
});
