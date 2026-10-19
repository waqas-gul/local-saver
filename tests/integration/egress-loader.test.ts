import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { LOCAL } from "../../scripts/local-stack.cjs";
import { adminDb, closeAdminDb, Device } from "./support/api";

/** The egress-list loader (03 §3.5 (a), review M2), run against the local database with fixtures. */

afterAll(closeAdminDb);

function load(apple: string, tor: string, databaseUrl: string = LOCAL.adminDatabaseUrl) {
  const dir = mkdtempSync(join(tmpdir(), "egress-"));
  writeFileSync(join(dir, "apple.csv"), apple);
  writeFileSync(join(dir, "tor.txt"), tor);
  return execFileSync(process.execPath, ["scripts/load-egress-ranges.cjs", "--apple", join(dir, "apple.csv"), "--tor", join(dir, "tor.txt")], {
    env: { ...process.env, LOADER_DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
}

describe("load-egress-ranges", () => {
  it("replaces both lists, records the load time, and the ranges classify networks", async () => {
    const output = load(
      "2001:db8:5e1a::/48,GB,GB-EN,London,\n192.0.2.0/27,GB,GB-EN,London,\n192.0.2.32/27,GB,GB-EN,Leeds,\nnot-a-prefix,XX,,,\n",
      "# exit list\n198.51.100.77\n",
    );
    expect(output).toContain("private_relay: 3 ranges listed, 2 rows after merging, 1 lines skipped");
    expect(output).toContain("tor: 1 ranges listed, 1 rows after merging, 0 lines skipped");

    const { rows } = await adminDb().query(
      "select cidr::text, source from app.network_egress_ranges where source in ('private_relay', 'tor') order by 1",
    );
    expect(rows).toEqual([
      { cidr: "192.0.2.0/26", source: "private_relay" },
      { cidr: "198.51.100.77/32", source: "tor" },
      { cidr: "2001:db8:5e1a::/48", source: "private_relay" },
    ]);
    const flag = await adminDb().query("select value from app.runtime_flags where key = 'egress_ranges'");
    expect(Date.now() - Date.parse(flag.rows[0].value.loadedAt)).toBeLessThan(60_000);

    // The app matches the exact address against the ranges near its /24 or /48 (review L5).
    const relayUser = await Device.create(`2001:db8:5e1a:${Math.floor(Math.random() * 0xffff).toString(16)}::1`, { observe: false });
    expect((await relayUser.observe()).status).toBe("shared_egress");
    const relayV4 = await Device.create("192.0.2.40", { observe: false });
    expect((await relayV4.observe()).status).toBe("shared_egress");
    const neighbour = await Device.create("192.0.2.70", { observe: false }); // same /24, outside the /26
    expect((await neighbour.observe()).status).toBe("ok");
    const torUser = await Device.create("198.51.100.77", { observe: false });
    expect((await torUser.observe()).status).toBe("shared_egress");
  });

  it("refuses to empty a list when a download or file has nothing usable", () => {
    expect(() => load("garbage\n", "198.51.100.77\n")).toThrow();
  });

  it("runs as the least-privilege app_egress_loader role, which can't touch tables directly (D-4)", async () => {
    const output = load("192.0.2.0/27,GB,GB-EN,London,\n", "198.51.100.78\n", LOCAL.egressLoaderDatabaseUrl);
    expect(output).toContain("private_relay: 1 ranges listed, 1 rows after merging, 0 lines skipped");
    const { rows } = await adminDb().query("select value from app.runtime_flags where key = 'egress_ranges'");
    expect(rows[0].value.rows).toEqual({ private_relay: 1, tor: 1 });
    expect(Date.now() - Date.parse(rows[0].value.loadedAt)).toBeLessThan(60_000);

    const role = new pg.Client({ connectionString: LOCAL.egressLoaderDatabaseUrl });
    await role.connect();
    try {
      await expect(role.query("delete from app.network_egress_ranges")).rejects.toThrow(/permission denied/);
      await expect(role.query("update app.runtime_flags set enabled = false where key = 'local_sharing_enabled'")).rejects.toThrow(
        /permission denied/,
      );
      await expect(role.query("select app.replace_egress_ranges('tor', array[]::cidr[])")).rejects.toThrow(/refusing to empty/);
    } finally {
      await role.end();
    }
  });

  afterAll(async () => {
    await adminDb().query("delete from app.network_egress_ranges where source in ('private_relay', 'tor')");
  });
});
