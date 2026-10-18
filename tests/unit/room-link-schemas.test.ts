import { describe, expect, it } from "vitest";
import { confirmReceivedBody, createReportBody, createRoomLinkBody, revealBody, viewerContentResponse } from "@/lib/shared/api/schemas";
import { AVAILABLE_FEATURES, FREE_LIMITS, PRO_LIMITS } from "@/lib/shared/plans";

/**
 * The room-link contract (phase 4 §17.8.5, §17.13; P4-19): creation takes an expiry and an optional password, never a
 * short code or a target; viewer content is a share link's one share or a room link's shares, never a mix; burn actions
 * and reports may name a share.
 */

const UUID = "33333333-3333-4333-8333-333333333333";
const now = new Date().toISOString();

describe("POST /rooms/{roomId}/links body", () => {
  it("is an expiry and an optional password, and nothing else", () => {
    expect(createRoomLinkBody.parse({ expiresIn: 86_400 })).toEqual({ expiresIn: 86_400 });
    expect(createRoomLinkBody.parse({ expiresIn: 3600, password: "correct horse" })).toEqual({ expiresIn: 3600, password: "correct horse" });
    for (const body of [{}, { expiresIn: 0 }, { expiresIn: 3600, shortCode: { expiresIn: 600 } }, { expiresIn: 3600, roomId: UUID }, { expiresIn: 3600, shareId: UUID }]) {
      expect(createRoomLinkBody.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe("viewer content", () => {
  const link = { id: "A".repeat(16), expiresAt: now };
  const access = { expiresAt: now };
  const share = { kind: "text", expiresAt: now, text: { content: "hi" }, files: [] };
  const roomShare = { id: UUID, kind: "text", createdAt: now, expiresAt: now, text: { content: "hi" }, files: [] };

  it("is a share link's share or a room link's shares", () => {
    expect("share" in viewerContentResponse.parse({ link, access, share })).toBe(true);
    const room = viewerContentResponse.parse({ link, access, room: { shares: [roomShare], nextCursor: null } });
    expect("room" in room && room.room.shares[0]!.id).toBe(UUID);
    expect(viewerContentResponse.safeParse({ link, access }).success).toBe(false);
    expect(viewerContentResponse.safeParse({ link, access, room: { shares: [{ ...roomShare, id: "not-a-uuid" }], nextCursor: null } }).success).toBe(false);
  });
});

describe("burn actions and reports name a share", () => {
  it("accept an optional share ID, a UUID", () => {
    expect(revealBody.parse({ confirm: true, shareId: UUID })).toEqual({ confirm: true, shareId: UUID });
    expect(revealBody.parse({ confirm: true })).toEqual({ confirm: true });
    expect(revealBody.safeParse({ confirm: true, shareId: "x" }).success).toBe(false);
    expect(confirmReceivedBody.parse({})).toEqual({});
    expect(confirmReceivedBody.safeParse({ shareId: UUID, other: 1 }).success).toBe(false);
    expect(createReportBody.parse({ target: { type: "link", linkId: "A".repeat(16), shareId: UUID }, category: "spam" }).target).toEqual({
      type: "link",
      linkId: "A".repeat(16),
      shareId: UUID,
    });
  });
});

describe("plans (E22, D4-17)", () => {
  it("room links are Pro's, for 1 hour to 30 days, and the pricing page lists them", () => {
    expect(FREE_LIMITS.roomLinkExpiryOptionsSeconds).toEqual([]);
    expect(PRO_LIMITS.roomLinkExpiryOptionsSeconds).toEqual([3600, 86_400, 7 * 86_400, 30 * 86_400]);
    expect(AVAILABLE_FEATURES).toContain("roomLinks");
  });
});
