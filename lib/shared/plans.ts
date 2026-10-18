/**
 * Plan numbers (07 §1). Isomorphic: the UI uses them as hints and the pricing page shows them; the
 * server enforces them through lib/server/entitlements (resolve.ts). Values marked (assumed) are the
 * documented recommendations for open questions Q-007 and Q-030 (phase 1 §17.2) and Q-027
 * (phase 2 §17.2). Pro values are the phase 4 proposals (§17.6.4, D4-9) until Q-006, Q-007 and
 * Q-015 are answered. Byte limits are binary, as the code counts them (1 GB = 1 GiB).
 *
 * Key names are stored in entitlement snapshots (shares, links): never rename one (C4-4).
 */

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;
const MINUTE = 60;
const HOUR = 3600;
const DAY = 24 * HOUR;

export type PlanId = "free" | "pro";

export type Limits = {
  maxFileBytes: number;
  maxFilesPerShare: number;
  maxTextBytes: number;
  activeStorageBytes: number;
  dailyUploadBytes: number;
  /** Per network space or requester key; null when the plan's volume isn't counted per network (D4-10). */
  dailyUploadBytesPerNetwork: number | null;
  /** Every share's expiry options (the name is from Phase 1, when shares were local only). */
  localExpiryOptionsSeconds: readonly number[];
  localDefaultExpirySeconds: number;
  maxPreviewBytes: number;
  historyRetentionDays: number;
  /** A link never outlives its share; omitted, it lasts as long as the share. */
  linkExpiryOptionsSeconds: readonly number[];
  shortCodeExpiryOptionsSeconds: readonly number[];
  shortCodeDefaultExpirySeconds: number;
  shortCodeMaxTtlSeconds: number;
  /** Download and preview URLs per link per day, from the link's snapshot. */
  linkDailyUrlIssuances: number;
  /** Phase 4: active devices of a permanent account (D4-5); anonymous users are one browser each. */
  maxSignedInDevices: number;
  /** Phase 4 rooms (D4-14, D4-16, D4-17): enforced when rooms are built (P4-17 … P4-19). */
  maxRooms: number;
  maxRoomMembers: number;
  inviteLinkMaxSeconds: number;
  pairingInviteSeconds: number;
  roomLinkExpiryOptionsSeconds: readonly number[];
  /** The plan-dependent rate limits, per user per hour (03 §10, D4-29). The others are fixed. */
  rateLimits: { createShare: number; createLink: number };
};

export type Features = {
  burnAfterDownload: boolean;
  linkPasswords: boolean;
  privateRooms: boolean;
  customRoomNames: boolean;
  roomLinks: boolean;
  multiUseInvites: boolean;
  executablesInRemoteLinks: boolean;
  transferHistory: boolean;
  extendExpiry: boolean;
  adminControls: boolean;
  brandedPages: boolean;
};

export type FeatureName = keyof Features;

export const FREE_LIMITS = {
  maxFileBytes: 100 * MB,
  maxFilesPerShare: 20, // (assumed) Q-007
  maxTextBytes: 100 * KB, // (assumed) Q-007
  activeStorageBytes: 2 * GB, // (assumed) Q-007
  dailyUploadBytes: 2 * GB, // (assumed) Q-007
  dailyUploadBytesPerNetwork: 10 * GB, // (assumed) Q-007
  localExpiryOptionsSeconds: [HOUR, DAY, 7 * DAY], // (assumed) Q-030
  localDefaultExpirySeconds: DAY, // (assumed) Q-030
  maxPreviewBytes: 20 * MB, // 03 §6
  historyRetentionDays: 30, // tombstones only; Free has no history (07 §1)
  // Remote links (Phase 2). A link never outlives its share; omitted, it lasts as long as the share.
  linkExpiryOptionsSeconds: [HOUR, DAY, 7 * DAY],
  shortCodeExpiryOptionsSeconds: [10 * MINUTE, HOUR, DAY], // DEC-014: Free codes ≤ 24 h
  shortCodeDefaultExpirySeconds: HOUR,
  shortCodeMaxTtlSeconds: DAY,
  linkDailyUrlIssuances: 500, // (assumed) Q-027: download and preview URLs per link per day
  // Phase 4. Free accounts have the same device cap (D4-5) and no rooms; a downgraded owner's
  // existing room keeps its own snapshot, and may still make pairing invites (D4-16).
  maxSignedInDevices: 10,
  maxRooms: 0,
  maxRoomMembers: 0,
  inviteLinkMaxSeconds: 0,
  pairingInviteSeconds: 10 * MINUTE,
  roomLinkExpiryOptionsSeconds: [],
  rateLimits: { createShare: 30, createLink: 30 },
} as const satisfies Limits;

export const FREE_FEATURES = {
  burnAfterDownload: false,
  linkPasswords: false,
  privateRooms: false,
  customRoomNames: false,
  roomLinks: false,
  multiUseInvites: false,
  executablesInRemoteLinks: false,
  transferHistory: false,
  extendExpiry: false,
  adminControls: false,
  brandedPages: false,
} as const satisfies Features;

