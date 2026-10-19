import { describe, expect, it, vi } from "vitest";
import {
  assertFeature,
  assertFileCount,
  assertFileSizes,
  assertNotDeletionPending,
  assertOption,
  assertTextSize,
  quotaExceeded,
} from "@/lib/server/entitlements/enforce";
import { FREE_PLAN, isAllowedExpiry, PRO_PLAN, SINGLE_PUT_MAX_BYTES } from "@/lib/server/entitlements/plans";
import { computeEntitlements, NO_STATE, resolveEntitlements, type EntitlementState } from "@/lib/server/entitlements/resolve";
import { readSnapshot, snapshotFor } from "@/lib/server/entitlements/snapshot";
import { ApiError } from "@/lib/server/http/errors";
import { FREE_LIMITS, PRO_LIMITS } from "@/lib/shared/plans";

const MB = 1024 * 1024;

describe("Free plan (07 §1, Q-007 and Q-030 assumed)", () => {
  it("limits files to 100 MB each and 20 per share", () => {
    expect(FREE_PLAN.limits.maxFileBytes).toBe(100 * MB);
    expect(FREE_PLAN.limits.maxFilesPerShare).toBe(20);
  });

  it("limits text to 100 KB", () => {
    expect(FREE_PLAN.limits.maxTextBytes).toBe(100 * 1024);
  });

  it("allows 2 GB active storage and 2 GB/day per user, 10 GB/day per network", () => {
    expect(FREE_PLAN.limits.activeStorageBytes).toBe(2 * 1024 * MB);
    expect(FREE_PLAN.limits.dailyUploadBytes).toBe(2 * 1024 * MB);
    expect(FREE_PLAN.limits.dailyUploadBytesPerNetwork).toBe(10 * 1024 * MB);
  });

  it("offers 1 h, 24 h and 7 days for local shares, defaulting to 24 h", () => {
    expect(FREE_PLAN.limits.localExpiryOptionsSeconds).toEqual([3600, 86400, 604800]);
    expect(FREE_PLAN.limits.localDefaultExpirySeconds).toBe(86400);
    expect(isAllowedExpiry(FREE_PLAN, 3600)).toBe(true);
    expect(isAllowedExpiry(FREE_PLAN, 604800)).toBe(true);
    expect(isAllowedExpiry(FREE_PLAN, 30 * 86400)).toBe(false);
    expect(isAllowedExpiry(FREE_PLAN, 1800)).toBe(false);
  });

  it("keeps tombstones 30 days and has no Pro features", () => {
    expect(FREE_PLAN.limits.historyRetentionDays).toBe(30);
    expect(Object.values(FREE_PLAN.features).every((enabled) => enabled === false)).toBe(true);
  });
});

describe("resolveEntitlements", () => {
  // Asynchronous since Phase 4 (P4-01): the same assertions, awaited. Since P4-09 an account's plan
  // is read from the database; here the read finds no subscription and no override.
  it("gives every Phase 1 user the Free plan, never anything from the client", async () => {
    expect((await resolveEntitlements({ userId: "u", isAnonymous: true })).plan).toBe("free");
    expect((await resolveEntitlements({ userId: "u", isAnonymous: false }, async () => NO_STATE)).plan).toBe("free");
  });

  it("returns a snapshot that can be stored on a share", async () => {
    const snapshot = JSON.parse(JSON.stringify(await resolveEntitlements({ userId: "u", isAnonymous: true })));
    expect(snapshot).toMatchObject({ plan: "free", limits: { maxFileBytes: 100 * MB }, historyRetentionDays: 30 });
  });
});

// ---------------------------------------------------------------------------------------------
// Phase 4B (P4-09, P4-10; phase 4 §17.6, §17.16, §17.19.2)
// ---------------------------------------------------------------------------------------------
const GB = 1024 * MB;
const DAY = 86_400;
const account = { userId: "b0000000-0000-4000-8000-000000000001", isAnonymous: false };
const state = (patch: Partial<EntitlementState>): EntitlementState => ({ ...NO_STATE, ...patch });

