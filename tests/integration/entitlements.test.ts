import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { authAdmin, currentSession } from "./support/accounts";
import { adminDb, api, closeAdminDb, Device, newNetwork, PNG_BYTES, setFlag, Viewer, type ApiResponse } from "./support/api";
import {
  accountDevice,
  counter,
  DAY,
  fileInit,
  GIB,
  grantOverride,
  KIB,
  MIB,
  proDevice,
  revokeOverride,
  setCounter,
  setStorageUsed,
  subscribe,
} from "./support/entitlements";

/**
 * Entitlements through the API (phase 4 §17.6, §17.16, §17.19.2): the enforcement matrix rows whose
 * write paths exist today (T4-E1 … E5, E7 … E10, E13 … E16, E26 … E30), each with a positive (Pro or
 * the allowed value), a negative (Free, or one over) and a boundary case (exactly at the limit);
 * resolution (T4-EN1, EN2), snapshots (EN3), /me/entitlements against enforcement (EN4), spoofing
 * (EN5) and the downgrade rows of §17.16 (T-051). Pro comes from an operator override (P4-09) or a
 * subscription row, never from the client. E6, E11, E12, E17 … E25 and E31 arrive with their
 * features (4C, 4D): their plan values are checked in tests/unit/entitlements.test.ts.
 */

afterAll(closeAdminDb);

const text = (d: Device, content: string, extra: Record<string, unknown> = {}) =>
  d.call("POST", "/api/v1/texts", { destination: "network", content, ...extra });
const init = (d: Device, files: { name?: string; size: number; type?: string }[], extra: Record<string, unknown> = {}) =>
  d.call("POST", "/api/v1/shares", fileInit(files, extra));
const entitlements = async (d: Device) => (await d.call("GET", "/api/v1/me/entitlements")).body;
const error = (r: ApiResponse) => r.body?.error;

async function shareRow(id: string) {
  const { rows } = await adminDb().query("select status, retention_class, expires_at, burn_after_download, entitlement_snapshot from app.shares where id = $1", [id]);
  return rows[0];
}

async function spaceOf(d: Device): Promise<string> {
  const [space] = (await d.observe()).spaceIds;
  if (!space) throw new Error("no space");
  return space;
}

describe("E1 file size (T4-E1)", () => {
  // Phase 4D (P4-14) lifts DV4-17: above 100 MiB, Pro's files go up in parts (multipart.test.ts covers the upload).
  it("Free: 100 MiB, one byte more refused with the upgrade hint; Pro: 5 GiB, one byte more refused", async () => {
    const free = await Device.create(newNetwork().ip());
    const { device: pro } = await proDevice();
    expect((await init(free, [{ size: 100 * MIB }])).status).toBe(201);
    const over = await init(free, [{ size: 100 * MIB + 1 }]);
    expect(over.status).toBe(413);
    expect(error(over)).toMatchObject({ code: "FILE_TOO_LARGE", details: { maxFileBytes: 100 * MIB, requiredPlan: "pro" } });

    expect((await init(pro, [{ size: 100 * MIB + 1 }])).status).toBe(201);
    expect((await init(pro, [{ size: 5 * 1024 * MIB }])).status).toBe(201);
    const proOver = await init(pro, [{ size: 5 * 1024 * MIB + 1 }]);
    expect(proOver.status).toBe(413);
    expect(error(proOver)).toMatchObject({ code: "FILE_TOO_LARGE", details: { maxFileBytes: 5 * 1024 * MIB } });
    expect(error(proOver).details.requiredPlan).toBeUndefined();
    expect((await entitlements(pro)).limits.maxFileBytes).toBe(5 * 1024 * MIB);
    expect((await entitlements(free)).limits.maxFileBytes).toBe(100 * MIB);
  });
});

describe("E2 files per share (T4-E2)", () => {
  it("Free: 20 files, not 21 (with the upgrade hint); Pro: 21 and exactly 100", async () => {
    const free = await Device.create(newNetwork().ip());
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `n${i}.txt`, size: 1, type: "text/plain" }));
    expect((await init(free, many(20))).status).toBe(201);
    const refused = await init(free, many(21));
    expect(refused.status).toBe(413);
    expect(error(refused)).toMatchObject({ code: "TOO_MANY_FILES", details: { maxFiles: 20, requiredPlan: "pro" } });

    const { device: pro } = await proDevice();
    expect((await init(pro, many(21))).status).toBe(201);
    expect((await init(pro, many(100))).status).toBe(201);
    // Above Pro's 100, the request schema refuses it before any plan check.
    expect((await init(pro, many(101))).status).toBe(400);
  });
});

describe("E3 text size at creation (T4-E3)", () => {
  it("Free: 100 KiB, not one byte more (with the hint); Pro: up to exactly 1 MiB, not more (no hint)", async () => {
    const free = await Device.create(newNetwork().ip());
    expect((await text(free, "x".repeat(100 * KIB))).status).toBe(201);
    const refused = await text(free, "x".repeat(100 * KIB + 1));
    expect(refused.status).toBe(413);
    expect(error(refused)).toMatchObject({ code: "TEXT_TOO_LARGE", details: { maxBytes: 100 * KIB, requiredPlan: "pro" } });

    const { device: pro } = await proDevice();
    expect((await text(pro, "x".repeat(100 * KIB + 1))).status).toBe(201);
    expect((await text(pro, "x".repeat(MIB))).status).toBe(201);
    const over = await text(pro, "x".repeat(MIB + 1));
    expect(over.status).toBe(413);
    expect(error(over)).toEqual(expect.objectContaining({ code: "TEXT_TOO_LARGE", details: { maxBytes: MIB } }));
  });
});

