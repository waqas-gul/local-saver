import { describe, expect, it } from "vitest";
import { isShareVisible, shareVisibility, type VisibilityContext, type VisibleShareFields } from "@/lib/server/local/visibility";

/**
 * The visibility rule for burn-after-download shares (phase 3 §17.8.4, DEC-015, D-7): while a
 * share is claimed, its claimant (on the network) and its creator still see it; anyone else who
 * would have seen it learns it was downloaded; everyone else gets the usual 404.
 */

const NOW = new Date("2026-10-16T12:00:00Z");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_SPACE = "22222222-2222-4222-8222-222222222222";
const CREATOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLAIMANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLAIMANT_DEVICE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const claimed: VisibleShareFields = {
  scope: "network",
  status: "claimed",
  expiresAt: new Date("2026-10-17T12:00:00Z"),
  networkSpaceId: SPACE,
  createdByUserId: CREATOR,
  claimedByUserId: CLAIMANT,
  claimedDeviceId: CLAIMANT_DEVICE,
  claimGraceUntil: new Date("2026-10-16T12:15:00Z"),
};

const claimant: VisibilityContext = { userId: CLAIMANT, deviceId: CLAIMANT_DEVICE, eligibleSpaceIds: [SPACE], now: NOW };
const neighbour: VisibilityContext = { userId: OTHER, deviceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", eligibleSpaceIds: [SPACE], now: NOW };
const creator: VisibilityContext = { userId: CREATOR, deviceId: "ffffffff-ffff-4fff-8fff-ffffffffffff", eligibleSpaceIds: [], now: NOW };

describe("shareVisibility for claimed shares", () => {
  it("shows a claimed share to its claimant while they stay on the network", () => {
    expect(shareVisibility(claimed, claimant)).toBe("visible");
    expect(isShareVisible(claimed, claimant)).toBe(true);
  });

  it("hides it from the claimant once they leave the network (the usual 404, R3-5)", () => {
    expect(shareVisibility(claimed, { ...claimant, eligibleSpaceIds: [OTHER_SPACE] })).toBe("hidden");
  });

  it("ties the claim to the device: the same user on another device is someone else", () => {
    expect(shareVisibility(claimed, { ...claimant, deviceId: "99999999-9999-4999-8999-999999999999" })).toBe("downloaded_by_other");
  });

  it("tells others on the network it was downloaded", () => {
    expect(shareVisibility(claimed, neighbour)).toBe("downloaded_by_other");
    expect(isShareVisible(claimed, neighbour)).toBe(false);
  });

  it("gives the usual 404 to anyone who couldn't have seen it", () => {
    expect(shareVisibility(claimed, { ...neighbour, eligibleSpaceIds: [OTHER_SPACE] })).toBe("hidden");
    expect(shareVisibility({ ...claimed, scope: "link_only", networkSpaceId: null }, neighbour)).toBe("hidden");
  });

  it("keeps showing it to its creator until it is consumed (D-7)", () => {
    expect(shareVisibility(claimed, creator)).toBe("visible");
  });

  it("ends the claimant's access when grace ends, before the finalize job runs (request-time check)", () => {
    const afterGrace = { ...claimant, now: new Date("2026-10-16T12:15:00Z") };
    expect(shareVisibility(claimed, afterGrace)).toBe("downloaded_by_you");
    expect(shareVisibility(claimed, { ...creator, now: afterGrace.now })).toBe("downloaded_by_other");
  });

  it("treats a consumed share as downloaded: by you for the claimant, by someone else for the rest", () => {
    const consumed = { ...claimed, status: "consumed" };
    expect(shareVisibility(consumed, claimant)).toBe("downloaded_by_you");
    expect(shareVisibility(consumed, neighbour)).toBe("downloaded_by_other");
    expect(shareVisibility(consumed, creator)).toBe("downloaded_by_other");
    expect(isShareVisible(consumed, claimant)).toBe(false);
  });

  it("hides claimed and consumed shares past expiry from everyone", () => {
    const later = new Date("2026-10-17T12:00:00Z");
    for (const status of ["claimed", "consumed"]) {
      expect(shareVisibility({ ...claimed, status }, { ...claimant, now: later })).toBe("hidden");
      expect(shareVisibility({ ...claimed, status }, { ...creator, now: later })).toBe("hidden");
    }
  });

  it("without a device, nobody is the device claimant", () => {
    expect(shareVisibility(claimed, { ...claimant, deviceId: undefined })).toBe("downloaded_by_other");
  });
});
