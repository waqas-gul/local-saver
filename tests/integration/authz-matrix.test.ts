import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccount, signInByCode } from "./support/accounts";
import { proDevice } from "./support/entitlements";
import { adminDb, api, closeAdminDb, Device, newNetwork, PNG_BYTES, setFlag, turnstilePass, Viewer } from "./support/api";
import { createInvite, createRoom, createRoomLink, join as joinRoom, memberIdOf } from "./support/rooms";

/**
 * IDOR matrix as code (09 §5, AC-1.3, Phase 2 T-029). Mirrors 03 §9: the local-mode rows and,
 * from Phase 2, link viewers of this share and of another share.
 * The first test fails if any route or method under app/api/v1 has no entry here.
 * Phase 3 adds the burn-after-download routes (reveal, confirm-received), /me/entitlements and
 * /health/cron; the burn rows target burn shares (phase 3 §17.15 "IDOR matrix extended").
 * Phase 4A adds the account routes (/me, profile, devices, merge). The creator is now an account and
 * creatorOther is a real second sign-in of it: Phase 1–3 faked a second device with the creator's
 * own token, which the device-session binding no longer allows (C4-2; deviation DV4-2).
 * Phase 4B adds proOther, a Pro account on another network (§17.19.8): a plan raises limits, never
 * access, so wherever it appears it gets exactly what a Free stranger gets.
 * Phase 4C adds the billing routes: checkout and portal act only for the caller's own account; the
 * provider's webhook and the internal reconcile route ignore sessions entirely (a signature or a
 * bearer secret, which no actor here holds).
 * Phase 4D (P4-14) adds the upload routes: a fresh PUT URL and the multipart routes, for the creator's
 * pending files only, from any of the creator's devices. The multipart file was started while the creator
 * was Pro (an override, revoked at once: an upload begun on Pro may finish, D4-27).
 * Phase 4D (P4-15) adds extend: the creator's devices only. Extending is Pro (E6), so the creator holds a Pro
 * override for that row alone; everyone else gets what they get for any creator action.
 * Phase 4D (P4-16) adds link passwords: PATCH on a link, its creator's devices only (the row removes an absent
 * password, which needs no plan and changes nothing), and the password route, for a browser holding a grant for
 * this link (the link has no password, so there is nothing to prove: 204). passwords.test.ts covers the rest.
 * Phase 4D (P4-17) adds private rooms (§17.11.1, §17.19.8) and three actors: a room's owner (a Pro account), an
 * anonymous member who joined by an invite link, and a member the owner removed. For every other actor a room is
 * someone else's: 404, as for a room that doesn't exist, whatever their network or plan. Preview and accept are
 * the invite secret's: whoever holds it and a session gets the same answer (accept joins a separate room, so the
 * other rows keep their meaning). rooms.test.ts covers the rest (T4-R1 … R14). Phase 4D (P4-18): creating a QR
 * pairing code is the same route with another body; it runs again with that body against the same row, and
 * pairing.test.ts covers the rest. Phase 4D (P4-19): read-only room links add two routes and two actors, a browser
 * holding a grant for a link to the room and one holding a grant for another room's link. Neither has a Supabase
 * session (401 wherever a link viewer gets 401), and on the share link's viewer routes their grants open nothing:
 * they get what another link's viewer gets (T4-R5). room-links.test.ts covers the rest (T4-R5, R6, R12).
 * Phase 4D (P4-22) adds account deletion: the request and the cancel act only on the caller's own account (no ID in
 * either). The cancel row runs with the creator's deletion scheduled, so a stranger finds nothing to cancel; both rows
 * then cancel every actor's deletion (a scheduled one makes the account read-only for the rows after them).
 * account-deletion.test.ts covers the rest (T4-A5, T4-A6).
 */

type Actor =
  | "anonymous" // no session, no link cookie
  | "sameNetwork" // a device on the share's network, not the creator
  | "otherNetwork" // a device on a different network
  | "leftNetwork" // was on the share's network, now elsewhere
  | "blockedNetwork" // on the share's network while it is blocked (stands for every non-ok status)
  | "linkViewer" // a browser holding a grant for this share's link (no Supabase session)
  | "otherLinkViewer" // a browser holding a grant for another share's link
  | "creatorSame" // the creator, on the share's network
  | "creatorOther" // the creator's second device (another sign-in of the account), on another network
  | "proOther" // Phase 4B: a Pro account (by override), not the creator, on another network
  | "removedMember" // Phase 4D (P4-17): joined the room, then removed by its owner
  | "roomMember" // an anonymous browser that joined the room by its invite link
  | "roomOwner" // the room's owner (a Pro account)
  | "roomLinkViewer" // Phase 4D (P4-19): a browser holding a grant for a read-only link to the room
  | "otherRoomLinkViewer"; // a browser holding a grant for another room's read-only link

/** An expected status; a list where the status reflects system state rather than the caller (health). */
type Entry = Partial<Record<Actor, number | number[]>>;