describe("E4 text edits follow the share's snapshot (T4-E4, D4-12)", () => {
  it("a Pro text stays editable up to 1 MiB after a downgrade, and no further", async () => {
    const pro = await proDevice();
    const created = await text(pro.device, "x".repeat(500 * KIB));
    expect(created.status).toBe(201);
    await pro.downgrade();
    const edit = (content: string, version: number) => pro.device.call("PATCH", `/api/v1/shares/${created.body.share.id}/text`, { content, version });
    const edited = await edit("y".repeat(600 * KIB), 1);
    expect(edited.status, edited.text.slice(0, 200)).toBe(200);
    expect((await edit("z".repeat(MIB), 2)).status).toBe(200);
    const over = await edit("z".repeat(MIB + 1), 3);
    expect(over.status).toBe(413);
    expect(error(over).details).toEqual({ maxBytes: MIB });
    // New texts follow the current plan: Free again.
    expect((await text(pro.device, "x".repeat(100 * KIB + 1))).status).toBe(413);
  });

  it("a Free text stays at 100 KiB after an upgrade, and an over-limit edit carries no upgrade hint", async () => {
    const account = await accountDevice();
    const created = await text(account.device, "short");
    await grantOverride(account.userId);
    const edit = await account.device.call("PATCH", `/api/v1/shares/${created.body.share.id}/text`, { content: "x".repeat(100 * KIB + 1), version: 1 });
    expect(edit.status).toBe(413);
    expect(error(edit).details).toEqual({ maxBytes: 100 * KIB });
    expect((await account.device.call("PATCH", `/api/v1/shares/${created.body.share.id}/text`, { content: "x".repeat(100 * KIB), version: 1 })).status).toBe(200);
  });
});