describe("Pro plan (D4-9 binary units; D4-10, D4-11, D4-14, D4-17, D4-29, Q-015 recommendations)", () => {
  it("has the proposed Pro limits", () => {
    expect(PRO_LIMITS).toMatchObject({
      maxFileBytes: 5 * GB,
      maxFilesPerShare: 100,
      maxTextBytes: MB,
      activeStorageBytes: 100 * GB,
      dailyUploadBytes: 200 * GB,
      dailyUploadBytesPerNetwork: null,
      localExpiryOptionsSeconds: [3600, DAY, 7 * DAY, 30 * DAY, 90 * DAY],
      linkExpiryOptionsSeconds: [3600, DAY, 7 * DAY, 30 * DAY, 90 * DAY],
      shortCodeExpiryOptionsSeconds: [600, 3600, DAY, 7 * DAY],
      shortCodeMaxTtlSeconds: 7 * DAY,
      linkDailyUrlIssuances: 10_000,
      historyRetentionDays: 365,
      maxSignedInDevices: 10,
      maxRooms: 20,
      maxRoomMembers: 50,
      roomLinkExpiryOptionsSeconds: [3600, DAY, 7 * DAY, 30 * DAY],
      rateLimits: { createShare: 300, createLink: 300 },
    });
  });

  it("keeps executables blocked in remote links (D4-11) and leaves Team features off", () => {
    expect(PRO_PLAN.features).toMatchObject({ executablesInRemoteLinks: false, adminControls: false, brandedPages: false });
    expect(PRO_PLAN.features).toMatchObject({ burnAfterDownload: true, linkPasswords: true, privateRooms: true, extendExpiry: true, transferHistory: true });
  });

  it("uses exactly the Free plan's key names, which stored snapshots depend on (C4-4)", () => {
    expect(Object.keys(PRO_LIMITS).sort()).toEqual(Object.keys(FREE_LIMITS).sort());
    for (const key of ["maxFileBytes", "localExpiryOptionsSeconds", "shortCodeMaxTtlSeconds", "linkDailyUrlIssuances", "dailyUploadBytesPerNetwork"]) {
      expect(FREE_LIMITS).toHaveProperty(key);
    }
  });

  it("keeps the Free values of Phases 1–3 and gives accounts the same device cap (D4-5)", () => {
    expect(FREE_LIMITS).toMatchObject({ maxSignedInDevices: 10, maxRooms: 0, rateLimits: { createShare: 30, createLink: 30 } });
  });
});

