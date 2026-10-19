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

  it("never shows a link-only share on a network, even its own space's (DEC-033, T-012)", () => {
    const linkOnly = { ...share, scope: "link_only", networkSpaceId: null };
    expect(isShareVisible(linkOnly, onA)).toBe(false);
    // Even if a link-only row ever carried a space ID, the network part of the rule never applies.
    expect(isShareVisible({ ...share, scope: "link_only" }, onA)).toBe(false);
  });

  it("shows a link-only share to its creator, from any network (My uploads)", () => {
    const linkOnly = { ...share, scope: "link_only", networkSpaceId: null };
    expect(isShareVisible(linkOnly, { userId: CREATOR, eligibleSpaceIds: [], now: NOW })).toBe(true);
    expect(isShareVisible({ ...linkOnly, status: "pending_upload" }, { userId: CREATOR, eligibleSpaceIds: [], now: NOW })).toBe(true);
    expect(isShareVisible({ ...linkOnly, expiresAt: NOW }, { userId: CREATOR, eligibleSpaceIds: [], now: NOW })).toBe(false);
  });

  // Phase 4D (P4-17, deviation DV4-90): room shares exist now. This test asserted that every room share was hidden,
  // its creator included; the rule now shows one to its room's members and its creator (below). Its intent, that a
  // scope the rule doesn't know is hidden from everyone, is kept with 'workspace' (Phase 5).
  it("ignores scopes it doesn't know (workspaces arrive in Phase 5)", () => {
    expect(isShareVisible({ ...share, scope: "workspace" }, onA)).toBe(false);
    expect(isShareVisible({ ...share, scope: "workspace" }, { ...onA, userId: CREATOR })).toBe(false);
  });
});

describe("isShareVisible for room shares (phase 4 §17.8.4, P4-17)", () => {
  const ROOM = "33333333-3333-4333-8333-333333333333";
  const OTHER_ROOM = "44444444-4444-4444-8444-444444444444";
  const roomShare: VisibleShareFields = { ...share, scope: "room", networkSpaceId: null, roomId: ROOM };

  it("shows a room share to the room's active members, from any network", () => {
    expect(isShareVisible(roomShare, { userId: OTHER, eligibleSpaceIds: [], roomIds: [ROOM], now: NOW })).toBe(true);
    expect(isShareVisible(roomShare, { userId: OTHER, eligibleSpaceIds: [SPACE_B], roomIds: [ROOM], now: NOW })).toBe(true);
  });

  it("hides it from everyone else: other rooms' members, non-members on any network (G-R1)", () => {
    expect(isShareVisible(roomShare, { userId: OTHER, eligibleSpaceIds: [SPACE_A], roomIds: [OTHER_ROOM], now: NOW })).toBe(false);
    expect(isShareVisible(roomShare, onA)).toBe(false);
    // Even if a room share ever carried a space ID, the network part of the rule never applies to it.
    expect(isShareVisible({ ...roomShare, networkSpaceId: SPACE_A }, onA)).toBe(false);
  });

  it("never shows a network share through a room", () => {
    expect(isShareVisible({ ...share, roomId: ROOM }, { userId: OTHER, eligibleSpaceIds: [], roomIds: [ROOM], now: NOW })).toBe(false);
  });

  it("shows its creator their room share, also after they left the room (D4-15); uploads in progress only to them", () => {
    expect(isShareVisible(roomShare, { userId: CREATOR, eligibleSpaceIds: [], roomIds: [], now: NOW })).toBe(true);
    const pending = { ...roomShare, status: "pending_upload" };
    expect(isShareVisible(pending, { userId: OTHER, eligibleSpaceIds: [], roomIds: [ROOM], now: NOW })).toBe(false);
    expect(isShareVisible(pending, { userId: CREATOR, eligibleSpaceIds: [], now: NOW })).toBe(true);
  });

  it("hides expired and ended room shares from members too", () => {
    const member: VisibilityContext = { userId: OTHER, eligibleSpaceIds: [], roomIds: [ROOM], now: NOW };
    expect(isShareVisible({ ...roomShare, expiresAt: NOW }, member)).toBe(false);
    for (const status of ["expired", "deleted", "blocked", "failed"]) expect(isShareVisible({ ...roomShare, status }, member)).toBe(false);
  });
});