describe("E5 share expiry options (T4-E5)", () => {
  it("Free: 7 days at most, 30 days refused with the hint", async () => {
    const free = await Device.create(newNetwork().ip());
    expect((await text(free, "week", { expiresIn: 7 * DAY })).status).toBe(201);
    const month = await text(free, "month", { expiresIn: 30 * DAY });
    expect(month.status).toBe(422);
    expect(error(month)).toMatchObject({ code: "EXPIRY_NOT_ALLOWED", details: { allowed: [3600, DAY, 7 * DAY], requiredPlan: "pro" } });
  });

  it("Pro: 30 and 90 days, kept in the d30 and d90 classes; 29 and 91 days refused", async () => {
    const { device: pro } = await proDevice();
    const month = await init(pro, [{ size: 5 }], { expiresIn: 30 * DAY });
    expect(month.status).toBe(201);
    expect(decodeURIComponent(new URL(month.body.uploads[0].url).pathname)).toMatch(/\/d30\/\d{4}\/\d{2}\/\d{2}\//);
    expect((await shareRow(month.body.share.id)).retention_class).toBe("d30");
    const quarter = await text(pro, "quarter", { expiresIn: 90 * DAY });
    expect(quarter.status).toBe(201);
    const row = await shareRow(quarter.body.share.id);
    expect(row.retention_class).toBe("d90");
    expect(new Date(row.expires_at).getTime() - Date.now()).toBeGreaterThan(89 * DAY * 1000);
    for (const seconds of [29 * DAY, 91 * DAY]) {
      const refused = await text(pro, "odd", { expiresIn: seconds });
      expect(refused.status).toBe(422);
      expect(error(refused).details.requiredPlan).toBeUndefined();
    }
  });
});

describe("E7 storage quota (T4-E7)", () => {
  it("Free: exactly full is accepted, one byte over refused with the hint", async () => {
    const free = await Device.create(newNetwork().ip());
    await setStorageUsed(free.userId, 2 * GIB - 10);
    const over = await init(free, [{ size: 11 }]);
    expect(over.status).toBe(409);
    expect(error(over)).toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED", details: { usedBytes: 2 * GIB - 10, quotaBytes: 2 * GIB, requiredPlan: "pro" } });
    expect((await init(free, [{ size: 10 }])).status).toBe(201);
  });

  it("Pro: 100 GiB; beyond Free's quota is fine, exactly full is accepted, one byte over is refused without a hint", async () => {
    const pro = await proDevice();
    await setStorageUsed(pro.userId, 5 * GIB);
    expect((await init(pro.device, [{ size: KIB }])).status).toBe(201);
    await setStorageUsed(pro.userId, 100 * GIB - 10 - KIB);
    const over = await init(pro.device, [{ size: 11 }]);
    expect(over.status).toBe(409);
    expect(error(over).details).toEqual({ usedBytes: 100 * GIB - 10, quotaBytes: 100 * GIB });
    expect((await init(pro.device, [{ size: 10 }])).status).toBe(201);
  });

  it("parallel uploads at the edge of the Pro quota never exceed it", async () => {
    const pro = await proDevice();
    await setStorageUsed(pro.userId, 100 * GIB - 10 * KIB);
    const results = await Promise.all(Array.from({ length: 15 }, () => init(pro.device, [{ size: KIB }])));
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    const { rows } = await adminDb().query("select bytes_committed + bytes_reserved as used from app.storage_usage where subject_id = $1", [pro.userId]);
    expect(Number(rows[0].used)).toBe(100 * GIB);
  });

  it("after a downgrade, usage above the Free quota blocks uploads and deletes nothing (07 §5)", async () => {
    const pro = await proDevice();
    const kept = await text(pro.device, "kept after the downgrade");
    await setStorageUsed(pro.userId, 3 * GIB);
    expect((await init(pro.device, [{ size: KIB }])).status).toBe(201);
    await pro.downgrade();
    const refused = await init(pro.device, [{ size: 1 }]);
    expect(refused.status).toBe(409);
    expect(error(refused).details).toMatchObject({ quotaBytes: 2 * GIB, requiredPlan: "pro" });
    expect((await shareRow(kept.body.share.id)).status).toBe("active");
    const { rows } = await adminDb().query("select bytes_committed from app.storage_usage where subject_id = $1", [pro.userId]);
    expect(Number(rows[0].bytes_committed)).toBe(3 * GIB);
  });
});

describe("E8 daily upload volume per user (T4-E8, C4-6)", () => {
  const userKey = (userId: string) => `upload_kib:user:${userId}`;
  const FREE_KIB = (2 * GIB) / KIB;
  const PRO_KIB = (200 * GIB) / KIB;

  it("Free: up to exactly 2 GiB a day, then 429 with Retry-After", async () => {
    const free = await Device.create(newNetwork().ip());
    await setCounter(userKey(free.userId), "1 day", FREE_KIB - 1);
    expect((await init(free, [{ size: KIB }])).status).toBe(201);
    const refused = await init(free, [{ size: 1 }]);
    expect(refused.status).toBe(429);
    expect(error(refused).code).toBe("DAILY_UPLOAD_LIMIT");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await counter(userKey(free.userId), "1 day")).toBe(FREE_KIB);
  });

  it("Pro: 200 GiB a day, so Free's whole budget spent changes nothing; exactly 200 GiB, then 429", async () => {
    const pro = await proDevice();
    await setCounter(userKey(pro.userId), "1 day", FREE_KIB + 5);
    expect((await init(pro.device, [{ size: KIB }])).status).toBe(201);
    await setCounter(userKey(pro.userId), "1 day", PRO_KIB - 1);
    expect((await init(pro.device, [{ size: KIB }])).status).toBe(201);
    expect((await init(pro.device, [{ size: 1 }])).status).toBe(429);
  });

  it("is charged only after the storage is reserved: a refused attempt costs nothing", async () => {
    const free = await Device.create(newNetwork().ip());
    await setCounter(userKey(free.userId), "1 day", 100);
    await setStorageUsed(free.userId, 2 * GIB);
    expect((await init(free, [{ size: 50 * MIB }])).status).toBe(409);
    expect((await init(free, [{ size: 100 * MIB + 1 }])).status).toBe(413);
    expect((await init(free, [{ size: 1 }], { expiresIn: 30 * DAY })).status).toBe(422);
    expect(await counter(userKey(free.userId), "1 day")).toBe(100);
  });

  it("a network limit refusal rolls the user's charge back too", async () => {
    const free = await Device.create(newNetwork().ip());
    const space = await spaceOf(free);
    await setCounter(`upload_kib:net:${space}`, "1 day", (10 * GIB) / KIB);
    await setCounter(userKey(free.userId), "1 day", 7);
    expect((await init(free, [{ size: KIB }])).status).toBe(429);
    expect(await counter(userKey(free.userId), "1 day")).toBe(7);
    const { rows } = await adminDb().query("select count(*)::int as n from app.shares where created_by_user_id = $1", [free.userId]);
    expect(rows[0].n).toBe(0);
  });

  it("is refunded when the upload is rejected or cancelled, not when a finished share is deleted", async () => {
    const free = await Device.create(newNetwork().ip());
    const key = userKey(free.userId);
    // Rejected at completion: the stored object isn't the declared one.
    const lying = await init(free, [{ size: 10 * KIB }]);
    expect(await counter(key, "1 day")).toBe(10);
    const target = lying.body.uploads[0];
    await fetch(target.url, { method: "PUT", headers: { ...target.headers, "content-length": String(10 * KIB) }, body: Buffer.alloc(10 * KIB, 1) });
    await adminDb().query("update app.files set declared_size_bytes = declared_size_bytes + 1 where id = $1", [target.fileId]);
    const rejected = await free.call("POST", `/api/v1/shares/${lying.body.share.id}/files/${target.fileId}/complete`, {});
    expect(rejected.status).toBe(422);
    expect(await counter(key, "1 day")).toBe(0);
    // Cancelled before the bytes arrived.
    const cancelled = await init(free, [{ size: 3 * KIB }]);
    expect(await counter(key, "1 day")).toBe(3);
    expect((await free.call("DELETE", `/api/v1/shares/${cancelled.body.share.id}`)).status).toBe(204);
    expect(await counter(key, "1 day")).toBe(0);
    // A finished share was uploaded: deleting it refunds nothing.
    const done = await free.uploadFile("done.bin", new Uint8Array(2 * KIB));
    expect(done.complete.status).toBe(200);
    expect((await free.call("DELETE", `/api/v1/shares/${done.init.body.share.id}`)).status).toBe(204);
    expect(await counter(key, "1 day")).toBe(2);
  });

  it("parallel inits at the edge of the daily budget never exceed it", async () => {
    const free = await Device.create(newNetwork().ip());
    await setCounter(userKey(free.userId), "1 day", FREE_KIB - 5);
    const results = await Promise.all(Array.from({ length: 10 }, () => init(free, [{ size: KIB }])));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(5);
    expect(await counter(userKey(free.userId), "1 day")).toBe(FREE_KIB);
  });
});

describe("E9 daily upload volume per network (T4-E9, D4-10)", () => {
  it("Free is refused on a network at its cap, exactly at the cap is fine; Pro isn't counted per network", async () => {
    const net = newNetwork();
    const free = await Device.create(net.ip());
    const space = await spaceOf(free);
    const netKey = `upload_kib:net:${space}`;
    await setCounter(netKey, "1 day", (10 * GIB) / KIB - 1);
    expect((await init(free, [{ size: KIB }])).status).toBe(201);
    expect((await init(free, [{ size: 1 }])).status).toBe(429);

    const pro = await proDevice(net.ip());
    expect(await spaceOf(pro.device)).toBe(space);
    expect((await init(pro.device, [{ size: 4 * KIB }])).status).toBe(201);
    expect(await counter(netKey, "1 day")).toBe((10 * GIB) / KIB);
    expect(await counter(`upload_kib:user:${pro.userId}`, "1 day")).toBe(4);
  });
});