describe("computeEntitlements (§17.6.2, T4-EN1, T4-EN2)", () => {
  it("resolves anonymous users as Free whatever the stored state says", () => {
    const anonymous = computeEntitlements(
      { userId: account.userId, isAnonymous: true },
      state({ entitled: true, overrides: [{ key: "plan", value: "pro" }], deletionPending: true }),
    );
    expect(anonymous).toMatchObject({ plan: "free", source: "anonymous", deletionPending: false, subscription: null });
    expect(anonymous.limits.activeStorageBytes).toBe(2 * GB);
  });

  it("resolves an account without a subscription as Free, and with an entitling one as Pro", () => {
    expect(computeEntitlements(account, NO_STATE)).toMatchObject({ plan: "free", source: "account" });
    const pro = computeEntitlements(account, state({ entitled: true }));
    expect(pro).toMatchObject({ plan: "pro", source: "subscription", historyRetentionDays: 365 });
    expect(pro.limits.activeStorageBytes).toBe(100 * GB);
  });

  it("applies a plan override first, the latest one winning", () => {
    expect(computeEntitlements(account, state({ overrides: [{ key: "plan", value: "pro" }] }))).toMatchObject({ plan: "pro", source: "override" });
    const revertedByLater = computeEntitlements(account, state({ entitled: true, overrides: [{ key: "plan", value: "pro" }, { key: "plan", value: "free" }] }));
    expect(revertedByLater).toMatchObject({ plan: "free", source: "override" });
    expect(computeEntitlements(account, state({ overrides: [{ key: "plan", value: "team" }] }))).toMatchObject({ plan: "free", source: "account" });
  });

  it("applies whitelisted limit and feature overrides on top, the latest winning", () => {
    const result = computeEntitlements(
      account,
      state({
        overrides: [
          { key: "limits.activeStorageBytes", value: 3 * GB },
          { key: "limits.activeStorageBytes", value: 4 * GB },
          { key: "limits.historyRetentionDays", value: 90 },
          { key: "features.burnAfterDownload", value: true },
        ],
      }),
    );
    expect(result.plan).toBe("free");
    expect(result.limits.activeStorageBytes).toBe(4 * GB);
    expect(result.limits.historyRetentionDays).toBe(90);
    expect(result.historyRetentionDays).toBe(90);
    expect(result.features.burnAfterDownload).toBe(true);
  });

  it("ignores overrides outside the whitelist or of the wrong type", () => {
    const result = computeEntitlements(
      account,
      state({
        overrides: [
          { key: "limits.maxFilesPerShare", value: 5000 },
          { key: "limits.activeStorageBytes", value: "lots" },
          { key: "limits.dailyUploadBytes", value: 0 },
          { key: "limits.maxFileBytes", value: 1.5 },
          { key: "limits.historyRetentionDays", value: 40_000 },
          { key: "features.linkPasswords", value: "yes" },
          { key: "features.everything", value: true },
          { key: "subject", value: "someone else" },
        ],
      }),
    );
    expect(result.limits).toEqual(FREE_PLAN.limits);
    expect(result.features).toEqual(FREE_PLAN.features);
  });

  // Phase 4D (P4-14) lifts DV4-17's 100 MiB cap: above one PUT's size a file goes up in parts, to Pro's 5 GiB.
  it("delivers Pro's 5 GiB by multipart, and caps an override there (DEC-026, P4-14)", () => {
    expect(SINGLE_PUT_MAX_BYTES).toBe(100 * MB);
    expect(computeEntitlements(account, state({ entitled: true })).limits.maxFileBytes).toBe(5 * GB);
    const overridden = computeEntitlements(account, state({ entitled: true, overrides: [{ key: "limits.maxFileBytes", value: 10 * GB }] }));
    expect(overridden.limits.maxFileBytes).toBe(5 * GB);
    expect(computeEntitlements(account, state({ overrides: [{ key: "limits.maxFileBytes", value: 50 * MB }] })).limits.maxFileBytes).toBe(50 * MB);
    expect(computeEntitlements(account, state({ overrides: [{ key: "limits.maxFileBytes", value: GB }] })).limits.maxFileBytes).toBe(GB);
  });

  it("passes the deletion grace and the subscription summary through", () => {
    const subscription = { status: "past_due", currentPeriodEnd: null, cancelAtPeriodEnd: false, graceUntil: "2026-10-20T00:00:00.000Z" };
    expect(computeEntitlements(account, state({ entitled: true, deletionPending: true, subscription }))).toMatchObject({ deletionPending: true, subscription });
  });
});

