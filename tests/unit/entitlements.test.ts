import { describe, expect, it } from "vitest";
import { FREE_PLAN, isAllowedExpiry, resolveEntitlements } from "@/lib/server/entitlements/plans";

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
  it("gives every Phase 1 user the Free plan, never anything from the client", () => {
    expect(resolveEntitlements({ userId: "u", isAnonymous: true }).plan).toBe("free");
    expect(resolveEntitlements({ userId: "u", isAnonymous: false }).plan).toBe("free");
  });

  it("returns a snapshot that can be stored on a share", () => {
    const snapshot = JSON.parse(JSON.stringify(resolveEntitlements({ userId: "u", isAnonymous: true })));
    expect(snapshot).toMatchObject({ plan: "free", limits: { maxFileBytes: 100 * MB }, historyRetentionDays: 30 });
  });
});