describe("E10 burn after download at creation (T4-E10)", () => {
  it("Pro may; Free may not (hint) unless the beta flag is on; the kill switch stops Pro too", async () => {
    const free = await Device.create(newNetwork().ip());
    const refused = await text(free, "burn", { burnAfterDownload: true });
    expect(refused.status).toBe(403);
    expect(error(refused)).toMatchObject({ code: "FEATURE_NOT_IN_PLAN", details: { feature: "burnAfterDownload", requiredPlan: "pro" } });

    const { device: pro } = await proDevice();
    const burn = await text(pro, "pro burn", { burnAfterDownload: true });
    expect(burn.status).toBe(201);
    expect((await shareRow(burn.body.share.id)).entitlement_snapshot).toMatchObject({ v: 2, plan: "pro", features: { burnAfterDownload: true } });
    expect((await entitlements(pro)).features.burnAfterDownload).toBe(true);

    await setFlag("free_burn_after_download", true);
    try {
      expect((await text(free, "beta burn", { burnAfterDownload: true })).status).toBe(201);
    } finally {
      await setFlag("free_burn_after_download", false);
    }
    await setFlag("burn_after_download_enabled", false);
    try {
      const paused = await text(pro, "paused", { burnAfterDownload: true });
      expect(paused.status).toBe(503);
      expect((await entitlements(pro)).features.burnAfterDownload).toBe(false);
    } finally {
      await setFlag("burn_after_download_enabled", true);
    }
  });
});

describe("E13 link expiry and E14 short-code lifetime (T4-E13, T4-E14)", () => {
  it("Pro links may last 30 or 90 days, never past the share; Free's 30 days is refused with the hint", async () => {
    const { device: pro } = await proDevice();
    const share = (await text(pro, "for a month", { expiresIn: 90 * DAY })).body.share.id;
    const month = await pro.call("POST", `/api/v1/shares/${share}/links`, { expiresIn: 30 * DAY });
    expect(month.status).toBe(201);
    // 90 days from now ends after the share (created a moment earlier): refused by the share's expiry.
    const quarter = await pro.call("POST", `/api/v1/shares/${share}/links`, { expiresIn: 90 * DAY });
    expect(quarter.status).toBe(422);
    expect(error(quarter).details).toEqual({ reason: "after_share_expiry" });

    const free = await Device.create(newNetwork().ip());
    const freeShare = (await text(free, "a week", { expiresIn: 7 * DAY })).body.share.id;
    expect((await free.call("POST", `/api/v1/shares/${freeShare}/links`, { expiresIn: DAY })).status).toBe(201);
    const refused = await free.call("POST", `/api/v1/shares/${freeShare}/links`, { expiresIn: 30 * DAY });
    expect(refused.status).toBe(422);
    expect(error(refused).details).toMatchObject({ requiredPlan: "pro" });
  });

  it("Pro codes may last 7 days but never past the link; Free's 7 days is refused, 24 hours is the edge", async () => {
    const { device: pro } = await proDevice();
    const share = (await text(pro, "codes", { expiresIn: 30 * DAY })).body.share.id;
    const week = await pro.call("POST", `/api/v1/shares/${share}/links`, { shortCode: { expiresIn: 7 * DAY } });
    expect(week.status).toBe(201);
    const codeLife = Date.parse(week.body.link.shortCode.expiresAt) - Date.now();
    expect(codeLife).toBeGreaterThan(7 * DAY * 1000 - 60_000);
    expect(codeLife).toBeLessThanOrEqual(7 * DAY * 1000);
    const shortLink = await pro.call("POST", `/api/v1/shares/${share}/links`, { expiresIn: DAY, shortCode: { expiresIn: 7 * DAY } });
    expect(shortLink.body.link.shortCode.expiresAt).toBe(shortLink.body.link.expiresAt);

    const free = await Device.create(newNetwork().ip());
    const freeShare = (await text(free, "free codes")).body.share.id;
    expect((await free.call("POST", `/api/v1/shares/${freeShare}/links`, { shortCode: { expiresIn: DAY } })).status).toBe(201);
    const refused = await free.call("POST", `/api/v1/shares/${freeShare}/links`, { shortCode: { expiresIn: 7 * DAY } });
    expect(refused.status).toBe(422);
    expect(error(refused).details).toMatchObject({ requiredPlan: "pro" });
  });

  it("after a downgrade, new links and codes on existing links follow Free's options (D4-12)", async () => {
    const pro = await proDevice();
    const share = (await text(pro.device, "downgraded", { expiresIn: 90 * DAY })).body.share.id;
    const link = await pro.device.createLink(share, { expiresIn: 30 * DAY, shortCode: { expiresIn: 7 * DAY } });
    await pro.downgrade();
    expect((await pro.device.call("POST", `/api/v1/shares/${share}/links`, { expiresIn: 30 * DAY })).status).toBe(422);
    const regenerated = await pro.device.call("POST", `/api/v1/links/${link.id}/code`, { expiresIn: 7 * DAY });
    expect(regenerated.status).toBe(422);
    expect((await pro.device.call("POST", `/api/v1/links/${link.id}/code`, { expiresIn: DAY })).status).toBe(200);
    // "Until the share expires" stays available: the share itself keeps its 90 days.
    const untilShare = await pro.device.call("POST", `/api/v1/shares/${share}/links`, {});
    expect(untilShare.status).toBe(201);
    expect(Date.parse(untilShare.body.link.expiresAt) - Date.now()).toBeGreaterThan(89 * DAY * 1000);
  });
});