describe("resolveEntitlements: per request (§17.6.2)", () => {
  it("reads the database once per principal object, and never for anonymous users", async () => {
    const load = vi.fn(async () => state({ entitled: true }));
    const principal = { ...account };
    const [first, second] = await Promise.all([resolveEntitlements(principal, load), resolveEntitlements(principal, load)]);
    expect(first).toBe(second);
    expect(load).toHaveBeenCalledTimes(1);
    await resolveEntitlements({ ...account }, load);
    expect(load).toHaveBeenCalledTimes(2);
    await resolveEntitlements({ userId: account.userId, isAnonymous: true }, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("doesn't keep a failed read", async () => {
    const principal = { ...account };
    await expect(resolveEntitlements(principal, async () => Promise.reject(new Error("db down")))).rejects.toThrow("db down");
    await expect(resolveEntitlements(principal, async () => NO_STATE)).resolves.toMatchObject({ plan: "free" });
  });
});

describe("snapshots (07 §2.3, §17.16, T4-EN3)", () => {
  it("writes version 2 with the plan, source, limits, features, retention and time", () => {
    const snapshot = snapshotFor(computeEntitlements(account, state({ entitled: true })));
    expect(Object.keys(snapshot).sort()).toEqual(["features", "historyRetentionDays", "limits", "plan", "resolvedAt", "source", "v"]);
    expect(snapshot).toMatchObject({ v: 2, plan: "pro", source: "subscription", historyRetentionDays: 365 });
    expect(readSnapshot(JSON.parse(JSON.stringify(snapshot)))).toMatchObject({ plan: "pro", limits: { maxTextBytes: MB, linkDailyUrlIssuances: 10_000 } });
  });

  it("reads a version 1 snapshot of Phases 1–3, filling the new keys from Free", () => {
    const { maxSignedInDevices: _devices, rateLimits: _rates, ...phase1Limits } = FREE_LIMITS;
    const v1 = { plan: "free", limits: phase1Limits, features: { burnAfterDownload: true }, historyRetentionDays: 30 };
    const read = readSnapshot(JSON.parse(JSON.stringify(v1)));
    expect(read.limits.maxSignedInDevices).toBe(10);
    expect(read.limits.rateLimits).toEqual({ createShare: 30, createLink: 30 });
    expect(read.limits.maxPreviewBytes).toBe(20 * MB);
    expect(read.features.burnAfterDownload).toBe(true);
    expect(read.features.linkPasswords).toBe(false);
    expect(read.historyRetentionDays).toBe(30);
  });

  it("never reads more than Free from a missing or damaged snapshot", () => {
    expect(readSnapshot({})).toEqual({ plan: "free", limits: FREE_PLAN.limits, features: FREE_PLAN.features, historyRetentionDays: 30 });
    expect(readSnapshot(null).limits).toEqual(FREE_PLAN.limits);
    const damaged = readSnapshot({ plan: "team", limits: { maxTextBytes: "1 MB", localExpiryOptionsSeconds: ["forever"] }, features: { linkPasswords: "true" } });
    expect(damaged.plan).toBe("free");
    expect(damaged.limits.maxTextBytes).toBe(100 * 1024);
    expect(damaged.limits.localExpiryOptionsSeconds).toEqual(FREE_LIMITS.localExpiryOptionsSeconds);
    expect(damaged.features.linkPasswords).toBe(false);
  });

  it("keeps a Pro snapshot's 'not counted per network' value", () => {
    expect(readSnapshot({ limits: { dailyUploadBytesPerNetwork: null } }).limits.dailyUploadBytesPerNetwork).toBeNull();
  });
});

describe("enforcement helpers: the 07 §4 contract, requiredPlan only when Pro would allow it", () => {
  const free = computeEntitlements(account, NO_STATE);
  const pro = computeEntitlements(account, state({ entitled: true }));
  const refusal = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      return { status: (error as ApiError).status, code: (error as ApiError).code, details: (error as ApiError).details };
    }
    return null;
  };

  it("files per share (E2): 20 / 21 on Free with the hint, 100 / 101 on Pro without", () => {
    expect(refusal(() => assertFileCount(free, 20))).toBeNull();
    expect(refusal(() => assertFileCount(free, 21))).toEqual({ status: 413, code: "TOO_MANY_FILES", details: { maxFiles: 20, requiredPlan: "pro" } });
    expect(refusal(() => assertFileCount(free, 101))).toEqual({ status: 413, code: "TOO_MANY_FILES", details: { maxFiles: 20 } });
    expect(refusal(() => assertFileCount(pro, 100))).toBeNull();
    expect(refusal(() => assertFileCount(pro, 101))).toEqual({ status: 413, code: "TOO_MANY_FILES", details: { maxFiles: 100 } });
  });

  it("file size (E1): Free 100 MiB, with the hint up to Pro's 5 GiB; Pro 5 GiB, one byte more refused without a hint", () => {
    expect(refusal(() => assertFileSizes(free, [1, 100 * MB]))).toBeNull();
    expect(refusal(() => assertFileSizes(free, [100 * MB + 1]))).toEqual({
      status: 413,
      code: "FILE_TOO_LARGE",
      details: { maxFileBytes: 100 * MB, requiredPlan: "pro" },
    });
    expect(refusal(() => assertFileSizes(free, [5 * GB + 1]))).toEqual({ status: 413, code: "FILE_TOO_LARGE", details: { maxFileBytes: 100 * MB } });
    expect(refusal(() => assertFileSizes(pro, [100 * MB + 1, 5 * GB]))).toBeNull();
    expect(refusal(() => assertFileSizes(pro, [5 * GB + 1]))).toEqual({ status: 413, code: "FILE_TOO_LARGE", details: { maxFileBytes: 5 * GB } });
  });

  it("text size (E3, E4): a new text gets the hint up to 1 MiB; an edit (snapshot) never does", () => {
    expect(assertTextSize(free, "x".repeat(100 * 1024))).toBe(100 * 1024);
    expect(refusal(() => assertTextSize(free, "x".repeat(100 * 1024 + 1)))).toEqual({
      status: 413,
      code: "TEXT_TOO_LARGE",
      details: { maxBytes: 100 * 1024, requiredPlan: "pro" },
    });
    expect(refusal(() => assertTextSize(free, "x".repeat(MB + 1)))).toEqual({ status: 413, code: "TEXT_TOO_LARGE", details: { maxBytes: 100 * 1024 } });
    expect(refusal(() => assertTextSize(free, "x".repeat(100 * 1024 + 1), { snapshot: true }))).toEqual({
      status: 413,
      code: "TEXT_TOO_LARGE",
      details: { maxBytes: 100 * 1024 },
    });
    expect(assertTextSize(pro, "x".repeat(MB))).toBe(MB);
    // Counted in UTF-8 bytes: 2 bytes each.
    expect(refusal(() => assertTextSize(pro, "é".repeat(MB / 2 + 1)))).toMatchObject({ code: "TEXT_TOO_LARGE", details: { maxBytes: MB } });
  });

  it("expiry options (E5, E13, E14): Pro's options carry the hint, others don't", () => {
    expect(assertOption(free, "localExpiryOptionsSeconds", 7 * DAY)).toBe(7 * DAY);
    expect(refusal(() => assertOption(free, "localExpiryOptionsSeconds", 30 * DAY))).toEqual({
      status: 422,
      code: "EXPIRY_NOT_ALLOWED",
      details: { allowed: [3600, DAY, 7 * DAY], requiredPlan: "pro" },
    });
    expect(refusal(() => assertOption(free, "localExpiryOptionsSeconds", 29 * DAY))?.details).toEqual({ allowed: [3600, DAY, 7 * DAY] });
    expect(assertOption(pro, "localExpiryOptionsSeconds", 90 * DAY)).toBe(90 * DAY);
    expect(refusal(() => assertOption(pro, "localExpiryOptionsSeconds", 29 * DAY))?.details).toEqual({ allowed: PRO_LIMITS.localExpiryOptionsSeconds });
    expect(refusal(() => assertOption(free, "shortCodeExpiryOptionsSeconds", 7 * DAY))?.details).toMatchObject({ requiredPlan: "pro" });
    expect(assertOption(pro, "linkExpiryOptionsSeconds", 30 * DAY)).toBe(30 * DAY);
  });

  it("storage quota (E7): the hint only when the upload would fit in Pro's quota", () => {
    expect(quotaExceeded(free, 2 * GB - 10, 11).details).toEqual({ usedBytes: 2 * GB - 10, quotaBytes: 2 * GB, requiredPlan: "pro" });
    expect(quotaExceeded(free, 100 * GB, 1).details).toEqual({ usedBytes: 100 * GB, quotaBytes: 2 * GB });
    expect(quotaExceeded(pro, 100 * GB, 1).details).toEqual({ usedBytes: 100 * GB, quotaBytes: 100 * GB });
  });

  it("features: the hint when Pro has the feature; none for what Pro blocks too, or for a Pro account it was taken from", () => {
    expect(refusal(() => assertFeature(free, "burnAfterDownload", "no"))).toEqual({
      status: 403,
      code: "FEATURE_NOT_IN_PLAN",
      details: { feature: "burnAfterDownload", requiredPlan: "pro" },
    });
    expect(refusal(() => assertFeature(free, "executablesInRemoteLinks", "no"))?.details).toEqual({ feature: "executablesInRemoteLinks" });
    const proWithout = computeEntitlements(account, state({ entitled: true, overrides: [{ key: "features.burnAfterDownload", value: false }] }));
    expect(refusal(() => assertFeature(proWithout, "burnAfterDownload", "no"))?.details).toEqual({ feature: "burnAfterDownload" });
    expect(refusal(() => assertFeature(pro, "burnAfterDownload", "no"))).toBeNull();
  });

  it("an account in its deletion grace is read-only (E30)", () => {
    expect(refusal(() => assertNotDeletionPending(computeEntitlements(account, state({ deletionPending: true }))))).toEqual({
      status: 403,
      code: "ACCOUNT_DELETION_PENDING",
      details: undefined,
    });
    expect(refusal(() => assertNotDeletionPending(free))).toBeNull();
  });
});
