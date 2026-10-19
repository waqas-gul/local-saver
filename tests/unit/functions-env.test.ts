import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Supabase injects SUPABASE_DB_URL (the postgres role), the service-role key, the secret keys and
 * the JWKS into every Edge Function, and the runtime can't remove them: Deno.env.delete is a
 * silent no-op and Deno.env.set is NotSupported (security review, 2026-10-16; RISK-036). The
 * functions must never read or log them. This scans the function sources, so a change that
 * reaches for them fails here first (the janitor-core tests check what readJanitorConfig asks
 * for).
 */

const ROOT = "supabase/functions";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|js|mjs|tsx)$/.test(name) ? [path.replace(/\\/g, "/")] : [];
  });
}

/** Source with comments removed (good enough for these files: no comment markers inside strings). */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const FILES = sources(ROOT);

describe("Edge Function sources and the injected secrets (C-4, RISK-036)", () => {
  it("finds the function sources", () => {
    expect(FILES).toEqual(
      expect.arrayContaining([`${ROOT}/storage-janitor/index.ts`, `${ROOT}/_shared/janitor-core.ts`, `${ROOT}/_shared/s3-fetch.ts`]),
    );
  });

  it("no source names an injected variable (SUPABASE_*, SB_*) outside comments", () => {
    for (const path of FILES) expect(code(path), path).not.toMatch(/\b(SUPABASE|SB)_[A-Z_]+/);
  });

  it("the environment is read in exactly one place, by name, through readJanitorConfig", () => {
    const reads = FILES.flatMap((path) =>
      [...code(path).matchAll(/Deno\.env\.[a-zA-Z]+|process\.env|Deno\.env\b(?!\.)|globalThis\.Deno|import\.meta\.env/g)].map((m) => `${path}: ${m[0]}`),
    );
    expect(reads).toEqual([`${ROOT}/storage-janitor/index.ts: Deno.env.get`]);
    expect(code(`${ROOT}/storage-janitor/index.ts`)).toContain("readJanitorConfig((name) => Deno.env.get(name))");
  });

  it("logs go through one structured logger, and the configuration is never logged", () => {
    const consoles = FILES.flatMap((path) => [...code(path).matchAll(/console\.[a-z]+/g)].map((m) => `${path}: ${m[0]}`));
    expect(consoles.sort()).toEqual([
      `${ROOT}/storage-janitor/index.ts: console.error`,
      `${ROOT}/storage-janitor/index.ts: console.log`,
      `${ROOT}/storage-janitor/index.ts: console.warn`,
    ]);
    for (const path of FILES) {
      expect(code(path), path).not.toMatch(/log\([^)]*\bconfig\b/);
      expect(code(path), path).not.toMatch(/JSON\.stringify\(\s*config\b/);
    }
  });

  it("the function connects to the database with JANITOR_DATABASE_URL only", () => {
    const index = code(`${ROOT}/storage-janitor/index.ts`);
    expect([...index.matchAll(/postgres\(([^,]+),/g)].map((m) => m[1]?.trim())).toEqual(["config.databaseUrl"]);
  });
});