/**
 * Pro (phase 4 §17.6.4). Proposals until Q-006, Q-007 and Q-015 are answered (D4-9: binary units).
 * Recommended decisions applied: D4-10 Pro volume isn't counted per network (it is charged to the
 * account); D4-11 executables stay blocked in remote links until malware scanning (Phase 6); D4-14
 * 20 rooms of up to 50 members; D4-17 room links 1 h … 30 d; D4-29 300 shares and links per hour;
 * Q-015 history 1 year; DEC-014 short codes up to 7 days.
 */
export const PRO_LIMITS = {
  maxFileBytes: 5 * GB, // above 100 MiB by multipart upload (DEC-026, P4-14)
  maxFilesPerShare: 100,
  maxTextBytes: 1 * MB, // the database's hard cap (DEC-027)
  activeStorageBytes: 100 * GB,
  dailyUploadBytes: 200 * GB,
  dailyUploadBytesPerNetwork: null,
  localExpiryOptionsSeconds: [HOUR, DAY, 7 * DAY, 30 * DAY, 90 * DAY],
  localDefaultExpirySeconds: DAY,
  maxPreviewBytes: 20 * MB,
  historyRetentionDays: 365,
  linkExpiryOptionsSeconds: [HOUR, DAY, 7 * DAY, 30 * DAY, 90 * DAY],
  shortCodeExpiryOptionsSeconds: [10 * MINUTE, HOUR, DAY, 7 * DAY],
  shortCodeDefaultExpirySeconds: HOUR,
  shortCodeMaxTtlSeconds: 7 * DAY,
  linkDailyUrlIssuances: 10_000,
  maxSignedInDevices: 10,
  maxRooms: 20,
  maxRoomMembers: 50,
  inviteLinkMaxSeconds: 7 * DAY,
  pairingInviteSeconds: 10 * MINUTE,
  roomLinkExpiryOptionsSeconds: [HOUR, DAY, 7 * DAY, 30 * DAY],
  rateLimits: { createShare: 300, createLink: 300 },
} as const satisfies Limits;

export const PRO_FEATURES = {
  burnAfterDownload: true,
  linkPasswords: true,
  privateRooms: true,
  customRoomNames: true,
  roomLinks: true, // Q-009 (recommended Pro-only)
  multiUseInvites: true,
  executablesInRemoteLinks: false, // D4-11
  transferHistory: true,
  extendExpiry: true,
  adminControls: false, // Team (Phase 5)
  brandedPages: false, // Team (Phase 5)
} as const satisfies Features;

/**
 * One presigned PUT carries a file of at most 100 MiB (DEC-026); a larger file goes up in parts
 * (multipart, P4-14). Until P4-14 no plan could upload more (deviation DV4-17, now closed).
 */
export const SINGLE_PUT_MAX_BYTES = 100 * MB;

/**
 * The largest file this build delivers: Pro's 5 GiB by multipart upload. An operator override can't
 * go beyond it: extend by copy (P4-15) copies an object in one CopyObject, at most 5 GiB. What a plan
 * delivers (deliverableLimits) is what the server enforces, the UI offers and the pricing page shows.
 */
export const MAX_DELIVERABLE_FILE_BYTES = 5 * GB;

export function deliverableLimits<T extends Limits>(limits: T): T {
  return limits.maxFileBytes <= MAX_DELIVERABLE_FILE_BYTES ? limits : { ...limits, maxFileBytes: MAX_DELIVERABLE_FILE_BYTES };
}

/**
 * Features this build has screens and enforcement for. The pricing page and upgrade hints mention
 * only these, so they never promise what doesn't exist yet; each Phase 4D task adds its feature
 * (extend P4-15, passwords P4-16, private rooms with custom names and invite links P4-17, room links P4-19 and
 * history P4-20, done).
 */
export const AVAILABLE_FEATURES: readonly FeatureName[] = [
  "burnAfterDownload",
  "extendExpiry",
  "linkPasswords",
  "privateRooms",
  "customRoomNames",
  "multiUseInvites",
  "roomLinks",
  "transferHistory",
];

/**
 * How long an invite link to a room may last (phase 4 §17.8.4.1): the owner chooses one, never longer than the plan's
 * inviteLinkMaxSeconds (7 days on Pro, E21).
 */
export const INVITE_LINK_EXPIRY_OPTIONS_SECONDS: readonly number[] = [HOUR, DAY, 7 * DAY];

/**
 * A QR pairing code's lifetime (phase 4 §17.8.4.1, P4-18): the plan's pairingInviteSeconds, never more than 10 minutes,
 * which is also the database's cap (room_invites_lifetime).
 */
export const PAIRING_INVITE_MAX_SECONDS = 10 * MINUTE;

/** Prices (Q-006): none until the owner sets them; the pricing page shows the placeholder. */
export const PRICING: { pro: { monthly: string | null; yearly: string | null } } = {
  pro: { monthly: null, yearly: null },
};

export const EXPIRY_LABELS: Record<number, string> = {
  [10 * MINUTE]: "10 minutes",
  [HOUR]: "1 hour",
  [DAY]: "24 hours",
  [7 * DAY]: "7 days",
  [30 * DAY]: "30 days",
  [90 * DAY]: "90 days",
};