describe("E15 viewer URLs per link per day follow the link's snapshot (T4-E15)", () => {
  it("a Pro link allows exactly 10,000 a day, and keeps that after a downgrade", async () => {
    const pro = await proDevice();
    const file = await pro.device.uploadFile("pro.png", PNG_BYTES, "image/png");
    const link = await pro.device.createLink(file.init.body.share.id);
    await pro.downgrade();
    const viewer = new Viewer();
    expect((await viewer.unlock(link.id, link.secret)).status).toBe(200);
    await setCounter(`linkUrlsDay:${link.id}`, "1 day", 9_999);
    expect((await viewer.fileUrl(link.id, file.upload.fileId)).status).toBe(200);
    const capped = await viewer.fileUrl(link.id, file.upload.fileId);
    expect(capped.status).toBe(429);
    expect(error(capped).code).toBe("LINK_DAILY_LIMIT");
  });

  it("a Free link stops at 500", async () => {
    const free = await Device.create(newNetwork().ip());
    const file = await free.uploadFile("free.png", PNG_BYTES, "image/png");
    const link = await free.createLink(file.init.body.share.id);
    const viewer = new Viewer();
    await viewer.unlock(link.id, link.secret);
    await setCounter(`linkUrlsDay:${link.id}`, "1 day", 499);
    expect((await viewer.fileUrl(link.id, file.upload.fileId)).status).toBe(200);
    expect((await viewer.fileUrl(link.id, file.upload.fileId)).status).toBe(429);
  });
});

describe("E16 executables in remote links stay blocked on Pro (T4-E16, D4-11)", () => {
  it("Pro can't post a program as Link only, nor make a link to one shared on the network", async () => {
    const { device: pro } = await proDevice();
    const linkOnly = await init(pro, [{ name: "setup.exe", size: 10 }], { destination: "link_only" });
    expect(linkOnly.status).toBe(422);
    expect(error(linkOnly)).toMatchObject({ code: "REMOTE_FILE_BLOCKED" });
    const exe = await pro.uploadFile("tool.exe", new Uint8Array([0x4d, 0x5a, 0, 0]), "application/octet-stream");
    expect(exe.complete.status).toBe(200);
    const link = await pro.call("POST", `/api/v1/shares/${exe.init.body.share.id}/links`, {});
    expect(link.status).toBe(422);
    expect(error(link).code).toBe("REMOTE_FILE_BLOCKED");
  });
});

describe("E26 signed-in devices (T4-E26, D4-5)", () => {
  it("the device cap comes from the entitlements: 10 for Free and Pro accounts", async () => {
    const free = await accountDevice();
    const { device: pro } = await proDevice();
    for (const d of [free.device, pro]) {
      expect((await d.call("GET", "/api/v1/me/devices")).body.maxDevices).toBe(10);
      expect((await entitlements(d)).limits.maxSignedInDevices).toBe(10);
    }
  });
});

describe("E27 preview size follows the share's and the link's snapshot (T4-E27)", () => {
  it("a smaller preview limit in the snapshot turns previews off for that share and that link only", async () => {
    const creator = await Device.create(newNetwork().ip());
    const image = await creator.uploadFile("p.png", PNG_BYTES, "image/png");
    const shareId = image.init.body.share.id;
    const link = await creator.createLink(shareId);
    const viewer = new Viewer();
    expect((await viewer.unlock(link.id, link.secret)).body.share.files[0].previewable).toBe(true);
    expect((await creator.call("POST", `/api/v1/files/${image.upload.fileId}/preview-url`, {})).status).toBe(200);

    const setShareLimit = (bytes: number) =>
      adminDb().query("update app.shares set entitlement_snapshot = jsonb_set(entitlement_snapshot, '{limits,maxPreviewBytes}', to_jsonb($2::int)) where id = $1", [
        shareId,
        bytes,
      ]);
    // Boundary: a file exactly at the snapshot's limit still has a preview; one byte under it doesn't.
    await setShareLimit(PNG_BYTES.length);
    expect((await creator.call("GET", `/api/v1/shares/${shareId}`)).body.share.files[0].previewable).toBe(true);
    expect((await creator.call("POST", `/api/v1/files/${image.upload.fileId}/preview-url`, {})).status).toBe(200);
    await setShareLimit(PNG_BYTES.length - 1);
    expect((await creator.call("GET", `/api/v1/shares/${shareId}`)).body.share.files[0].previewable).toBe(false);
    const preview = await creator.call("POST", `/api/v1/files/${image.upload.fileId}/preview-url`, {});
    expect(preview.status).toBe(422);
    expect(error(preview).code).toBe("PREVIEW_UNAVAILABLE");
    // The link keeps its own snapshot until it is changed too.
    expect((await viewer.content(link.id)).body.share.files[0].previewable).toBe(true);
    await adminDb().query("update app.share_links set entitlement_snapshot = jsonb_set(entitlement_snapshot, '{limits,maxPreviewBytes}', '10') where id = $1", [link.id]);
    expect((await viewer.content(link.id)).body.share.files[0].previewable).toBe(false);
    expect((await viewer.fileUrl(link.id, image.upload.fileId, "preview-url")).status).toBe(422);
  });
});

describe("E28 plan-dependent rate limits (T4-E28, D4-29)", () => {
  it("creating shares: Free stops at 30 an hour, Pro at exactly 300", async () => {
    const free = await Device.create(newNetwork().ip());
    await setCounter(`createShare:${free.userId}`, "1 hour", 30);
    expect((await init(free, [{ size: 1 }])).status).toBe(429);
    const pro = await proDevice();
    await setCounter(`createShare:${pro.userId}`, "1 hour", 30);
    expect((await init(pro.device, [{ size: 1 }])).status).toBe(201);
    await setCounter(`createShare:${pro.userId}`, "1 hour", 299);
    expect((await init(pro.device, [{ size: 1 }])).status).toBe(201);
    const limited = await init(pro.device, [{ size: 1 }]);
    expect(limited.status).toBe(429);
    expect(error(limited).code).toBe("RATE_LIMITED");
  });

  it("creating links: Free stops at 30 an hour, Pro at exactly 300", async () => {
    const free = await Device.create(newNetwork().ip());
    const freeShare = (await free.postText("free links")).id;
    await setCounter(`createLink:${free.userId}`, "1 hour", 30);
    expect((await free.call("POST", `/api/v1/shares/${freeShare}/links`, {})).status).toBe(429);
    const pro = await proDevice();
    const proShare = (await pro.device.postText("pro links")).id;
    await setCounter(`createLink:${pro.userId}`, "1 hour", 299);
    expect((await pro.device.call("POST", `/api/v1/shares/${proShare}/links`, {})).status).toBe(201);
    expect((await pro.device.call("POST", `/api/v1/shares/${proShare}/links`, {})).status).toBe(429);
  });
});

