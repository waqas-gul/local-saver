import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCAL } from "../../scripts/local-stack.cjs";
import { adminDb, closeAdminDb, Device, newNetwork, setFlag, setLargeNetworkCap, Viewer } from "./support/api";

/**
 * T-037 (AC-3.1): 50 simultaneous claims of one burn-after-download share → exactly one winner,
 * at the SQL level (50 real connections released together, which the app's 5-connection pool
 * can't produce) and through the API (50 devices, and 25 devices + 25 link viewers). A mutation
 * check proves the tests catch a claim that doesn't require status = 'active' (phase 3 §17.15).
 */

const CLAIMS = 50;
const ROUNDS = 20;

beforeAll(async () => {
  await setFlag("free_burn_after_download", true);
  // 51 devices on one network would make it too_large (Q-029 cap, 50): local sharing would be off.
  await setLargeNetworkCap(200);
});
afterAll(async () => {
  await setFlag("free_burn_after_download", false);
  await setLargeNetworkCap(50);
  await closeAdminDb();
});

/** An active burn share (link-only, no network) with one verified file, written directly. */
async function burnShareInDb(): Promise<{ shareId: string; fileId: string }> {
  const shareId = randomUUID();
  const fileId = randomUUID();
  await adminDb().query(
    `insert into app.shares (id, scope, kind, billing_subject_type, billing_subject_id, status, retention_class, expires_at,
                             burn_after_download, file_count, total_bytes, entitlement_snapshot)
     values ($1, 'link_only', 'files', 'user', $2, 'active', 'd7', now() + interval '1 day', true, 1, 10, '{"historyRetentionDays": 30}')`,
    [shareId, randomUUID()],
  );
  await adminDb().query(
    `insert into app.files (id, share_id, object_key, original_name, declared_mime, stored_content_type, declared_size_bytes,
                            size_bytes, upload_status, upload_expires_at)
     values ($1, $2, $3, 'race.bin', 'application/octet-stream', 'application/octet-stream', 10, 10,
             'verified', now() + interval '2 hours')`,
    [fileId, shareId, `d7/2026/10/16/${fileId}`],
  );
  return { shareId, fileId };
}

/** 50 app_server connections that all wait on one advisory lock, then claim at the same instant. */
async function raceInSql(shareId: string, fileId: string): Promise<string[]> {
  const lockKey = Math.floor(Math.random() * 2 ** 31);
  const gate = new pg.Client({ connectionString: LOCAL.adminDatabaseUrl });
  await gate.connect();
  const clients = await Promise.all(
    Array.from({ length: CLAIMS }, async () => {
      const client = new pg.Client({ connectionString: LOCAL.appServerDatabaseUrl });
      await client.connect();
      return client;
    }),
  );
  try {
    await gate.query("select pg_advisory_lock($1)", [lockKey]);
    const claims = clients.map(async (client) => {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock_shared($1)", [lockKey]);
      const { rows } = await client.query(
        "select outcome from app.claim_burn_share($1, $2, 'file', $3, $4, null, null, 60, null)",
        [shareId, fileId, randomUUID(), randomUUID()],
      );
      await client.query("commit");
      return rows[0].outcome as string;
    });
    // Release the gate only once every connection is waiting on it.
    for (let i = 0; i < 200; i++) {
      const { rows } = await gate.query(
        "select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = $1 and not granted",
        [lockKey],
      );
      if (rows[0].n === CLAIMS) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await gate.query("select pg_advisory_unlock($1)", [lockKey]);
    return await Promise.all(claims);
  } finally {
    await Promise.all(clients.map((c) => c.end()));
    await gate.end();
  }
}

function tally(outcomes: (string | number)[]): Record<string, number> {
  return outcomes.reduce<Record<string, number>>((acc, o) => ({ ...acc, [String(o)]: (acc[String(o)] ?? 0) + 1 }), {});
}

/** The claim function as migrated, and a copy without `status = 'active'` (the mutation). */
function claimFunctionSql(mutated: boolean): string {
  const migration = readFileSync("supabase/migrations/20261016120100_phase3_burn.sql", "utf8");
  const start = migration.indexOf("create function app.claim_burn_share(");
  const end = migration.indexOf("$$;", migration.indexOf("as $$", start)) + 3;
  let fn = migration.slice(start, end).replace("create function", "create or replace function");
  if (mutated) {
    const guarded = "     and s.status = 'active'\n";
    if (!fn.includes(guarded)) throw new Error("the claim's status guard moved: update the mutation check");
    fn = fn.replace(guarded, "");
  }
  return `set role app_owner; ${fn} reset role;`;
}

async function withMutatedClaim(run: () => Promise<void>): Promise<void> {
  await adminDb().query(claimFunctionSql(true));
  try {
    await run();
  } finally {
    await adminDb().query(claimFunctionSql(false));
  }
}

describe("T-037: exactly one winner (SQL level, 50 connections)", () => {
  it(`50 simultaneous claims, ${ROUNDS} rounds: one claimed, 49 already_downloaded, one burn_claimed row`, { timeout: 180_000 }, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { shareId, fileId } = await burnShareInDb();
      const outcomes = await raceInSql(shareId, fileId);
      expect(tally(outcomes), `round ${round}`).toEqual({ claimed: 1, already_downloaded: CLAIMS - 1 });
      const { rows } = await adminDb().query(
        "select event, count(*)::int as n from app.downloads where share_id = $1 group by event",
        [shareId],
      );
      expect(rows, `round ${round}`).toEqual([{ event: "burn_claimed", n: 1 }]);
      const share = await adminDb().query("select status, claimed_by_user_id is not null as has_claimant from app.shares where id = $1", [shareId]);
      expect(share.rows[0]).toEqual({ status: "claimed", has_claimant: true });
    }
  });

  it("the claim refuses stricter isolation, where the losers would fail with 40001 instead of losing cleanly", async () => {
    const { shareId, fileId } = await burnShareInDb();
    const client = new pg.Client({ connectionString: LOCAL.appServerDatabaseUrl });
    await client.connect();
    try {
      for (const level of ["repeatable read", "serializable"]) {
        await client.query(`begin isolation level ${level}`);
        await expect(
          client.query("select * from app.claim_burn_share($1, $2, 'file', $3, $4, null, null, 60, null)", [shareId, fileId, randomUUID(), randomUUID()]),
        ).rejects.toMatchObject({ code: "25001" });
        await client.query("rollback");
      }
    } finally {
      await client.end();
    }
  });

  it("mutation check: without status = 'active' in the claim, the SQL race finds more than one winner", { timeout: 60_000 }, async () => {
    await withMutatedClaim(async () => {
      const { shareId, fileId } = await burnShareInDb();
      const outcomes = await raceInSql(shareId, fileId);
      expect(tally(outcomes).claimed ?? 0).toBeGreaterThan(1);
    });
    // Restored: one winner again.
    const { shareId, fileId } = await burnShareInDb();
    expect(tally(await raceInSql(shareId, fileId))).toEqual({ claimed: 1, already_downloaded: CLAIMS - 1 });
  });
});