const MATRIX: Record<string, Entry> = {
  "GET /api/v1/health": { anonymous: 200 },
  "POST /api/v1/devices": { anonymous: 401, sameNetwork: 200 },
  "PATCH /api/v1/devices/[deviceId]": { anonymous: 401, sameNetwork: 404, proOther: 404, linkViewer: 401, creatorSame: 200 },
  "POST /api/v1/network/observe": { anonymous: 401, sameNetwork: 200, otherNetwork: 200, proOther: 200, blockedNetwork: 200, linkViewer: 401 },
  "GET /api/v1/local/shares": {
    anonymous: 401, sameNetwork: 200, otherNetwork: 200, proOther: 200, leftNetwork: 200, blockedNetwork: 200, linkViewer: 401, creatorSame: 200,
    creatorOther: 200,
  },
  "GET /api/v1/me/shares": { anonymous: 401, sameNetwork: 200, otherNetwork: 200, proOther: 200, linkViewer: 401, creatorSame: 200, creatorOther: 200 },
  "POST /api/v1/shares": { anonymous: 401, sameNetwork: 201, otherNetwork: 201, proOther: 201, blockedNetwork: 409, linkViewer: 401 },
  "POST /api/v1/texts": { anonymous: 401, sameNetwork: 201, otherNetwork: 201, proOther: 201, blockedNetwork: 409, linkViewer: 401 },
  "GET /api/v1/shares/[shareId]": {
    anonymous: 401, sameNetwork: 200, otherNetwork: 404, proOther: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 200, creatorOther: 200,
  },
  "PATCH /api/v1/shares/[shareId]/text": {
    anonymous: 401, sameNetwork: 403, otherNetwork: 404, proOther: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 200, creatorOther: 200,
  },
  "DELETE /api/v1/shares/[shareId]": {
    anonymous: 401, sameNetwork: 403, otherNetwork: 404, proOther: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorOther: 204,
  },
  "POST /api/v1/shares/[shareId]/files/[fileId]/complete": {
    anonymous: 401, sameNetwork: 404, otherNetwork: 404, proOther: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 200,
  },
  "POST /api/v1/files/[fileId]/download-url": {
    anonymous: 401, sameNetwork: 200, otherNetwork: 404, proOther: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 200, creatorOther: 200,
  },
  "POST /api/v1/files/[fileId]/preview-url": {
    anonymous: 401, sameNetwork: 200, otherNetwork: 404, proOther: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 200, creatorOther: 200,
  },

  // Phase 2: creator side. Only the share's creator, from any network (DEC-033, T-011).
  "POST /api/v1/shares/[shareId]/links": {
    anonymous: 401, sameNetwork: 403, otherNetwork: 404, proOther: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, otherLinkViewer: 401,
    creatorSame: 201, creatorOther: 201,
  },
  "GET /api/v1/shares/[shareId]/links": {
    anonymous: 401, sameNetwork: 403, otherNetwork: 404, proOther: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 200, creatorOther: 200,
  },
  "DELETE /api/v1/links/[linkId]": {
    anonymous: 401, sameNetwork: 403, otherNetwork: 404, proOther: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, otherLinkViewer: 401,
    creatorOther: 204,
  },
  "POST /api/v1/links/[linkId]/code": {
    anonymous: 401, sameNetwork: 403, otherNetwork: 404, proOther: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 200, creatorOther: 200,
  },
  // Phase 4D (P4-16): the link's password, its creator's alone (sameNetwork sees the share: 403 NOT_CREATOR).
  "PATCH /api/v1/links/[linkId]": {
    anonymous: 401, sameNetwork: 403, otherNetwork: 404, proOther: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, otherLinkViewer: 401,
    creatorSame: 200, creatorOther: 200,
  },
  // Only a grant for this very link reaches the password check; a device session is no grant.
  "POST /api/v1/links/[linkId]/password": {
    anonymous: 404, sameNetwork: 404, otherNetwork: 404, proOther: 404, linkViewer: 204, otherLinkViewer: 404, creatorSame: 404,
  },
  // Phase 2: link viewers. Only the link's secret (or code) or a grant for this link opens it (T-029, T-030).
  "POST /api/v1/links/[linkId]/unlock": { anonymous: 404, sameNetwork: 404, otherNetwork: 404, proOther: 404, linkViewer: 200, otherLinkViewer: 404 },
  "GET /api/v1/links/[linkId]/content": {
    anonymous: 404, sameNetwork: 404, otherNetwork: 404, proOther: 404, linkViewer: 200, otherLinkViewer: 404, creatorSame: 404,
  },
  "POST /api/v1/links/[linkId]/files/[fileId]/download-url": {
    anonymous: 404, sameNetwork: 404, otherNetwork: 404, proOther: 404, linkViewer: 200, otherLinkViewer: 404, creatorSame: 404,
  },
  "POST /api/v1/links/[linkId]/files/[fileId]/preview-url": {
    anonymous: 404, sameNetwork: 404, otherNetwork: 404, proOther: 404, linkViewer: 200, otherLinkViewer: 404, creatorSame: 404,
  },
  "POST /api/v1/codes/resolve": { anonymous: 404, otherNetwork: 404, proOther: 404, linkViewer: 200, otherLinkViewer: 404 },
  // Reports: whoever can see the share (03 §9 "Report content").
  "POST /api/v1/reports": {
    anonymous: 401, sameNetwork: 201, otherNetwork: 404, proOther: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 201, otherLinkViewer: 404,
    creatorSame: 201, creatorOther: 201,
  },

  // Phase 3: burn after download. Reveal targets an unclaimed burn text: the first device on its
  // network claims it; the creator (any network) reads it without claiming (D-7).
  "POST /api/v1/shares/[shareId]/reveal": {
    anonymous: 401, sameNetwork: 200, otherNetwork: 404, proOther: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorOther: 200, creatorSame: 200,
  },
  // Confirm targets a burn text sameNetwork claimed: only that claimant may end it.
  "POST /api/v1/shares/[shareId]/confirm-received": {
    anonymous: 401, sameNetwork: 204, otherNetwork: 404, proOther: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorOther: 404, creatorSame: 404,
  },
  "POST /api/v1/links/[linkId]/reveal": {
    anonymous: 404, sameNetwork: 404, otherNetwork: 404, proOther: 404, linkViewer: 200, otherLinkViewer: 404, creatorSame: 404,
  },
  "POST /api/v1/links/[linkId]/confirm-received": {
    anonymous: 404, sameNetwork: 404, otherNetwork: 404, proOther: 404, linkViewer: 204, otherLinkViewer: 404, creatorSame: 404,
  },
  "GET /api/v1/me/entitlements": { anonymous: 401, sameNetwork: 200, otherNetwork: 200, proOther: 200, blockedNetwork: 200, linkViewer: 401, creatorSame: 200 },
  // No caller identity: an uptime monitor polls it (D-5). Every caller gets the same answer.
  "GET /api/v1/health/cron": { anonymous: [200, 503], sameNetwork: [200, 503], linkViewer: [200, 503] },

  // Phase 4A: accounts (phase 4 §17.13). sameNetwork and otherNetwork are anonymous browsers; the creator is an account.
  "GET /api/v1/me": { anonymous: 401, sameNetwork: 200, otherNetwork: 200, proOther: 200, linkViewer: 401, creatorOther: 200, creatorSame: 200 },
  "PATCH /api/v1/me/profile": { anonymous: 401, sameNetwork: 403, proOther: 200, linkViewer: 401, creatorOther: 200, creatorSame: 200 },
  // Token only (a browser at the device cap has no device yet): every session sees its own user's devices.
  "GET /api/v1/me/devices": { anonymous: 401, sameNetwork: 200, proOther: 200, linkViewer: 401, creatorOther: 200, creatorSame: 200 },
  // Targets a third device of the creator: other users get 404; creatorOther revokes it, so creatorSame then finds none.
  "DELETE /api/v1/me/devices/[deviceId]": { anonymous: 401, sameNetwork: 404, otherNetwork: 404, proOther: 404, linkViewer: 401, creatorOther: 204, creatorSame: 404 },
  "POST /api/v1/account/merge-intents": { anonymous: 401, sameNetwork: 201, otherNetwork: 201, proOther: 403, linkViewer: 401, creatorSame: 403 },
  // An unknown intent: anonymous sessions can't redeem at all; accounts get the uniform 404.
  "POST /api/v1/account/merge-anonymous": { anonymous: 401, sameNetwork: 403, proOther: 404, linkViewer: 401, creatorOther: 404, creatorSame: 404 },
  // P4-22: each account schedules its own deletion (the creator's second browser first, so its first browser finds it pending).
  "DELETE /api/v1/me": { anonymous: 401, sameNetwork: 403, otherNetwork: 403, proOther: 202, linkViewer: 401, creatorOther: 202, creatorSame: 409 },
  // With the creator's deletion scheduled: a stranger has nothing of theirs to cancel; the creator cancels it once.
  "POST /api/v1/me/deletion/cancel": { anonymous: 401, sameNetwork: 403, proOther: 404, linkViewer: 401, creatorOther: 204, creatorSame: 404 },

  // Phase 4C: billing (phase 4 §17.13). Checkout for the caller's own account only (Pro by override may still subscribe).
  "POST /api/v1/billing/checkout": { anonymous: 401, sameNetwork: 403, otherNetwork: 403, proOther: 201, linkViewer: 401, creatorSame: 201 },
  // Nobody here has a billing customer: the portal opens only for a subscriber's own customer.
  "POST /api/v1/billing/portal": { anonymous: 401, sameNetwork: 403, proOther: 404, linkViewer: 401, creatorSame: 404 },
  // The provider's endpoint: a session or a link grant means nothing without its signature.
  "POST /api/v1/billing/webhook": { anonymous: 400, sameNetwork: 400, proOther: 400, linkViewer: 400, creatorSame: 400 },
  // pg_net's endpoint: only the bearer secret; a user's session token is refused.
  "POST /api/v1/internal/billing/reconcile": { anonymous: 401, sameNetwork: 401, proOther: 401, linkViewer: 401, creatorSame: 401 },

  // Phase 4D: uploads (phase 4 §17.13, P4-14). A pending share is invisible to everyone but its creator.
  "POST /api/v1/shares/[shareId]/files/[fileId]/upload-url": {
    anonymous: 401, sameNetwork: 404, otherNetwork: 404, proOther: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorOther: 200, creatorSame: 200,
  },
  "POST /api/v1/shares/[shareId]/files/[fileId]/multipart/parts": {
    anonymous: 401, sameNetwork: 404, otherNetwork: 404, proOther: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorOther: 200, creatorSame: 200,
  },
  "GET /api/v1/shares/[shareId]/files/[fileId]/multipart": {
    anonymous: 401, sameNetwork: 404, otherNetwork: 404, proOther: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorOther: 200, creatorSame: 200,
  },
  // Phase 4D (P4-15): extend, the creator's alone (sameNetwork sees the share: 403 NOT_CREATOR). Both of the
  // creator's devices extend the same text in place, each later than the last.
  "POST /api/v1/shares/[shareId]/extend": {
    anonymous: 401, sameNetwork: 403, otherNetwork: 404, proOther: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorOther: 200, creatorSame: 200,
  },
  // creatorOther cancels the upload; the share has then ended, so creatorSame finds nothing.
  "POST /api/v1/shares/[shareId]/files/[fileId]/multipart/abort": {
    anonymous: 401, sameNetwork: 404, otherNetwork: 404, proOther: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorOther: 204, creatorSame: 404,
  },

  // Phase 4D (P4-17): private rooms. Listing shows each caller their own rooms; creating one is Pro (E17).
  "GET /api/v1/rooms": {
    anonymous: 401, sameNetwork: 200, otherNetwork: 200, proOther: 200, linkViewer: 401, creatorSame: 200, removedMember: 200, roomMember: 200, roomOwner: 200,
  },
  "POST /api/v1/rooms": {
    anonymous: 401, sameNetwork: 403, otherNetwork: 403, proOther: 201, linkViewer: 401, creatorSame: 403, roomMember: 403, roomOwner: 201,
  },
  // The room: its members only; the owner's settings (members see the room: 403 NOT_OWNER).
  "GET /api/v1/rooms/[roomId]": {
    anonymous: 401, sameNetwork: 404, otherNetwork: 404, proOther: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorOther: 404,
    creatorSame: 404, removedMember: 404, roomMember: 200, roomOwner: 200,
  },
  "PATCH /api/v1/rooms/[roomId]": {
    anonymous: 401, sameNetwork: 404, otherNetwork: 404, proOther: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 404, removedMember: 404,
    roomMember: 403, roomOwner: 200,
  },
  // Targets a second room of the owner's, which the member is also in; the owner deletes it last.
  "DELETE /api/v1/rooms/[roomId]": {
    anonymous: 401, sameNetwork: 404, otherNetwork: 404, proOther: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 404, removedMember: 404,
    roomMember: 403, roomOwner: 204,
  },
  "GET /api/v1/rooms/[roomId]/members": {
    anonymous: 401, sameNetwork: 404, otherNetwork: 404, proOther: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 404, removedMember: 404,
    roomMember: 200, roomOwner: 200,
  },
  // Targets a third member: the member may only remove themselves (403); the owner removes them.
  "DELETE /api/v1/rooms/[roomId]/members/[memberId]": {
    anonymous: 401, sameNetwork: 404, otherNetwork: 404, proOther: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 404, removedMember: 404,
    roomMember: 403, roomOwner: 204,
  },
  "GET /api/v1/rooms/[roomId]/shares": {
    anonymous: 401, sameNetwork: 404, otherNetwork: 404, proOther: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 404,
    removedMember: 404, roomMember: 200, roomOwner: 200,
  },
  "GET /api/v1/rooms/[roomId]/invites": {
    anonymous: 401, sameNetwork: 404, otherNetwork: 404, proOther: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 404, removedMember: 404,
    roomMember: 403, roomOwner: 200,
  },
  "POST /api/v1/rooms/[roomId]/invites": {
    anonymous: 401, sameNetwork: 404, otherNetwork: 404, proOther: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 404, removedMember: 404,
    roomMember: 403, roomOwner: 201,
  },
  // Revoking: the owner of the invite's room; everyone else, members included, the unknown invite's 404.
  // Phase 4D (P4-19): read-only room links, the owner's (Pro, E22); members see the room (403 NOT_OWNER).
  "GET /api/v1/rooms/[roomId]/links": {
    anonymous: 401, sameNetwork: 404, otherNetwork: 404, proOther: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 404, removedMember: 404,
    roomMember: 403, roomOwner: 200, roomLinkViewer: 401, otherRoomLinkViewer: 401,
  },
  "POST /api/v1/rooms/[roomId]/links": {
    anonymous: 401, sameNetwork: 404, otherNetwork: 404, proOther: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 404, removedMember: 404,
    roomMember: 403, roomOwner: 201, roomLinkViewer: 401, otherRoomLinkViewer: 401,
  },
  "DELETE /api/v1/invites/[inviteId]": {
    anonymous: 401, sameNetwork: 404, otherNetwork: 404, proOther: 404, linkViewer: 401, creatorSame: 404, removedMember: 404, roomMember: 404, roomOwner: 204,
  },
  // The invite's secret is the capability: any session holding it (a browser with no session can't join).
  "POST /api/v1/invites/[inviteId]/preview": {
    anonymous: 401, sameNetwork: 200, otherNetwork: 200, proOther: 200, linkViewer: 401, creatorSame: 200, removedMember: 200, roomMember: 200, roomOwner: 200,
  },
  "POST /api/v1/invites/[inviteId]/accept": {
    anonymous: 401, sameNetwork: 200, otherNetwork: 200, proOther: 200, linkViewer: 401, creatorSame: 200, removedMember: 200, roomMember: 200, roomOwner: 200,
  },

  // Phase 4D (P4-20): transfer history (E24). Always the caller's own, so no ID in the path: Pro accounts 200, anonymous
  // browsers and Free accounts (the creator) 403 FEATURE_NOT_IN_PLAN. history.test.ts probes another user's shareId.
  "GET /api/v1/history/shares": {
    anonymous: 401, sameNetwork: 403, otherNetwork: 403, proOther: 200, leftNetwork: 403, blockedNetwork: 403, linkViewer: 401, creatorOther: 403,
    creatorSame: 403, removedMember: 403, roomMember: 403, roomOwner: 200,
  },
  "GET /api/v1/history/downloads": {
    anonymous: 401, sameNetwork: 403, otherNetwork: 403, proOther: 200, leftNetwork: 403, blockedNetwork: 403, linkViewer: 401, creatorOther: 403,
    creatorSame: 403, removedMember: 403, roomMember: 403, roomOwner: 200,
  },
};