describe("E29 restrictions and kill switches on every publishing write (T4-E29, C4-15)", () => {
  it("an upload-restricted account can't edit a text, issue a new code or complete an upload", async () => {
    const owner = await Device.create(newNetwork().ip());
    const note = await owner.postText("before the restriction");
    const link = await owner.createLink(note.id, { shortCode: {} });
    const pending = await init(owner, [{ size: 3 }]);
    const target = pending.body.uploads[0];
    await fetch(target.url, { method: "PUT", headers: target.headers, body: Buffer.from([1, 2, 3]) });
    // Allowed before (the positive case).
    expect((await owner.call("PATCH", `/api/v1/shares/${note.id}/text`, { content: "edit 1", version: 1 })).status).toBe(200);
    await adminDb().query(
      "insert into app.user_flags (user_id, upload_restricted) values ($1, true) on conflict (user_id) do update set upload_restricted = true",
      [owner.userId],
    );
    for (const response of [
      await owner.call("PATCH", `/api/v1/shares/${note.id}/text`, { content: "edit 2", version: 2 }),
      await owner.call("POST", `/api/v1/links/${link.id}/code`, {}),
      await owner.call("POST", `/api/v1/shares/${pending.body.share.id}/files/${target.fileId}/complete`, {}),
    ]) {
      expect(response.status, response.text.slice(0, 120)).toBe(403);
      expect(error(response).code).toBe("UPLOADS_RESTRICTED");
    }
    // Deleting stays possible: a restricted account can take its content down.
    expect((await owner.call("DELETE", `/api/v1/shares/${note.id}`)).status).toBe(204);
  });

  it("the kill switches stop edits by anonymous users and upload completion", async () => {
    const owner = await Device.create(newNetwork().ip());
    const note = await owner.postText("kill switch");
    const pending = await init(owner, [{ size: 3 }]);
    const target = pending.body.uploads[0];
    await fetch(target.url, { method: "PUT", headers: target.headers, body: Buffer.from([1, 2, 3]) });
    await setFlag("anonymous_uploads_enabled", false);
    try {
      const edit = await owner.call("PATCH", `/api/v1/shares/${note.id}/text`, { content: "paused", version: 1 });
      expect(edit.status).toBe(503);
      expect(error(edit).code).toBe("UPLOADS_DISABLED");
    } finally {
      await setFlag("anonymous_uploads_enabled", true);
    }
    await setFlag("uploads_enabled", false);
    try {
      const complete = await owner.call("POST", `/api/v1/shares/${pending.body.share.id}/files/${target.fileId}/complete`, {});
      expect(complete.status).toBe(503);
    } finally {
      await setFlag("uploads_enabled", true);
    }
    expect((await owner.call("POST", `/api/v1/shares/${pending.body.share.id}/files/${target.fileId}/complete`, {})).status).toBe(200);
  });
});

describe("E30 an account in its deletion grace is read-only (T4-E30, D4-6)", () => {
  it("refuses new shares, texts and links until the deletion is cancelled; edits stay possible", async () => {
    const account = await accountDevice();
    const note = await account.device.postText("before the request");
    await adminDb().query("insert into app.profiles (user_id) values ($1) on conflict do nothing", [account.userId]);
    await adminDb().query("select app.request_account_deletion($1, interval '7 days')", [account.userId]);
    for (const response of [
      await text(account.device, "during the grace"),
      await init(account.device, [{ size: 1 }]),
      await account.device.call("POST", `/api/v1/shares/${note.id}/links`, {}),
    ]) {
      expect(response.status).toBe(403);
      expect(error(response).code).toBe("ACCOUNT_DELETION_PENDING");
    }
    expect((await account.device.call("PATCH", `/api/v1/shares/${note.id}/text`, { content: "edited", version: 1 })).status).toBe(200);
    await adminDb().query("select app.cancel_account_deletion($1)", [account.userId]);
    expect((await text(account.device, "after cancelling")).status).toBe(201);
  });
});

describe("a suspended creator's links grant no new access (C4-15, D4-4)", () => {
  it("new unlocks get 410 and codes 404; a viewer already let in keeps access until the grant ends", async () => {
    const creator = await Device.create(newNetwork().ip());
    const note = await creator.postText("suspended later");
    const link = await creator.createLink(note.id, { shortCode: {} });
    const earlier = new Viewer();
    expect((await earlier.unlock(link.id, link.secret)).status).toBe(200);
    await adminDb().query(
      "insert into app.user_flags (user_id, suspended_at, reason) values ($1, now(), 'test') on conflict (user_id) do update set suspended_at = now()",
      [creator.userId],
    );
    const late = await new Viewer().unlock(link.id, link.secret);
    expect(late.status).toBe(410);
    expect(error(late).code).toBe("LINK_EXPIRED");
    expect((await new Viewer().resolve(link.shortCode!.code)).status).toBe(404);
    expect((await earlier.content(link.id)).status).toBe(200);
    // A wrong secret still looks like any unknown link.
    expect((await new Viewer().unlock(link.id, randomBytes(32).toString("base64url"))).status).toBe(404);
  });
});

