import { execFileSync, spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import ipaddr from "ipaddr.js";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { LOCAL } from "../../scripts/local-stack.cjs";
import { closeAdminDb, Device, newNetwork } from "./support/api";

/**
 * Review L5: the client address must never reach Postgres, not even as a query parameter that
 * statement logging, auto_explain or pgaudit could record. With every statement logged in full
 * (log_statement = all, parameters included), the log must not contain the address.
 */

const DB_CONTAINER = "supabase_db_local-saver"; // supabase/config.toml project_id

afterAll(closeAdminDb);

function asSuperuser(sql: string) {
  execFileSync("docker", ["exec", DB_CONTAINER, "psql", "-U", "supabase_admin", "-d", "postgres", "-Atqc", sql]);
}

function databaseLogSince(since: string): string {
  const result = spawnSync("docker", ["logs", "--since", since, DB_CONTAINER], { encoding: "utf8" });
  return `${result.stdout}${result.stderr}`;
}

/** The address as a whole token, so 198.51.100.1 does not match inside 198.51.100.10. */
function mentions(log: string, address: string): boolean {
  const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^0-9a-fA-F:.])${escaped}($|[^0-9a-fA-F:.])`, "m").test(log);
}

describe("raw client addresses and database logs (review L5)", () => {
  it("observe sends Postgres only a keyed hash and a /24 or /48 prefix, never the address", { timeout: 60_000 }, async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    asSuperuser("alter system set log_statement = 'all'");
    asSuperuser("select pg_reload_conf()");
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const v6 = ipaddr.parse(newNetwork().ip()).toString();
      const v4 = `198.51.100.${randomInt(2, 254)}`;
      const devices = [await Device.create(v6), await Device.create(v4)];
      for (const device of devices) await device.observe();

      // Control: under these settings a parameter carrying an address IS logged in full, which
      // is how the address leaked before (it was passed to observe_network).
      const probe = `2001:db8:ffff:${randomInt(1, 0xffff).toString(16)}::1`;
      const pool = new pg.Pool({ connectionString: LOCAL.appServerDatabaseUrl, max: 1 });
      try {
        await pool.query("select $1::inet as probe", [probe]);
      } finally {
        await pool.end();
      }

      const log = databaseLogSince(since);
      expect(mentions(log, probe)).toBe(true);
      expect(log).toContain("app.observe_network");
      expect(log).toMatch(/parameters: \$1 = /i);
      expect(log).toContain(`${ipaddr.IPv6.networkAddressFromCIDR(`${v6}/48`).toString()}/48`);
      expect(log).toContain("198.51.100.0/24");
      // The addresses themselves, and the IPv6 /64 the network key is made from, never appear.
      expect(mentions(log, v6)).toBe(false);
      expect(mentions(log, v4)).toBe(false);
      expect(log).not.toContain(`${ipaddr.IPv6.networkAddressFromCIDR(`${v6}/64`).toString()}/64`);
    } finally {
      asSuperuser("alter system reset log_statement");
      asSuperuser("select pg_reload_conf()");
    }
  });
});
