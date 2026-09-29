import "server-only";
import type { Env } from "../env";

/**
 * Typed access to integration settings (Phase 0 "integration foundation").
 * The Supabase and R2 SDKs arrive in Phase 1; these accessors are what they will read.
 * Errors name the missing variables, never values.
 */

export class IntegrationNotConfiguredError extends Error {
  constructor(
    readonly integration: string,
    readonly missing: string[],
  ) {
    super(`${integration} is not configured (missing ${missing.join(", ")})`);
    this.name = "IntegrationNotConfiguredError";
  }
}

function requireVars<K extends keyof Env>(env: Env, integration: string, keys: K[]): { [P in K]: NonNullable<Env[P]> } {
  const missing = keys.filter((k) => env[k] === undefined || env[k] === null);
  if (missing.length > 0) throw new IntegrationNotConfiguredError(integration, missing.map(String));
  return Object.fromEntries(keys.map((k) => [k, env[k]])) as { [P in K]: NonNullable<Env[P]> };
}

export function getDatabaseUrl(env: Env): string {
  return requireVars(env, "Database", ["DATABASE_URL"]).DATABASE_URL;
}

export type SupabaseConfig = { url: string; publishableKey: string; secretKey?: string };

export function getSupabaseConfig(env: Env): SupabaseConfig {
  const v = requireVars(env, "Supabase", ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]);
  return {
    url: v.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey: v.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    ...(env.SUPABASE_SECRET_KEY ? { secretKey: env.SUPABASE_SECRET_KEY } : {}),
  };
}

export type R2Config = {
  accountId: string;
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export function getR2Config(env: Env): R2Config {
  const v = requireVars(env, "R2", ["R2_ACCOUNT_ID", "R2_BUCKET", "R2_S3_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]);
  return {
    accountId: v.R2_ACCOUNT_ID,
    bucket: v.R2_BUCKET,
    endpoint: v.R2_S3_ENDPOINT,
    accessKeyId: v.R2_ACCESS_KEY_ID,
    secretAccessKey: v.R2_SECRET_ACCESS_KEY,
  };
}