// Phase 4D (P4-19): room-link viewers wherever the existing rows don't name them. They have no Supabase session (401
// where a link viewer gets 401); elsewhere their grants are for room links only, so they get what a viewer holding a
// grant for another link gets (404 on the share link's viewer routes, T4-R5), or, where nobody's grant matters, what a
// link viewer gets.
for (const entry of Object.values(MATRIX)) {
  if (entry.roomLinkViewer !== undefined) continue;
  const derived = entry.linkViewer === 401 ? 401 : (entry.otherLinkViewer ?? entry.linkViewer);
  if (derived === undefined) continue;
  entry.roomLinkViewer = derived;
  entry.otherRoomLinkViewer = derived;
}

const ACTOR_ORDER: Actor[] = [
  "anonymous", "sameNetwork", "otherNetwork", "proOther", "leftNetwork", "blockedNetwork", "linkViewer", "otherLinkViewer", "creatorOther", "creatorSame",
  "removedMember", "roomMember", "roomOwner", "roomLinkViewer", "otherRoomLinkViewer",
];
const VIEWERS = ["linkViewer", "otherLinkViewer", "roomLinkViewer", "otherRoomLinkViewer"] as const;
type ViewerActor = (typeof VIEWERS)[number];
const isViewer = (actor: Actor): actor is ViewerActor => (VIEWERS as readonly string[]).includes(actor);

