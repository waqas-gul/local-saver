import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { adminDb, closeAdminDb, Device, newNetwork, stack, Viewer } from "./support/api";

/**
 * Share and code pages, unfurlers and secret hygiene (03 §4.1, §4.9, §11, §14):
 * T-047 (no-store, noindex, no-referrer), T-033 API part (a link-preview GET changes nothing and
 * learns nothing), and link secrets and codes never reaching logs or database statements.
 */

afterAll(closeAdminDb);

const DB_CONTAINER = "supabase_db_local-saver";

describe("share and code pages (T-047)", () => {
  it.each(["/s/AAAAAAAAAAAAAAAA", "/c"])("%s is no-store, noindex and no-referrer, with the strict CSP", async (path) => {
    const response = await fetch(`${stack().origin}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toMatch(/no-store/);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    const html = await response.text();
    expect(html).toMatch(/<meta name="robots" content="noindex, nofollow"/);
    expect(html).toMatch(/<meta name="referrer" content="no-referrer"/);
  });

  it("robots.txt keeps share and code pages out of search engines", async () => {
    const robots = await (await fetch(`${stack().origin}/robots.txt`)).text();
    expect(robots).toMatch(/Disallow: \/s\//);
    expect(robots).toMatch(/Disallow: \/c/);
  });
});

describe("link-preview bots (T-033, API part)", () => {
  it("a GET of the share page returns generic metadata only and changes nothing", async () => {
    const creator = await Device.create(newNetwork().ip());
    const share = await creator.postText("Top secret holiday plans");
    const link = await creator.createLink(share.id);
    const before = await adminDb().query(
      "select (select unlock_count from app.share_links where id = $1) as unlocks, (select count(*)::int from app.link_sessions) as sessions",
      [link.id],
    );

    for (const agent of ["Slackbot-LinkExpanding 1.0", "facebookexternalhit/1.1", "Mozilla/5.0 (compatible; Discordbot/2.0)"]) {
      // Bots fetch the URL without the fragment: browsers never send it.
      const response = await fetch(`${stack().origin}/s/${link.id}`, { headers: { "user-agent": agent } });
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBeNull();
      const html = await response.text();
      expect(html).not.toContain("holiday");
      expect(html).not.toContain(link.secret);
      expect(html).toContain("Something was shared with you");
    }

    const after = await adminDb().query(
      "select (select unlock_count from app.share_links where id = $1) as unlocks, (select count(*)::int from app.link_sessions) as sessions",
      [link.id],
    );
    expect(after.rows[0].unlocks).toBe(before.rows[0].unlocks);
    expect(after.rows[0].sessions).toBe(before.rows[0].sessions);
  });

  it("the share page is identical for an existing link, an unknown one and a malformed one", async () => {
    const creator = await Device.create(newNetwork().ip());
    const link = await creator.createLink((await creator.postText("exists")).id);
    // The page's only per-request differences are the CSP nonce and the ID in the URL itself.
    const page = async (id: string) => {
      const response = await fetch(`${stack().origin}/s/${id}`);
      const nonce = /'nonce-([^']+)'/.exec(response.headers.get("content-security-policy") ?? "")?.[1] ?? "";
      return (await response.text()).replaceAll(id, "ID").replaceAll(nonce, "NONCE");
    };
    const existing = await page(link.id);
    expect(await page("AAAAAAAAAAAAAAAA")).toBe(existing);
    expect(await page("not-a-link")).toBe(existing);
  });
});

describe("secrets never reach logs or the database in clear (03 §12, §14)", () => {
  it("link secrets and codes appear in neither the server log nor full database statement logs", { timeout: 60_000 }, async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const sql = (statement: string) =>
      execFileSync("docker", ["exec", DB_CONTAINER, "psql", "-U", "supabase_admin", "-d", "postgres", "-Atqc", statement]);
    sql("alter system set log_statement = 'all'");
    sql("select pg_reload_conf()");
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const creator = await Device.create(newNetwork().ip());
      const link = await creator.createLink((await creator.postText("logged?")).id, { shortCode: {} });
      const code = link.shortCode!.code.replace("-", "");
      const viewer = new Viewer();
      expect((await viewer.unlock(link.id, link.secret)).status).toBe(200);
      expect((await new Viewer().unlock(link.id, `${link.secret.slice(0, -1)}A`)).status).toBe(404);
      expect((await new Viewer().resolve(link.shortCode!.code)).status).toBe(200);
      const session = viewer.cookie!.split("=")[1]!;
      await new Promise((resolve) => setTimeout(resolve, 500));

      const dbLog = spawnSync("docker", ["logs", "--since", since, DB_CONTAINER], { encoding: "utf8" });
      const statements = `${dbLog.stdout}${dbLog.stderr}`;
      expect(statements).toContain("app.share_links"); // control: statements were logged
      const serverLog = readFileSync(stack().serverLog, "utf8");
      for (const value of [link.secret, code, link.shortCode!.code, session]) {
        expect(statements).not.toContain(value);
        expect(serverLog).not.toContain(value);
      }
    } finally {
      sql("alter system reset log_statement");
      sql("select pg_reload_conf()");
    }
  });
});
