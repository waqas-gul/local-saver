import "server-only";
import { z } from "zod";

/**
 * Environment configuration, validated with zod (DEC-029, 08 §9).
 *
 * Phase 1 adds the network key secrets (DEC-032), the IPv6 prefix length and the
 * local-only default test IP, and requires every Phase 1 service when deployed.
 * Phase 2 adds the versioned link and code peppers (03 §12) and the Turnstile secret, which the
 * server now uses to verify challenges (code-guessing escalation, abuse reports; DV2-6).
 */

const APP_ENVS = ["local", "test", "staging", "production"] as const;
const DEPLOYED: readonly string[] = ["staging", "production"];
const LOCAL_DEFAULT_ORIGIN = "http://localhost:3000";
const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER = /change[-_ ]?me|placeholder|your[-_]|example|xxxx|<.*>/i;
const TURNSTILE_SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const optionalString = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .optional();

const optionalUrl = optionalString.pipe(z.url().optional());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: z.enum(APP_ENVS).default("local"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  NEXT_PUBLIC_APP_ORIGIN: optionalString,
  APP_ALLOWED_ORIGINS: optionalString,

  TRUST_PROXY_MODE: z.enum(["none", "cloudflare"]).default("none"),
  ORIGIN_SHARED_SECRET: optionalString,
  ORIGIN_SHARED_SECRET_PREVIOUS: optionalString,
  ALLOW_TEST_CLIENT_IP: z.enum(["0", "1"]).optional(),
  /** Tests and local development only: the client IP assumed when X-Test-Client-IP is absent. */
  TEST_CLIENT_IP_DEFAULT: optionalString,

  DATABASE_URL: optionalString,

  NEXT_PUBLIC_SUPABASE_URL: optionalUrl,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: optionalString,
  SUPABASE_SECRET_KEY: optionalString,

  R2_ACCOUNT_ID: optionalString,
  R2_BUCKET: optionalString,
  R2_S3_ENDPOINT: optionalUrl,
  R2_ACCESS_KEY_ID: optionalString,
  R2_SECRET_ACCESS_KEY: optionalString,

  NEXT_PUBLIC_TURNSTILE_SITE_KEY: optionalString,

  NETWORK_KEY_SECRET_CURRENT: optionalString,
  NETWORK_KEY_SECRET_PREVIOUS: optionalString,
  NETWORK_KEY_VERSION: z.coerce.number().int().min(1).max(32767).default(1),
  NETWORK_IPV6_PREFIX_LEN: z.coerce.number().int().min(32).max(128).default(64),
  /** Kill switches are cached at most this long (03 §10: ≤ 30 s). Tests use 0. */
  RUNTIME_FLAGS_CACHE_SECONDS: z.coerce.number().int().min(0).max(300).default(30),

  /** HMAC keys for link secrets and short codes (DEC-013, DEC-014); PREVIOUS only during rotation. */
  LINK_PEPPER: optionalString,
  LINK_PEPPER_PREVIOUS: optionalString,
  CODE_PEPPER: optionalString,
  CODE_PEPPER_PREVIOUS: optionalString,
  PEPPER_VERSION: z.coerce.number().int().min(1).max(32767).default(1),
  /** Server-side Turnstile verification (code escalation, reports). */
  TURNSTILE_SECRET_KEY: optionalString,
  /** Tests and local development only: a stand-in for Cloudflare's siteverify endpoint. */
  TURNSTILE_VERIFY_URL: optionalUrl,
});

type RawEnv = z.infer<typeof schema>;