function discoverRoutes(): string[] {
  const root = join(process.cwd(), "app", "api", "v1");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "route.ts") {
        const path = `/api/v1/${relative(root, dir).split(sep).join("/")}`.replace(/\/$/, "");
        const source = readFileSync(full, "utf8");
        for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
          if (new RegExp(`export\\s+(const|async\\s+function|function)\\s+${method}\\b`).test(source)) {
            found.push(`${method} ${path}`);
          }
        }
      }
    }
  };
  walk(root);
  return found.sort();
}

describe("authorization matrix coverage", () => {
  it("has an entry for every route and method, and no stale entries", () => {
    expect(Object.keys(MATRIX).sort()).toEqual(discoverRoutes());
  });
});

describe("authorization matrix (03 §9: local mode and link viewers)", () => {
  const actors = {} as Record<Exclude<Actor, "anonymous" | ViewerActor>, Device>;
  const viewers = {} as Record<ViewerActor, Viewer>;
  const ids = {
    text: "",
    deletable: "",
    file: "",
    imageShare: "",
    pendingShare: "",
    pendingFile: "",
    // Phase 4D: a pending single-PUT file (upload-url) and a pending multipart file.
    urlShare: "",
    urlFile: "",
    multipartShare: "",
    multipartFile: "",
    // Phase 4D (P4-15): a text to extend, and the creator's user ID for its Pro override.
    extendText: "",
    creatorUser: "",
    blockedText: "",
    blockedFile: "",
    // Phase 2: a link (with a code) to the image share, another share's link, links to revoke.
    link: "",
    linkSecret: "",
    linkCode: "",
    otherLink: "",
    otherLinkSecret: "",
    revocable: "",
    blockedLink: "",
    // Phase 3: burn texts on the creator's network, and burn link-only texts with links.
    burnReveal: "",
    burnConfirm: "",
    burnLinkReveal: "",
    burnLinkConfirm: "",
    // Phase 4A: a third device of the creator's account, for the revoke row.
    revocableDevice: "",
    // Phase 4D (P4-17): the room, a second room to delete, a member to remove, an invite to revoke, and a third room
    // whose invite every session previews and accepts.
    room: "",
    deletableRoom: "",
    removableMember: "",
    revocableInvite: "",
    lobbyInvite: "",
    lobbySecret: "",
  };

  beforeAll(async () => {
    const home = newNetwork();
    const blockedNet = newNetwork();

    const account = await createAccount();
    const creator = await Device.attach(await signInByCode(account.email), home.ip());
    actors.creatorSame = creator;
    actors.sameNetwork = await Device.create(home.ip());
    actors.otherNetwork = await Device.create(newNetwork().ip());
    actors.proOther = (await proDevice(newNetwork().ip())).device;
    actors.leftNetwork = await Device.create(home.ip());

    ids.text = (await creator.postText("matrix text")).id;
    ids.extendText = (await creator.postText("matrix extend")).id;
    ids.creatorUser = account.userId;
    ids.deletable = (await creator.postText("matrix delete")).id;
    const image = await creator.uploadFile("m.png", PNG_BYTES, "image/png");
    ids.file = image.upload.fileId;
    ids.imageShare = image.init.body.share.id;

    const pending = await creator.call("POST", "/api/v1/shares", {
      destination: "network",
      files: [{ name: "p.bin", size: 3, type: "application/octet-stream" }],
    });
    ids.pendingShare = pending.body.share.id;
    ids.pendingFile = pending.body.uploads[0].fileId;
    await fetch(pending.body.uploads[0].url, {
      method: "PUT",
      headers: pending.body.uploads[0].headers,
      body: Buffer.from([1, 2, 3]),
    });
    const forUrl = await creator.call("POST", "/api/v1/shares", { destination: "network", files: [{ name: "u.bin", size: 3, type: "application/octet-stream" }] });
    ids.urlShare = forUrl.body.share.id;
    ids.urlFile = forUrl.body.uploads[0].fileId;
    const { rows: grant } = await adminDb().query("select app.admin_grant_override($1, 'plan', '\"pro\"', 'matrix', 'tests', null) as id", [account.userId]);
    const big = await creator.call("POST", "/api/v1/shares", {
      destination: "network",
      files: [{ name: "big.bin", size: 100 * 1024 * 1024 + 1, type: "application/octet-stream" }],
    });
    await adminDb().query("select app.admin_revoke_override($1, 'matrix', 'tests')", [grant[0].id]);
    ids.multipartShare = big.body.share.id;
    ids.multipartFile = big.body.uploads[0].fileId;

    // Links: this share (the image), another share, and one only for revoking.
    const link = await creator.createLink(ids.imageShare, { shortCode: {} });
    ids.link = link.id;
    ids.linkSecret = link.secret;
    ids.linkCode = link.shortCode!.code;
    const otherLink = await creator.createLink((await creator.postText("another share")).id);
    ids.otherLink = otherLink.id;
    ids.otherLinkSecret = otherLink.secret;
    ids.revocable = (await creator.createLink(ids.text)).id;
    viewers.linkViewer = new Viewer();
    viewers.otherLinkViewer = new Viewer();
    expect((await viewers.linkViewer.unlock(ids.link, ids.linkSecret)).status).toBe(200);
    expect((await viewers.otherLinkViewer.unlock(ids.otherLink, ids.otherLinkSecret)).status).toBe(200);

    // The creator's second device: another sign-in of the same account, on another network.
    actors.creatorOther = await Device.attach(await signInByCode(account.email), newNetwork().ip());
    ids.revocableDevice = (await Device.attach(await signInByCode(account.email), newNetwork().ip(), { observe: false })).deviceId;

    // Burn after download (Phase 3): two network texts, one already claimed by sameNetwork, and two
    // link-only texts whose links linkViewer unlocked, one of them already claimed by linkViewer.
    await setFlag("free_burn_after_download", true);
    ids.burnReveal = (await creator.postBurnText("burn to reveal")).id;
    ids.burnConfirm = (await creator.postBurnText("burn to confirm")).id;
    expect((await actors.sameNetwork.call("POST", `/api/v1/shares/${ids.burnConfirm}/reveal`, { confirm: true })).status).toBe(200);
    for (const key of ["burnLinkReveal", "burnLinkConfirm"] as const) {
      const share = await creator.postBurnText(`burn ${key}`, "link_only");
      const burnLink = await creator.createLink(share.id);
      ids[key] = burnLink.id;
      expect((await viewers.linkViewer.unlock(burnLink.id, burnLink.secret)).status).toBe(200);
    }
    expect((await viewers.linkViewer.call("POST", `/api/v1/links/${ids.burnLinkConfirm}/reveal`, { confirm: true })).status).toBe(200);

    await actors.leftNetwork.moveTo(newNetwork().ip());

    // A blocked network with content (and a link) made before the block.
    const blockedCreator = await Device.create(blockedNet.ip());
    ids.blockedText = (await blockedCreator.postText("before the block")).id;
    ids.blockedFile = (await blockedCreator.uploadFile("b.png", PNG_BYTES, "image/png")).upload.fileId;
    ids.blockedLink = (await blockedCreator.createLink(ids.blockedText)).id;
    actors.blockedNetwork = await Device.create(blockedNet.ip());
    const [blockedSpace] = (await actors.blockedNetwork.observe()).spaceIds;
    await adminDb().query("update app.network_spaces set status = 'blocked' where id = $1", [blockedSpace]);

    // Phase 4D (P4-17): a Pro owner's room with a member, a member to remove and a removed member; a second room
    // (the member in it, the removed member removed from it too) to delete; and a third room to join by invite.
    const roomOwner = (await proDevice(newNetwork().ip())).device;
    actors.roomOwner = roomOwner;
    actors.roomMember = await Device.create(newNetwork().ip());
    actors.removedMember = await Device.create(newNetwork().ip());
    const room = await createRoom(roomOwner);
    const doomed = await createRoom(roomOwner);
    ids.room = room.id;
    ids.deletableRoom = doomed.id;
    for (const target of [room, doomed]) {
      const invite = await createInvite(roomOwner, target.id);
      await joinRoom(actors.roomMember, invite);
      await joinRoom(actors.removedMember, invite);
      const removed = await roomOwner.call("DELETE", `/api/v1/rooms/${target.id}/members/${await memberIdOf(actors.removedMember, target.id)}`);
      expect(removed.status).toBe(204);
    }
    const removable = await Device.create(newNetwork().ip());
    await joinRoom(removable, await createInvite(roomOwner, room.id));
    ids.removableMember = await memberIdOf(removable, room.id);
    ids.revocableInvite = (await createInvite(roomOwner, room.id)).inviteId;
    const lobbyRoom = await createRoom(roomOwner);
    const lobby = await createInvite(roomOwner, lobbyRoom.id);
    ids.lobbyInvite = lobby.inviteId;
    ids.lobbySecret = lobby.secret;

    // Phase 4D (P4-19): a viewer of a read-only link to the room, and one of a link to another room (the lobby room).
    const roomLink = await createRoomLink(roomOwner, room.id);
    const otherRoomLink = await createRoomLink(roomOwner, lobbyRoom.id);
    viewers.roomLinkViewer = new Viewer();
    viewers.otherRoomLinkViewer = new Viewer();
    expect((await viewers.roomLinkViewer.unlock(roomLink.id, roomLink.secret)).status).toBe(200);
    expect((await viewers.otherRoomLinkViewer.unlock(otherRoomLink.id, otherRoomLink.secret)).status).toBe(200);
  });

  afterAll(async () => {
    await setFlag("free_burn_after_download", false);
    await closeAdminDb();
  });

  /** Resource IDs per actor: the blocked-network actor targets the blocked network's content. */
  function params(actor: Actor) {
    const blocked = actor === "blockedNetwork";
    return {
      shareId: blocked ? ids.blockedText : ids.text,
      fileId: blocked ? ids.blockedFile : ids.file,
      deviceId: actors.creatorSame.deviceId,
      linkId: blocked ? ids.blockedLink : ids.link,
    };
  }

  async function bodyFor(route: string, actor: Actor): Promise<unknown> {
    if (route.startsWith("PATCH /api/v1/shares/")) {
      const { rows } = await adminDb().query("select version from app.text_items where share_id = $1", [params(actor).shareId]);
      return { content: `edit by ${actor}`, version: rows[0]?.version ?? 1 };
    }
    if (route === "PATCH /api/v1/devices/[deviceId]") return { label: "Renamed" };
    if (route === "PATCH /api/v1/me/profile") return { displayName: `Matrix ${actor}` };
    if (route === "POST /api/v1/account/merge-anonymous") return { intentId: randomUUID(), secret: randomBytes(32).toString("base64url") };
    if (route === "POST /api/v1/shares") {
      return { destination: "network", files: [{ name: "n.txt", size: 1, type: "text/plain" }] };
    }
    if (route === "POST /api/v1/texts") return { destination: "network", content: `post by ${actor}` };
    if (route === "POST /api/v1/links/[linkId]/unlock") {
      const secret = actor === "linkViewer" ? ids.linkSecret : actor === "otherLinkViewer" ? ids.otherLinkSecret : randomBytes(32).toString("base64url");
      return { secret };
    }
    if (route === "POST /api/v1/codes/resolve") return { code: actor === "linkViewer" ? ids.linkCode : "0000000000" };
    if (route.endsWith("/reveal")) return { confirm: true };
    if (route === "POST /api/v1/reports") {
      const target = isViewer(actor) ? { type: "link", linkId: ids.link } : { type: "share", shareId: params(actor).shareId };
      return { target, category: "spam", turnstileToken: turnstilePass() };
    }
    if (route === "POST /api/v1/billing/checkout") return { plan: "pro", interval: "month" };
    if (route === "POST /api/v1/shares/[shareId]/extend") return { expiresIn: 86_400 };
    if (route === "PATCH /api/v1/links/[linkId]") return { password: null };
    if (route === "POST /api/v1/links/[linkId]/password") return { password: "matrix password" };
    if (route === "PATCH /api/v1/rooms/[roomId]") return { membersCanCreateLinks: true };
    if (route === "POST /api/v1/rooms/[roomId]/invites") return { kind: "invite_link", expiresIn: 3600 };
    if (route === "POST /api/v1/rooms/[roomId]/links") return { expiresIn: 86_400 };
    if (route.startsWith("POST /api/v1/invites/")) return { secret: ids.lobbySecret };
    if (route.endsWith("/multipart/parts")) return { partNumbers: [1] };
    return route.startsWith("POST") || route.startsWith("PATCH") ? {} : undefined;
  }

  /** Request headers a route needs besides the caller's own (Phase 4C: checkout's Idempotency-Key). */
  function headersFor(route: string): Record<string, string> {
    return route === "POST /api/v1/billing/checkout" ? { "idempotency-key": randomUUID() } : {};
  }

  function pathFor(route: string, actor: Actor): string {
    const p = params(actor);
    let path = route.split(" ")[1] as string;
    if (route === "DELETE /api/v1/shares/[shareId]") path = path.replace("[shareId]", actor === "blockedNetwork" ? ids.blockedText : ids.deletable);
    if (route === "DELETE /api/v1/links/[linkId]") path = path.replace("[linkId]", actor === "blockedNetwork" ? ids.blockedLink : ids.revocable);
    if (route === "DELETE /api/v1/me/devices/[deviceId]") path = path.replace("[deviceId]", ids.revocableDevice);
    if (route.includes("/complete")) {
      path = path.replace("[shareId]", ids.pendingShare).replace("[fileId]", ids.pendingFile);
    }
    if (route.includes("/upload-url")) path = path.replace("[shareId]", ids.urlShare).replace("[fileId]", ids.urlFile);
    if (route.includes("/multipart")) path = path.replace("[shareId]", ids.multipartShare).replace("[fileId]", ids.multipartFile);
    if (route.endsWith("/extend") && actor !== "blockedNetwork") path = path.replace("[shareId]", ids.extendText);
    if (route === "DELETE /api/v1/rooms/[roomId]") path = path.replace("[roomId]", ids.deletableRoom);
    if (route === "DELETE /api/v1/invites/[inviteId]") path = path.replace("[inviteId]", ids.revocableInvite);
    path = path.replace("[roomId]", ids.room).replace("[memberId]", ids.removableMember).replace("[inviteId]", ids.lobbyInvite);
    if (actor !== "blockedNetwork") {
      if (route === "POST /api/v1/shares/[shareId]/reveal") path = path.replace("[shareId]", ids.burnReveal);
      if (route === "POST /api/v1/shares/[shareId]/confirm-received") path = path.replace("[shareId]", ids.burnConfirm);
      if (route === "POST /api/v1/links/[linkId]/reveal") path = path.replace("[linkId]", ids.burnLinkReveal);
      if (route === "POST /api/v1/links/[linkId]/confirm-received") path = path.replace("[linkId]", ids.burnLinkConfirm);
    }
    return path
      .replace("[shareId]", p.shareId)
      .replace("[fileId]", p.fileId)
      .replace("[deviceId]", p.deviceId)
      .replace("[linkId]", p.linkId);
  }

  for (const [route, expectations] of Object.entries(MATRIX)) {
    it(route, async () => {
      const method = route.split(" ")[0] as string;
      const seen = new Set<number>();
      // Extend is Pro (E6): the creator is Pro for this row only.
      const override = route.endsWith("/extend")
        ? ((await adminDb().query("select app.admin_grant_override($1, 'plan', '\"pro\"', 'matrix', 'tests', null) as id", [ids.creatorUser])).rows[0].id as string)
        : null;
      const deletionRow = route === "DELETE /api/v1/me" || route === "POST /api/v1/me/deletion/cancel";
      if (route === "POST /api/v1/me/deletion/cancel") {
        await adminDb().query("select app.ensure_profile($1), app.request_account_deletion($1, interval '7 days')", [ids.creatorUser]);
      }
      try {
        for (const actor of ACTOR_ORDER) {
          const expected = expectations[actor];
          if (expected === undefined) continue;
          const path = pathFor(route, actor);
          const body = await bodyFor(route, actor);
          const headers = headersFor(route);
          const response =
            actor === "anonymous"
              ? await api(method, path, { body, ip: newNetwork().ip(), headers })
              : isViewer(actor)
                ? await viewers[actor].call(method, path, body, { headers })
                : await actors[actor].call(method, path, body, { headers });
          if (Array.isArray(expected)) {
            expect(expected, `${actor}: ${method} ${path} → ${response.status}`).toContain(response.status);
            seen.add(response.status);
            expect(seen.size, `${route}: every caller gets the same answer`).toBe(1);
          } else {
            expect(response.status, `${actor}: ${method} ${path} → ${response.text.slice(0, 200)}`).toBe(expected);
          }
          // A new code replaces the old one; later rows must use the current code.
          if (route === "POST /api/v1/links/[linkId]/code" && response.status === 200) ids.linkCode = response.body.shortCode.code;
        }
      } finally {
        if (override) await adminDb().query("select app.admin_revoke_override($1, 'matrix', 'tests')", [override]);
        if (deletionRow) {
          const users = Object.values(actors).map((d) => d.userId);
          await adminDb().query("select app.cancel_account_deletion(u) from unnest($1::uuid[]) as u", [users]);
        }
      }
    });
  }

  // Phase 4D (P4-18): the same route with a pairing body (one use, 10 minutes, E20) gives every actor the same answer.
  it("POST /api/v1/rooms/[roomId]/invites with a pairing body", async () => {
    const route = "POST /api/v1/rooms/[roomId]/invites";
    for (const actor of ACTOR_ORDER) {
      const expected = MATRIX[route]![actor];
      if (expected === undefined) continue;
      const path = pathFor(route, actor);
      const body = { kind: "pairing" };
      const response =
        actor === "anonymous"
          ? await api("POST", path, { body, ip: newNetwork().ip() })
          : isViewer(actor)
            ? await viewers[actor].call("POST", path, body)
            : await actors[actor].call("POST", path, body);
      expect(response.status, `${actor}: POST ${path} (pairing) → ${response.text.slice(0, 200)}`).toBe(expected);
      if (response.status === 201) expect(response.body.invite).toMatchObject({ kind: "pairing", maxUses: 1 });
    }
  });

  it("feeds and My uploads list exactly what each actor may see", async () => {
    const feed = async (d: Device) => ((await d.call("GET", "/api/v1/local/shares")).body.shares as { id: string }[]).map((s) => s.id);
    const mine = async (d: Device) => ((await d.call("GET", "/api/v1/me/shares")).body.shares as { id: string }[]).map((s) => s.id);
    expect(await feed(actors.sameNetwork)).toContain(ids.text);
    expect(await feed(actors.creatorSame)).toContain(ids.text);
    for (const actor of ["otherNetwork", "proOther", "leftNetwork", "creatorOther"] as const) {
      expect(await feed(actors[actor]), actor).not.toContain(ids.text);
    }
    expect(await mine(actors.proOther)).not.toContain(ids.text);
    expect(await feed(actors.blockedNetwork)).toEqual([]);
    expect(await mine(actors.creatorOther)).toContain(ids.text);
    expect(await mine(actors.sameNetwork)).not.toContain(ids.text);
  });
});
