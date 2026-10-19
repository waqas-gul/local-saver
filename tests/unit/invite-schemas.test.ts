import { describe, expect, it } from "vitest";
import { createInviteBody, INVITE_KINDS, invitePreviewResponse, inviteSummaryDto } from "@/lib/shared/api/schemas";
import { FREE_LIMITS, PAIRING_INVITE_MAX_SECONDS, PRO_LIMITS } from "@/lib/shared/plans";

/**
 * The invite contract (phase 4 §17.8.4.1, §17.13; P4-17 invite links, P4-18 QR pairing codes). A pairing code takes no
 * expiry or maximum from the caller: it is always one use and 10 minutes, which is also the database's cap.
 */

describe("POST /rooms/{roomId}/invites body", () => {
  it("a pairing code is exactly { kind: 'pairing' }", () => {
    expect(createInviteBody.parse({ kind: "pairing" })).toEqual({ kind: "pairing" });
    for (const body of [
      { kind: "pairing", expiresIn: 600 },
      { kind: "pairing", maxUses: 1 },
      { kind: "pairing", roomId: "33333333-3333-4333-8333-333333333333" },
      { kind: "pairing", secret: "x" },
    ]) {
      expect(createInviteBody.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it("an invite link still needs its expiry, and only links take a maximum", () => {
    expect(createInviteBody.parse({ kind: "invite_link", expiresIn: 3600, maxUses: 5 })).toEqual({ kind: "invite_link", expiresIn: 3600, maxUses: 5 });
    for (const body of [{ kind: "invite_link" }, { kind: "invite_link", expiresIn: 3600, maxUses: 0 }, { kind: "link", expiresIn: 3600 }, { kind: "qr" }, {}]) {
      expect(createInviteBody.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it("both kinds appear in the owner's list and the preview", () => {
    expect(INVITE_KINDS).toEqual(["pairing", "invite_link"]);
    const now = new Date().toISOString();
    expect(inviteSummaryDto.parse({ inviteId: "A".repeat(16), kind: "pairing", createdAt: now, expiresAt: now, useCount: 0, maxUses: 1 }).kind).toBe("pairing");
    expect(invitePreviewResponse.parse({ roomLabel: "Room", memberCount: 1, kind: "pairing", expiresAt: now }).kind).toBe("pairing");
  });
});

describe("pairing lifetime (E20, D4-16)", () => {
  it("is 10 minutes on Free and Pro alike (a downgraded owner's codes last as long), never past the database's cap", () => {
    expect(PAIRING_INVITE_MAX_SECONDS).toBe(600);
    expect(FREE_LIMITS.pairingInviteSeconds).toBe(PAIRING_INVITE_MAX_SECONDS);
    expect(PRO_LIMITS.pairingInviteSeconds).toBe(PAIRING_INVITE_MAX_SECONDS);
  });
});