describe("T-037: exactly one winner (API level)", () => {
  async function burnFileOnNetwork() {
    const net = newNetwork();
    const creator = await Device.create(net.ip());
    const { init, upload, complete } = await creator.uploadFile("burn.bin", new Uint8Array([1, 2, 3]), "application/octet-stream", 3, "network", {
      burnAfterDownload: true,
    });
    expect(complete.status).toBe(200);
    return { net, creator, shareId: init.body.share.id as string, fileId: upload.fileId };
  }

  async function devices(n: number, ip: () => string): Promise<Device[]> {
    const out: Device[] = [];
    for (let i = 0; i < n; i += 10) out.push(...(await Promise.all(Array.from({ length: Math.min(10, n - i) }, () => Device.create(ip())))));
    return out;
  }

  it("50 devices on the network download at once: one 200, 49 × 410 ALREADY_DOWNLOADED", { timeout: 180_000 }, async () => {
    const { net, shareId, fileId } = await burnFileOnNetwork();
    const crowd = await devices(CLAIMS, () => net.ip());
    const responses = await Promise.all(crowd.map((d) => d.call("POST", `/api/v1/files/${fileId}/download-url`, { confirm: true })));
    expect(tally(responses.map((r) => r.status))).toEqual({ 200: 1, 410: CLAIMS - 1 });
    for (const r of responses.filter((r) => r.status === 410)) expect(r.body.error).toMatchObject({ code: "ALREADY_DOWNLOADED", details: { byYou: false } });
    const winner = responses.find((r) => r.status === 200)!;
    expect(winner.body.burn.left).toBe(2);
    const { rows } = await adminDb().query("select event, count(*)::int as n from app.downloads where share_id = $1 group by event", [shareId]);
    expect(rows).toEqual([{ event: "burn_claimed", n: 1 }]);
  });

  it("25 devices and 25 link viewers at once (mixed claimants): exactly one winner", { timeout: 180_000 }, async () => {
    const { net, creator, shareId, fileId } = await burnFileOnNetwork();
    const link = await creator.createLink(shareId);
    const crowd = await devices(25, () => net.ip());
    const viewers = Array.from({ length: 25 }, () => new Viewer());
    for (const v of viewers) expect((await v.unlock(link.id, link.secret)).status).toBe(200);
    const responses = await Promise.all([
      ...crowd.map((d) => d.call("POST", `/api/v1/files/${fileId}/download-url`, { confirm: true })),
      ...viewers.map((v) => v.fileUrl(link.id, fileId, "download-url", { confirm: true })),
    ]);
    expect(tally(responses.map((r) => r.status))).toEqual({ 200: 1, 410: CLAIMS - 1 });
    const { rows } = await adminDb().query("select count(*)::int as n from app.downloads where share_id = $1 and event = 'burn_claimed'", [shareId]);
    expect(rows[0].n).toBe(1);
  });

  it("T3-01: the claimant's 10 parallel retries give exactly 3 URLs for the file", { timeout: 60_000 }, async () => {
    const { net, shareId, fileId } = await burnFileOnNetwork();
    const claimant = await Device.create(net.ip());
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => claimant.call("POST", `/api/v1/files/${fileId}/download-url`, { confirm: true })),
    );
    expect(tally(responses.map((r) => r.status))).toEqual({ 200: 3, 409: 7 });
    for (const r of responses.filter((r) => r.status === 409)) expect(r.body.error.code).toBe("BURN_RETRY_LIMIT");
    const { rows } = await adminDb().query(
      "select count(*)::int as n from app.downloads where share_id = $1 and event in ('burn_claimed', 'burn_retry')",
      [shareId],
    );
    expect(rows[0].n).toBe(3);
  });

  it("mutation check: without status = 'active' in the claim, the API race finds more than one winner", { timeout: 180_000 }, async () => {
    const { net, fileId } = await burnFileOnNetwork();
    const crowd = await devices(20, () => net.ip());
    await withMutatedClaim(async () => {
      const responses = await Promise.all(crowd.map((d) => d.call("POST", `/api/v1/files/${fileId}/download-url`, { confirm: true })));
      expect(responses.filter((r) => r.status === 200).length).toBeGreaterThan(1);
    });
  });
});