describe("resolution: subscriptions and overrides through the API (T4-EN1, T4-EN2)", () => {
  async function planOf(setup: (userId: string) => Promise<unknown>) {
    const account = await accountDevice(newNetwork().ip(), { observe: false });
    await setup(account.userId);
    return entitlements(account.device);
  }

  it("subscriptions: active, trialing, past_due in its grace and canceled before its period end are Pro", async () => {
    expect(await planOf((u) => subscribe(u, "active"))).toMatchObject({ plan: "pro", source: "subscription", subscription: { status: "active" } });
    expect((await planOf((u) => subscribe(u, "trialing"))).plan).toBe("pro");
    expect((await planOf((u) => subscribe(u, "past_due", { graceSeconds: 3600 }))).plan).toBe("pro");
    expect((await planOf((u) => subscribe(u, "canceled", { periodEndSeconds: 3600 }))).plan).toBe("pro");
    const cancelling = await planOf((u) => subscribe(u, "active", { cancelAtPeriodEnd: true }));
    expect(cancelling.subscription).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
  });

  it("subscriptions: paused, expired, past_due after its grace and canceled after its period are Free, still shown", async () => {
    for (const [status, options] of [
      ["paused", {}],
      ["expired", { periodEndSeconds: -3600 }],
      ["past_due", { graceSeconds: -1 }],
      ["canceled", { periodEndSeconds: -1 }],
    ] as const) {
      const result = await planOf((u) => subscribe(u, status, options));
      expect(result, status).toMatchObject({ plan: "free", source: "account", subscription: { status } });
    }
    expect((await planOf(async () => undefined)).subscription).toBeNull();
  });

  it("overrides: Pro by override, limits by override; expired and revoked ones no longer apply", async () => {
    expect(await planOf((u) => grantOverride(u))).toMatchObject({ plan: "pro", source: "override" });
    expect((await planOf((u) => grantOverride(u, "limits.activeStorageBytes", 3 * GIB))).limits.activeStorageBytes).toBe(3 * GIB);
    const revoked = await planOf(async (u) => revokeOverride(await grantOverride(u)));
    expect(revoked).toMatchObject({ plan: "free", source: "account" });
    const expired = await planOf((u) =>
      adminDb().query(
        `insert into app.entitlement_overrides (subject_type, subject_id, key, value, reason, created_by, created_at, expires_at)
         values ('user', $1, 'plan', '"pro"', 'expired', 'tests', now() - interval '2 days', now() - interval '1 second')`,
        [u],
      ),
    );
    expect(expired.plan).toBe("free");
  });

  it("an anonymous user is Free even with an override row written behind the operator function's back", async () => {
    const anon = await Device.create(newNetwork().ip());
    await adminDb().query(
      `insert into app.entitlement_overrides (subject_type, subject_id, key, value, reason, created_by) values ('user', $1, 'plan', '"pro"', 'forged', 'tests')`,
      [anon.userId],
    );
    expect(await entitlements(anon)).toMatchObject({ plan: "free", source: "anonymous" });
    expect((await text(anon, "x".repeat(100 * KIB + 1))).status).toBe(413);
  });

  it("one account's plan never reaches another: a Pro and a Free account on the same network", async () => {
    const net = newNetwork();
    const pro = await proDevice(net.ip());
    const free = await accountDevice(net.ip());
    expect((await entitlements(pro.device)).plan).toBe("pro");
    expect(await entitlements(free.device)).toMatchObject({ plan: "free", source: "account" });
    expect((await text(free.device, "x".repeat(100 * KIB + 1))).status).toBe(413);
    // Usage is the caller's own.
    await setStorageUsed(pro.userId, 7 * GIB);
    expect((await entitlements(free.device)).usage.storageUsedBytes).toBe(0);
    expect((await entitlements(pro.device)).usage).toMatchObject({ storageUsedBytes: 7 * GIB, storageQuotaBytes: 100 * GIB });
  });
});

describe("snapshots on shares and links (T4-EN3)", () => {
  it("new shares and links store version 2; a version 1 snapshot of Phases 1–3 still works", async () => {
    const { device: pro } = await proDevice();
    const note = await pro.postText("snapshot");
    const link = await pro.createLink(note.id);
    expect((await shareRow(note.id)).entitlement_snapshot).toMatchObject({ v: 2, plan: "pro", source: "override", historyRetentionDays: 365 });
    const { rows } = await adminDb().query("select entitlement_snapshot from app.share_links where id = $1", [link.id]);
    expect(rows[0].entitlement_snapshot).toMatchObject({ v: 2, plan: "pro", limits: { linkDailyUrlIssuances: 10_000 } });
    expect(typeof rows[0].entitlement_snapshot.resolvedAt).toBe("string");

    // A Phase 3 share: no version, none of the Phase 4 keys. It is read as Free.
    const old = await pro.postText("phase 3 share");
    await adminDb().query(
      `update app.shares set entitlement_snapshot = jsonb_build_object('plan', 'free', 'historyRetentionDays', 30,
         'limits', (entitlement_snapshot -> 'limits') - 'maxSignedInDevices' - 'rateLimits' - 'maxRooms' - 'maxTextBytes',
         'features', jsonb_build_object('burnAfterDownload', false)) where id = $1`,
      [old.id],
    );
    expect((await pro.call("GET", `/api/v1/shares/${old.id}`)).status).toBe(200);
    expect((await pro.call("PATCH", `/api/v1/shares/${old.id}/text`, { content: "x".repeat(100 * KIB), version: 1 })).status).toBe(200);
    expect((await pro.call("PATCH", `/api/v1/shares/${old.id}/text`, { content: "x".repeat(100 * KIB + 1), version: 2 })).status).toBe(413);
  });
});