export type Env = RawEnv & {
  /** Canonical origin of this deployment. */
  appOrigin: string;
  /** Exact origins accepted on mutating API requests (CSRF check). */
  allowedOrigins: string[];
  /** Current and previous origin-lock secrets (rotation). */
  originSecrets: string[];
  /** staging or production */
  isDeployed: boolean;
  /** Served over HTTPS (controls HSTS and upgrade-insecure-requests). */
  isHttps: boolean;
  /** The X-Test-Client-IP override may be honoured (never in production builds). */
  testClientIpAllowed: boolean;
  /** Client IP assumed without X-Test-Client-IP; only when testClientIpAllowed. */
  testClientIpDefault: string | undefined;
  /** Network key secrets by version, current first (DEC-032). Empty when not configured. */
  networkKeys: VersionedSecret[];
  /** Link-secret peppers by version, current first (03 §12). Empty when not configured. */
  linkPeppers: VersionedSecret[];
  /** Short-code peppers by version, current first. Empty when not configured. */
  codePeppers: VersionedSecret[];
  /** Server-side Turnstile verification; null when no secret is configured. */
  turnstile: { secretKey: string; verifyUrl: string } | null;
};

export type VersionedSecret = { version: number; secret: string };

/** Thrown when the environment is invalid. Messages name variables, never values. */
export class EnvError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n- ${issues.join("\n- ")}`);
    this.name = "EnvError";
  }
}

const GROUPS: Record<string, (keyof RawEnv)[]> = {
  Supabase: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"],
  R2: ["R2_ACCOUNT_ID", "R2_BUCKET", "R2_S3_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"],
};

const SECRETS: (keyof RawEnv)[] = [
  "ORIGIN_SHARED_SECRET",
  "ORIGIN_SHARED_SECRET_PREVIOUS",
  "SUPABASE_SECRET_KEY",
  "R2_SECRET_ACCESS_KEY",
  "NETWORK_KEY_SECRET_CURRENT",
  "NETWORK_KEY_SECRET_PREVIOUS",
  "LINK_PEPPER",
  "LINK_PEPPER_PREVIOUS",
  "CODE_PEPPER",
  "CODE_PEPPER_PREVIOUS",
  "TURNSTILE_SECRET_KEY",
];

/** Secrets that must be long random values wherever they are set. */
const MIN_LENGTH_SECRETS = [
  "ORIGIN_SHARED_SECRET",
  "ORIGIN_SHARED_SECRET_PREVIOUS",
  "NETWORK_KEY_SECRET_CURRENT",
  "NETWORK_KEY_SECRET_PREVIOUS",
  "LINK_PEPPER",
  "LINK_PEPPER_PREVIOUS",
  "CODE_PEPPER",
  "CODE_PEPPER_PREVIOUS",
] as const;

/** Everything Phase 1 needs to serve local sharing; required in staging and production. */
const REQUIRED_WHEN_DEPLOYED: (keyof RawEnv)[] = [
  "DATABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "R2_ACCOUNT_ID",
  "R2_BUCKET",
  "R2_S3_ENDPOINT",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "NETWORK_KEY_SECRET_CURRENT",
  // Supabase Auth verifies the Turnstile token on anonymous sign-in (DV1-9).
  "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
  // Phase 2: remote links and codes, and the server's own Turnstile checks.
  "LINK_PEPPER",
  "CODE_PEPPER",
  "TURNSTILE_SECRET_KEY",
];

/** Current secret first, then the previous one under the version below it (rotation). */
function versioned(
  issues: string[],
  current: string | undefined,
  previous: string | undefined,
  version: number,
  names: { current: string; previous: string; version: string },
): VersionedSecret[] {
  if (!current) {
    if (previous) issues.push(`${names.current}: required when ${names.previous} is set`);
    return [];
  }
  const list = [{ version, secret: current }];
  if (previous) {
    if (version < 2) issues.push(`${names.version}: must be 2 or more when ${names.previous} is set`);
    else list.push({ version: version - 1, secret: previous });
  }
  return list;
}

function parseOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin === value ? url.origin : null;
  } catch {
    return null;
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  // An empty value means "not set" (for example a line copied from .env.example).
  const cleaned = Object.fromEntries(
    Object.entries(source).map(([key, value]) => [key, value?.trim() === "" ? undefined : value]),
  );
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    // zod issue messages describe the rule, not the input value.
    throw new EnvError(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  const raw = result.data;
  const issues: string[] = [];
  const isDeployed = DEPLOYED.includes(raw.APP_ENV);

  const appOrigin = raw.NEXT_PUBLIC_APP_ORIGIN ?? (isDeployed ? undefined : LOCAL_DEFAULT_ORIGIN);
  if (!appOrigin) issues.push("NEXT_PUBLIC_APP_ORIGIN: required in staging and production");
  else if (!parseOrigin(appOrigin)) issues.push("NEXT_PUBLIC_APP_ORIGIN: must be an origin like https://app.example.com");

  const originList = (raw.APP_ALLOWED_ORIGINS ?? appOrigin ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const allowedOrigins: string[] = [];
  for (const entry of originList) {
    const origin = parseOrigin(entry);
    if (origin) allowedOrigins.push(origin);
    else issues.push("APP_ALLOWED_ORIGINS: every entry must be an origin like https://app.example.com (no path)");
  }
  if (allowedOrigins.length === 0 && issues.length === 0) {
    issues.push("APP_ALLOWED_ORIGINS: at least one origin is required");
  }

  const originSecrets = [raw.ORIGIN_SHARED_SECRET, raw.ORIGIN_SHARED_SECRET_PREVIOUS].filter(
    (s): s is string => typeof s === "string",
  );
  for (const key of MIN_LENGTH_SECRETS) {
    const value = raw[key];
    if (value !== undefined && value.length < MIN_SECRET_LENGTH) {
      issues.push(`${key}: must be at least ${MIN_SECRET_LENGTH} characters`);
    }
  }

  const networkKeys: VersionedSecret[] = [];
  if (raw.NETWORK_KEY_SECRET_CURRENT) {
    networkKeys.push({ version: raw.NETWORK_KEY_VERSION, secret: raw.NETWORK_KEY_SECRET_CURRENT });
    if (raw.NETWORK_KEY_SECRET_PREVIOUS) {
      if (raw.NETWORK_KEY_VERSION < 2) {
        issues.push("NETWORK_KEY_VERSION: must be 2 or more when NETWORK_KEY_SECRET_PREVIOUS is set");
      } else {
        networkKeys.push({ version: raw.NETWORK_KEY_VERSION - 1, secret: raw.NETWORK_KEY_SECRET_PREVIOUS });
      }
    }
  } else if (raw.NETWORK_KEY_SECRET_PREVIOUS) {
    issues.push("NETWORK_KEY_SECRET_CURRENT: required when NETWORK_KEY_SECRET_PREVIOUS is set");
  }

  const linkPeppers = versioned(issues, raw.LINK_PEPPER, raw.LINK_PEPPER_PREVIOUS, raw.PEPPER_VERSION, {
    current: "LINK_PEPPER",
    previous: "LINK_PEPPER_PREVIOUS",
    version: "PEPPER_VERSION",
  });
  const codePeppers = versioned(issues, raw.CODE_PEPPER, raw.CODE_PEPPER_PREVIOUS, raw.PEPPER_VERSION, {
    current: "CODE_PEPPER",
    previous: "CODE_PEPPER_PREVIOUS",
    version: "PEPPER_VERSION",
  });
  // Separate keys, so a leak of one hash table can't be checked with the other key.
  if (raw.LINK_PEPPER && raw.LINK_PEPPER === raw.CODE_PEPPER) {
    issues.push("CODE_PEPPER: must differ from LINK_PEPPER");
  }

  if (raw.TURNSTILE_SECRET_KEY && !raw.NEXT_PUBLIC_TURNSTILE_SITE_KEY) {
    issues.push("NEXT_PUBLIC_TURNSTILE_SITE_KEY: required when TURNSTILE_SECRET_KEY is set (the browser shows the challenge)");
  }
  if (raw.TURNSTILE_VERIFY_URL !== undefined && (raw.NODE_ENV === "production" || isDeployed)) {
    issues.push("TURNSTILE_VERIFY_URL: tests and local development only (refused in production builds and deployments)");
  }
  if ((raw.TRUST_PROXY_MODE === "cloudflare" || isDeployed) && !raw.ORIGIN_SHARED_SECRET) {
    issues.push("ORIGIN_SHARED_SECRET: required in staging, production and whenever TRUST_PROXY_MODE=cloudflare (origin lock, DEC-004)");
  }

  if (raw.NODE_ENV === "production" && raw.ALLOW_TEST_CLIENT_IP === "1") {
    issues.push("ALLOW_TEST_CLIENT_IP: must not be set in a production build (the process refuses to start)");
  }
  if (raw.TRUST_PROXY_MODE === "cloudflare" && raw.ALLOW_TEST_CLIENT_IP === "1") {
    issues.push("ALLOW_TEST_CLIENT_IP: must not be set when TRUST_PROXY_MODE=cloudflare (real client IPs are in use)");
  }
  if (raw.TEST_CLIENT_IP_DEFAULT !== undefined && (raw.NODE_ENV === "production" || isDeployed)) {
    issues.push("TEST_CLIENT_IP_DEFAULT: tests and local development only (refused in production builds and deployments)");
  }

  if (isDeployed) {
    if (raw.NODE_ENV !== "production") issues.push("NODE_ENV: must be production in staging and production");
    if (raw.TRUST_PROXY_MODE !== "cloudflare") {
      issues.push("TRUST_PROXY_MODE: must be cloudflare in staging and production");
    }
    if (raw.ALLOW_TEST_CLIENT_IP === "1") {
      issues.push("ALLOW_TEST_CLIENT_IP: must not be set in staging or production");
    }
    const origins = [appOrigin, ...allowedOrigins].filter((o): o is string => Boolean(o));
    if (origins.some((o) => !o.startsWith("https://"))) {
      issues.push("NEXT_PUBLIC_APP_ORIGIN / APP_ALLOWED_ORIGINS: must use https in staging and production");
    }
    for (const key of SECRETS) {
      const value = raw[key];
      if (typeof value === "string" && PLACEHOLDER.test(value)) {
        issues.push(`${key}: looks like a placeholder value`);
      }
    }
    for (const key of REQUIRED_WHEN_DEPLOYED) {
      if (raw[key] === undefined) issues.push(`${key}: required in staging and production`);
    }
  }

  for (const [group, keys] of Object.entries(GROUPS)) {
    const present = keys.filter((k) => raw[k] !== undefined);
    if (present.length > 0 && present.length < keys.length) {
      const missing = keys.filter((k) => raw[k] === undefined);
      issues.push(`${group}: set all of its variables or none (missing ${missing.join(", ")})`);
    }
  }

  if (issues.length > 0) throw new EnvError(issues);

  // The override also needs APP_ENV set explicitly (it defaults to "local"), so a host that
  // forgets APP_ENV can't enable it by accident.
  const explicitTestEnv = cleaned.APP_ENV === "local" || cleaned.APP_ENV === "test";
  const testClientIpAllowed =
    raw.ALLOW_TEST_CLIENT_IP === "1" && raw.NODE_ENV !== "production" && !isDeployed && explicitTestEnv;
  return {
    ...raw,
    appOrigin: appOrigin as string,
    allowedOrigins,
    originSecrets,
    isDeployed,
    isHttps: (appOrigin as string).startsWith("https://"),
    testClientIpAllowed,
    testClientIpDefault: testClientIpAllowed ? raw.TEST_CLIENT_IP_DEFAULT : undefined,
    networkKeys,
    linkPeppers,
    codePeppers,
    turnstile: raw.TURNSTILE_SECRET_KEY
      ? { secretKey: raw.TURNSTILE_SECRET_KEY, verifyUrl: raw.TURNSTILE_VERIFY_URL ?? TURNSTILE_SITEVERIFY }
      : null,
  };
}

let cached: Env | undefined;

/** Validated environment for this process. Parsed once, at boot (instrumentation.ts) or first use. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Tests only: forget the cached environment. */
export function resetEnvCache(): void {
  cached = undefined;
}
