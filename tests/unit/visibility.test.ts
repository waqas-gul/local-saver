import { describe, expect, it } from "vitest";
import { isShareVisible, type VisibilityContext, type VisibleShareFields } from "@/lib/server/local/visibility";

const NOW = new Date("2026-10-15T12:00:00Z");
const SPACE_A = "11111111-1111-4111-8111-111111111111";
const SPACE_B = "22222222-2222-4222-8222-222222222222";
const CREATOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const share: VisibleShareFields = {
  scope: "network",
  status: "active",
  expiresAt: new Date("2026-10-16T12:00:00Z"),
  networkSpaceId: SPACE_A,
  createdByUserId: CREATOR,
};

const onA: VisibilityContext = { userId: OTHER, eligibleSpaceIds: [SPACE_A], now: NOW };

describe("isShareVisible (03 §3.6, G1)", () => {
  it("shows an active share to devices on its eligible network", () => {
    expect(isShareVisible(share, onA)).toBe(true);
  });

  it("hides it from devices on another network (T-001)", () => {
    expect(isShareVisible(share, { ...onA, eligibleSpaceIds: [SPACE_B] })).toBe(false);
  });

  it("hides it when the network is not eligible (G5)", () => {
    expect(isShareVisible(share, { ...onA, eligibleSpaceIds: [] })).toBe(false);
  });

  it("always shows the creator their own share, from any network (T-014)", () => {
    expect(isShareVisible(share, { userId: CREATOR, eligibleSpaceIds: [], now: NOW })).toBe(true);
  });

  it("hides expired shares from everyone, before any job runs (T-041)", () => {
    const expired = { ...share, expiresAt: new Date("2026-10-15T11:59:59Z") };
    expect(isShareVisible(expired, onA)).toBe(false);
    expect(isShareVisible(expired, { userId: CREATOR, eligibleSpaceIds: [SPACE_A], now: NOW })).toBe(false);
    expect(isShareVisible({ ...share, expiresAt: NOW }, onA)).toBe(false);
  });

  it("hides ended shares from everyone", () => {
    for (const status of ["expired", "deleted", "blocked", "failed", "consumed"]) {
      expect(isShareVisible({ ...share, status }, onA)).toBe(false);
      expect(isShareVisible({ ...share, status }, { ...onA, userId: CREATOR })).toBe(false);
    }
  });

  it("shows uploads in progress only to their creator", () => {
    const pending = { ...share, status: "pending_upload" };
    expect(isShareVisible(pending, onA)).toBe(false);
    expect(isShareVisible(pending, { ...onA, userId: CREATOR })).toBe(true);
  });

  it("ignores shares that are not network-scoped", () => {
    expect(isShareVisible({ ...share, scope: "link_only" }, onA)).toBe(false);
  });
});