describe("GET /me/entitlements matches enforcement (T4-EN4)", () => {
  async function check(d: Device) {
    const body = await entitlements(d);
    for (const seconds of body.limits.expiryOptionsSeconds as number[]) {
      expect((await text(d, `expires in ${seconds}`, { expiresIn: seconds })).status, `${body.plan} ${seconds}`).toBe(201);
    }
    expect((await text(d, "x".repeat(body.limits.maxTextBytes))).status).toBe(201);
    expect((await text(d, "x".repeat(body.limits.maxTextBytes + 1))).status).toBe(413);
    const many = Array.from({ length: body.limits.maxFilesPerShare }, () => ({ size: 1 }));
    expect((await init(d, many)).status).toBe(201);
    return body;
  }

  it("Free, Pro by subscription and Pro by override each get exactly what the response says", async () => {
    const free = await check(await Device.create(newNetwork().ip()));
    expect(free).toMatchObject({ plan: "free", source: "anonymous", limits: { maxTextBytes: 100 * KIB, maxFilesPerShare: 20, activeStorageBytes: 2 * GIB } });
    const subscriber = await accountDevice();
    await subscribe(subscriber.userId, "active");
    expect(await check(subscriber.device)).toMatchObject({ plan: "pro", source: "subscription", limits: { maxTextBytes: MIB, maxFilesPerShare: 100 } });
    const { device: override } = await proDevice();
    const viaOverride = await check(override);
    expect(viaOverride).toMatchObject({
      plan: "pro",
      source: "override",
      limits: { expiryOptionsSeconds: [3600, DAY, 7 * DAY, 30 * DAY, 90 * DAY], shortCodeExpiryOptionsSeconds: [600, 3600, DAY, 7 * DAY], historyRetentionDays: 365 },
      features: { burnAfterDownload: true, linkPasswords: true, privateRooms: true, extendExpiry: true },
    });
    expect((await override.call("GET", "/api/v1/me")).body.plan).toBe("pro");
  });
});

describe("nothing from the client raises the plan (T4-EN5)", () => {
  it("a plan field in a body is refused; headers and query parameters are ignored", async () => {
    const free = await Device.create(newNetwork().ip());
    const withField = await text(free, "spoof", { plan: "pro" });
    expect(withField.status).toBe(400);
    expect(error(withField).code).toBe("VALIDATION_FAILED");
    const headers = { "x-plan": "pro", "x-entitlements": JSON.stringify({ plan: "pro" }), "x-subscription-status": "active" };
    expect((await free.call("POST", "/api/v1/texts", { destination: "network", content: "x".repeat(100 * KIB + 1) }, { headers })).status).toBe(413);
    const query = await free.call("GET", "/api/v1/me/entitlements?plan=pro&success=true&session_id=cs_test_paid");
    expect(query.body).toMatchObject({ plan: "free" });
  });

  it("claims the user or an operator put in the token (is_pro, plan) change nothing", async () => {
    const account = await accountDevice(newNetwork().ip(), { observe: false });
    const session = account.device.supabase;
    // The user can write their own user_metadata; an operator (or a bug) could write app_metadata.
    await session.auth.updateUser({ data: { plan: "pro", is_pro: true, subscription: { status: "active" } } });
    await authAdmin().auth.admin.updateUserById(account.userId, { app_metadata: { plan: "pro", is_pro: true } });
    await session.auth.refreshSession();
    const refreshed = await currentSession(session);
    const claims = JSON.parse(Buffer.from(refreshed.accessToken.split(".")[1]!, "base64url").toString());
    expect(claims.user_metadata).toMatchObject({ is_pro: true });
    expect(claims.app_metadata).toMatchObject({ plan: "pro" });
    const response = await api("GET", "/api/v1/me/entitlements", { token: refreshed.accessToken, deviceId: account.device.deviceId, ip: account.device.ip });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ plan: "free", source: "account" });
  });
});

describe("downgrades (T-051, §17.16)", () => {
  it("existing shares keep their expiry and retention class; new ones get Free's options", async () => {
    const pro = await proDevice();
    const long = await text(pro.device, "ninety days", { expiresIn: 90 * DAY });
    const before = await shareRow(long.body.share.id);
    await pro.downgrade();
    const after = await shareRow(long.body.share.id);
    expect(after).toMatchObject({ status: "active", retention_class: "d90" });
    expect(after.expires_at.getTime()).toBe(before.expires_at.getTime());
    expect((await text(pro.device, "new", { expiresIn: 90 * DAY })).status).toBe(422);
  });

  it("an upload in progress at the downgrade may finish (its size and expiry were allowed when it began)", async () => {
    const pro = await proDevice();
    const started = await init(pro.device, [{ name: "big.bin", size: 2 * MIB }], { expiresIn: 30 * DAY });
    expect(started.status).toBe(201);
    await pro.downgrade();
    const target = started.body.uploads[0];
    expect((await fetch(target.url, { method: "PUT", headers: target.headers, body: Buffer.alloc(2 * MIB, 7) })).ok).toBe(true);
    const complete = await pro.device.call("POST", `/api/v1/shares/${started.body.share.id}/files/${target.fileId}/complete`, {});
    expect(complete.status).toBe(200);
    expect(await shareRow(started.body.share.id)).toMatchObject({ status: "active", retention_class: "d30" });
  });

  it("a Pro burn share stays burn after the downgrade, and the first download still claims it", async () => {
    const net = newNetwork();
    const pro = await proDevice(net.ip());
    const burn = await text(pro.device, "burn kept", { burnAfterDownload: true });
    await pro.downgrade();
    expect((await shareRow(burn.body.share.id)).burn_after_download).toBe(true);
    const peer = await Device.create(net.ip());
    const reveal = await peer.call("POST", `/api/v1/shares/${burn.body.share.id}/reveal`, { confirm: true });
    expect(reveal.status).toBe(200);
    expect(reveal.body.text.content).toBe("burn kept");
    expect((await Device.create(net.ip()).then((d) => d.call("POST", `/api/v1/shares/${burn.body.share.id}/reveal`, { confirm: true }))).status).toBe(410);
  });

  it("an upgrade raises new limits at once, with no new session or device (the next request resolves again)", async () => {
    const account = await accountDevice();
    expect((await text(account.device, "x".repeat(100 * KIB + 1))).status).toBe(413);
    const id = await grantOverride(account.userId);
    expect((await text(account.device, "x".repeat(100 * KIB + 1))).status).toBe(201);
    await revokeOverride(id);
    expect((await text(account.device, "x".repeat(100 * KIB + 1))).status).toBe(413);
  });
});
