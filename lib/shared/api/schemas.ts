import { z } from "zod";

/**
 * API contracts for /api/v1, shared by the server (input validation) and the client
 * (response parsing before data enters the TanStack Query cache, 02 §8).
 * Request bodies are strict: unknown fields such as a network or space ID are rejected (T-010).
 */

// zod 4 probes for eval (`new Function`) when an object schema is built. The browser's CSP
// reports that probe as a violation even though zod catches it, so in browsers the
// eval-compiled fast path is turned off before any schema below is constructed.
if (typeof window !== "undefined") z.config({ jitless: true });

// ---------------------------------------------------------------------------- devices
export const registerDeviceBody = z.object({}).strict();

export const renameDeviceBody = z
  .object({ label: z.string().max(200) })
  .strict();

export const deviceDto = z.object({
  id: z.uuid(),
  label: z.string(),
  platform: z.string(),
});
export type DeviceDto = z.infer<typeof deviceDto>;

export const deviceResponse = z.object({ device: deviceDto });

// ---------------------------------------------------------------------------- network
export const NETWORK_STATUSES = ["ok", "shared_egress", "too_large", "blocked", "unavailable"] as const;
export const networkStatus = z.enum(NETWORK_STATUSES);
export type NetworkStatus = z.infer<typeof networkStatus>;

export const observeBody = z.object({}).strict();

export const observeResponse = z.object({
  status: networkStatus,
  /** Why local sharing is off (for status copy); null when ok. */
  reason: z.string().nullable(),
  /** Spaces of the current network; empty unless ok. Used for the net: realtime topic only. */
  spaceIds: z.array(z.uuid()),
  devicesHere: z.number().int().min(0),
});
export type ObserveResponse = z.infer<typeof observeResponse>;

// ---------------------------------------------------------------------------- shares
/** claimed: a burn-after-download share someone has opened, inside its grace window (Phase 3). */
export const SHARE_STATUSES = ["pending_upload", "active", "claimed"] as const;
export const FILE_STATUSES = ["pending", "verified", "rejected", "deleted"] as const;
/**
 * network: everyone on the network sees it. link_only: only through its links (DEC-033). room (Phase 4, P4-17):
 * the members of one private room, from any network; never visible on a network.
 */
export const SHARE_SCOPES = ["network", "link_only", "room"] as const;

export const fileDto = z.object({
  id: z.uuid(),
  name: z.string(),
  sizeBytes: z.number().int().min(0),
  /** Declared or detected type, for display only. */
  type: z.string(),
  status: z.enum(FILE_STATUSES),
  previewable: z.boolean(),
  riskFlags: z.array(z.string()),
  /** Burn after download, for the claimant only: download URLs left for this file (of 3). */
  downloadsLeft: z.number().int().min(0).optional(),
});
export type FileDto = z.infer<typeof fileDto>;

/**
 * Burn after download (Phase 3, DEC-015): present only on burn shares, so every other share keeps
 * the Phase 1–2 shape. The first person to download (or reveal) it claims it; then it is gone for
 * everyone else, and deleted for good when the claimant's window ends.
 */
export const burnStateDto = z.object({
  /** Someone has opened it. */
  claimed: z.boolean(),
  /** This device (or, for a link viewer, this browser) is the one who has it. */
  byYou: z.boolean(),
  /** When it is deleted for good: the claimant's window (shown to the claimant and the creator). */
  availableUntil: z.iso.datetime({ offset: true }).nullable(),
  /** The text is withheld until Reveal (everyone but the creator). */
  textHidden: z.boolean(),
  /** For the claimant of a text: reveals left (of 3). */
  revealsLeft: z.number().int().min(0).nullable(),
});
export type BurnStateDto = z.infer<typeof burnStateDto>;

/**
 * Phase 4 (P4-15), for the creator only. `extendable`: the share itself may be extended (active, not burn, no
 * extension pending); whether the plan allows it is /me/entitlements' `extendExpiry` (the server enforces
 * both). `extensionPending`: the janitor is copying its files to keep them longer (the expiry changes when
 * it is done). `extensionFailed`: the last extension failed; the share kept its expiry.
 */
export const shareExpiryDto = z.object({
  extendable: z.boolean(),
  extensionPending: z.boolean(),
  extensionFailed: z.boolean(),
});
export type ShareExpiryDto = z.infer<typeof shareExpiryDto>;

export const shareDto = z.object({
  id: z.uuid(),
  kind: z.enum(["files", "text"]),
  scope: z.enum(SHARE_SCOPES),
  status: z.enum(SHARE_STATUSES),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  isMine: z.boolean(),
  /** Label of the posting device ("Blue Fox"), if it still exists. */
  fromLabel: z.string().nullable(),
  text: z.object({ content: z.string(), version: z.number().int().min(1) }).nullable(),
  files: z.array(fileDto),
  fileCount: z.number().int().min(0),
  totalBytes: z.number().int().min(0),
  burn: burnStateDto.optional(),
  expiry: shareExpiryDto.optional(),
  /** Phase 4 (P4-17): the room of a room share, for its creator and the room's members. Absent otherwise. */
  room: z.object({ id: z.uuid(), label: z.string() }).optional(),
});
export type ShareDto = z.infer<typeof shareDto>;

export const shareResponse = z.object({ share: shareDto });

/**
 * POST /shares/{id}/extend (P4-15): one of the plan's expiry options, counted from now. Nothing else: the
 * plan, the retention class and the date are the server's.
 */
export const extendShareBody = z.object({ expiresIn: z.number().int().positive() }).strict();
/** 200 with the share (extended in place), or 202: its files are being copied to keep them longer. */
export const extendPendingResponse = z.object({ extension: z.object({ status: z.literal("pending") }) });
export const extendShareResponse = z.union([shareResponse, extendPendingResponse]);
export type ExtendShareResponse = z.infer<typeof extendShareResponse>;

export const shareListResponse = z.object({
  shares: z.array(shareDto),
  nextCursor: z.string().nullable(),
});

export const localFeedResponse = shareListResponse.extend({ networkStatus });
export type LocalFeedResponse = z.infer<typeof localFeedResponse>;

/**
 * This network; Link only (never visible on any network, only through its links, DEC-033); or, Phase 4 (P4-17), one
 * private room the caller is a member of (E23): { room: roomId }.
 */
const destination = z.union([z.enum(["network", "link_only"]), z.object({ room: z.uuid() }).strict()]);
export type Destination = z.infer<typeof destination>;
const expiresIn = z.number().int().positive().optional();
/** Entitlement-gated (features.burnAfterDownload, Q-008). */
const burnAfterDownload = z.boolean().optional();

export const createTextBody = z
  .object({
    destination,
    content: z.string().refine((value) => value.trim().length > 0, "content must not be empty"),
    expiresIn,
    burnAfterDownload,
  })
  .strict();

export const editTextBody = z
  .object({
    content: z.string().refine((value) => value.trim().length > 0, "content must not be empty"),
    version: z.number().int().min(1),
  })
  .strict();

export const createFileShareBody = z
  .object({
    destination,
    expiresIn,
    burnAfterDownload,
    files: z
      .array(
        z
          .object({
            name: z.string().min(1).max(1024),
            size: z.number().int().positive(),
            type: z.string().max(255),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

export const putUploadTarget = z.object({
  fileId: z.uuid(),
  /** Sanitized name and declared size, so the client can match its file (03 §7.2). */
  name: z.string(),
  sizeBytes: z.number().int().positive(),
  url: z.url(),
  method: z.literal("PUT"),
  /** Send exactly these headers: they are part of the signature (DEC-010). */
  headers: z.record(z.string(), z.string()),
  /** When the URL stops working; POST …/upload-url gives a fresh one (C4-13). */
  expiresAt: z.iso.datetime({ offset: true }),
});
export type PutUploadTarget = z.infer<typeof putUploadTarget>;

/**
 * Phase 4 (P4-14): a file above 100 MiB goes up in parts. No URL here: part URLs come from
 * POST …/multipart/parts in batches, each signed for its part's exact size.
 */
export const multipartUploadTarget = z.object({
  fileId: z.uuid(),
  name: z.string(),
  sizeBytes: z.number().int().positive(),
  method: z.literal("MULTIPART"),
  partSize: z.number().int().positive(),
  partCount: z.number().int().min(1).max(10_000),
  /** The upload deadline: every part and the completion must be done by then. */
  expiresAt: z.iso.datetime({ offset: true }),
});
export type MultipartUploadTarget = z.infer<typeof multipartUploadTarget>;

export const uploadTarget = z.discriminatedUnion("method", [putUploadTarget, multipartUploadTarget]);
export type UploadTarget = z.infer<typeof uploadTarget>;

export const createFileShareResponse = z.object({ share: shareDto, uploads: z.array(uploadTarget) });

/** POST …/files/{fileId}/upload-url: a fresh PUT URL just before the file's turn (C4-13). */
export const uploadUrlResponse = z.object({ upload: putUploadTarget });

/** POST …/files/{fileId}/multipart/parts: up to 20 distinct part numbers. */
export const partUrlsBody = z
  .object({
    partNumbers: z
      .array(z.number().int().min(1).max(10_000))
      .min(1)
      .max(20)
      .refine((numbers) => new Set(numbers).size === numbers.length, "part numbers must be distinct"),
  })
  .strict();

export const partUrlsResponse = z.object({
  parts: z.array(
    z.object({
      partNumber: z.number().int().min(1),
      url: z.url(),
      /** Send exactly this many bytes: the size is part of the signature. */
      size: z.number().int().positive(),
      expiresAt: z.iso.datetime({ offset: true }),
    }),
  ),
});
export type PartUrlsResponse = z.infer<typeof partUrlsResponse>;

/** GET …/files/{fileId}/multipart: what storage holds (ListParts is the truth, D4-25). */
export const multipartStatusResponse = z.object({
  partSize: z.number().int().positive(),
  partCount: z.number().int().min(1),
  uploaded: z.array(z.object({ partNumber: z.number().int().min(1), size: z.number().int().min(0) })),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type MultipartStatusResponse = z.infer<typeof multipartStatusResponse>;

export const emptyBody = z.object({}).strict();

/**
 * Download URLs. For a burn share the first one claims it, so the client must say it means it:
 * without confirm the server answers 409 CONFIRMATION_REQUIRED and nothing changes (phase 3 §17.8.8).
 */
export const downloadUrlBody = z.object({ confirm: z.literal(true).optional() }).strict();

/**
 * Reveal a burn text: always a deliberate action (03 §5.4). Without confirm: 409, nothing changes. Through a room link
 * (P4-19) the share is named: the link shows a whole room. A share link takes only its own share's ID, if any.
 */
export const revealBody = z.object({ confirm: z.literal(true).optional(), shareId: z.uuid().optional() }).strict();

/** POST /links/{linkId}/confirm-received: through a room link (P4-19), the share the viewer claimed. */
export const confirmReceivedBody = z.object({ shareId: z.uuid().optional() }).strict();

const burnIssuance = z.object({
  availableUntil: z.iso.datetime({ offset: true }),
  /** Download URLs (or reveals) left for the claimant, of 3. */
  left: z.number().int().min(0),
});

export const downloadUrlResponse = z.object({
  url: z.url(),
  expiresAt: z.iso.datetime({ offset: true }),
  fileName: z.string(),
  sizeBytes: z.number().int().min(0),
  riskFlags: z.array(z.string()),
  /** Present when the download claimed (or retried) a burn share. */
  burn: burnIssuance.optional(),
});

export const revealResponse = z.object({
  text: z.object({ content: z.string() }),
  burn: burnIssuance,
});
export type RevealResponse = z.infer<typeof revealResponse>;

/**
 * What this device may use (07 §2.2, phase 4 §17.6.3); resolved on the server, the UI only hides what
 * it can't use. The Phase 4 fields are optional, so a client can parse an older server's response
 * during a rolling deploy. Byte sizes are binary (1 MB = 1 MiB).
 */
const secondsList = z.array(z.number().int().positive());
export const entitlementsResponse = z.object({
  plan: z.enum(["free", "pro"]),
  source: z.enum(["anonymous", "account", "subscription", "override"]).optional(),
  limits: z
    .object({
      maxFileBytes: z.number().int().positive(),
      maxFilesPerShare: z.number().int().positive(),
      maxTextBytes: z.number().int().positive(),
      activeStorageBytes: z.number().int().positive(),
      dailyUploadBytes: z.number().int().positive(),
      expiryOptionsSeconds: secondsList,
      linkExpiryOptionsSeconds: secondsList,
      shortCodeExpiryOptionsSeconds: secondsList,
      maxSignedInDevices: z.number().int().positive(),
      maxRooms: z.number().int().min(0),
      maxRoomMembers: z.number().int().min(0),
      historyRetentionDays: z.number().int().positive(),
      /** Phase 4 (P4-19): the room-link expiries this plan offers (empty on Free). */
      roomLinkExpiryOptionsSeconds: z.array(z.number().int().positive()).optional(),
    })
    .optional(),
  features: z.object({
    burnAfterDownload: z.boolean(),
    linkPasswords: z.boolean().optional(),
    privateRooms: z.boolean().optional(),
    customRoomNames: z.boolean().optional(),
    roomLinks: z.boolean().optional(),
    multiUseInvites: z.boolean().optional(),
    transferHistory: z.boolean().optional(),
    extendExpiry: z.boolean().optional(),
  }),
  usage: z
    .object({
      storageUsedBytes: z.number().int().min(0),
      storageReservedBytes: z.number().int().min(0),
      storageQuotaBytes: z.number().int().positive(),
    })
    .optional(),
  subscription: z
    .object({
      status: z.string(),
      currentPeriodEnd: z.iso.datetime({ offset: true }).nullable(),
      cancelAtPeriodEnd: z.boolean(),
      graceUntil: z.iso.datetime({ offset: true }).nullable(),
    })
    .nullable()
    .optional(),
});
export type EntitlementsResponse = z.infer<typeof entitlementsResponse>;

/**
 * Phase 4C billing (phase 4 §17.7.6). The checkout body names a plan and an interval, nothing else:
 * the subject is always the caller (strict, B16). Both answers are a provider URL the browser
 * navigates to; neither grants anything.
 */
export const checkoutBody = z.object({ plan: z.literal("pro"), interval: z.enum(["month", "year"]) }).strict();
export const checkoutResponse = z.object({ url: z.url() });
export type CheckoutResponse = z.infer<typeof checkoutResponse>;
export const portalResponse = z.object({ url: z.url() });
export type PortalResponse = z.infer<typeof portalResponse>;

export const previewUrlResponse = z.object({
  url: z.url(),
  expiresAt: z.iso.datetime({ offset: true }),
});

// ---------------------------------------------------------------------------- share links (Phase 2)
const isoDate = z.iso.datetime({ offset: true });
const linkId = z.string().regex(/^[A-Za-z0-9_-]{16}$/);

/**
 * Phase 4 (P4-16): a link password as sent, bounded before it reaches the hash. The service applies the
 * rule (8–128 characters after NFC normalization, 422 PASSWORD_INVALID); validation errors never echo it.
 */
const linkPassword = z.string().min(1).max(512);

/** Creator only. expiresIn omitted: the link lasts as long as the share (never longer). A password needs Pro (E11). */
export const createLinkBody = z
  .object({
    expiresIn,
    shortCode: z.object({ expiresIn }).strict().optional(),
    password: linkPassword.optional(),
  })
  .strict();

/** PATCH /links/{linkId} (P4-16): set or change (Pro, E11) or remove (null, always allowed, D4-12) the password. */
export const updateLinkBody = z.object({ password: linkPassword.nullable() }).strict();

export const regenerateCodeBody = z.object({ expiresIn }).strict();

/**
 * POST /rooms/{roomId}/links (P4-19, §17.8.5): the room's owner, Pro (roomLinks, E22). One of the plan's room-link
 * expiries (D4-17: 1 hour, 24 hours, 7 days, 30 days); a password needs linkPasswords (E11). No short code: a code
 * would open a whole room (DV4-108).
 */
export const createRoomLinkBody = z
  .object({
    expiresIn: z.number().int().positive(),
    password: linkPassword.optional(),
  })
  .strict();

/** The plaintext code is returned once, when it is created (03 §4.4). */
export const shortCodeDto = z.object({ code: z.string(), expiresAt: isoDate });

/** Returned once: the URL carries the secret in its fragment, which is never stored. */
export const createdLinkDto = z.object({
  id: linkId,
  url: z.url(),
  createdAt: isoDate,
  expiresAt: isoDate,
  shortCode: shortCodeDto.nullable(),
});
export type CreatedLinkDto = z.infer<typeof createdLinkDto>;
export const createLinkResponse = z.object({ link: createdLinkDto });
export const regenerateCodeResponse = z.object({ shortCode: shortCodeDto });

/** A link as its creator sees it later: never its secret, URL or code. */
export const linkSummaryDto = z.object({
  id: linkId,
  createdAt: isoDate,
  expiresAt: isoDate,
  state: z.enum(["active", "expired", "revoked"]),
  /** Set while the link has a live short code. */
  shortCodeExpiresAt: isoDate.nullable(),
  unlockCount: z.number().int().min(0),
  /** Phase 4 (P4-15): made "until the share expires", so it moves when the share is extended. */
  followsShareExpiry: z.boolean(),
  /** Phase 4 (P4-16): whether the link has a password. Never the password or its hash. */
  hasPassword: z.boolean(),
});
export type LinkSummaryDto = z.infer<typeof linkSummaryDto>;
export const linkListResponse = z.object({ links: z.array(linkSummaryDto) });
export const updateLinkResponse = z.object({ link: linkSummaryDto });

// ---------------------------------------------------------------------------- link viewers (Phase 2)
/** Phase 4 (P4-16): a password link's password may come with the secret (03 §4.2). */
export const unlockBody = z
  .object({
    secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    password: linkPassword.optional(),
    turnstileToken: z.string().min(1).max(2048).optional(),
  })
  .strict();

/** POST /links/{linkId}/password (P4-16): prove the password for this browser's grant. Turnstile after a lock. */
export const linkPasswordBody = z
  .object({
    password: linkPassword,
    turnstileToken: z.string().min(1).max(2048).optional(),
  })
  .strict();

export const resolveCodeBody = z
  .object({
    code: z.string().min(1).max(64),
    turnstileToken: z.string().min(1).max(2048).optional(),
  })
  .strict();
export const resolveCodeResponse = z.object({ linkId });

/**
 * What a link viewer receives (G4): the target share's content, never network or space IDs,
 * presence, devices, the uploader, or anything about other shares.
 */
export const viewerFileDto = z.object({
  id: z.uuid(),
  name: z.string(),
  sizeBytes: z.number().int().min(0),
  type: z.string(),
  previewable: z.boolean(),
  /** Archives carry a warning (blocked kinds never reach a Free link). */
  riskFlags: z.array(z.string()),
  /** Burn after download, for the claimant only: download URLs left for this file (of 3). */
  downloadsLeft: z.number().int().min(0).optional(),
  /**
   * Phase 4 (P4-19): through a room link, a file the link's plan never hands out (executables, scripts, installers,
   * disk images; E16). Listed, so the room's posts are complete, but its download is refused.
   */
  blocked: z.literal(true).optional(),
});
export type ViewerFileDto = z.infer<typeof viewerFileDto>;

const viewerLink = z.object({ id: linkId, expiresAt: isoDate });
/** When this browser's access ends (the grant: ≤ 12 h, never after the link). */
const viewerAccess = z.object({ expiresAt: isoDate });

/** A share link: its one share. */
export const viewerShareContentResponse = z.object({
  link: viewerLink,
  access: viewerAccess,
  share: z.object({
    kind: z.enum(["files", "text"]),
    expiresAt: isoDate,
    text: z.object({ content: z.string() }).nullable(),
    files: z.array(viewerFileDto),
    burn: burnStateDto.optional(),
  }),
});
export type ViewerShareContent = z.infer<typeof viewerShareContentResponse>;

/** A share as a room link shows it (P4-19): never who posted it, the room's name, members or anything about networks. */
export const viewerRoomShareDto = z.object({
  id: z.uuid(),
  kind: z.enum(["files", "text"]),
  createdAt: isoDate,
  expiresAt: isoDate,
  text: z.object({ content: z.string() }).nullable(),
  files: z.array(viewerFileDto),
  burn: burnStateDto.optional(),
});
export type ViewerRoomShareDto = z.infer<typeof viewerRoomShareDto>;

/** A room link (P4-19, §17.8.5): the room's current active shares, newest first, by cursor. Nothing else of the room. */
export const viewerRoomContentResponse = z.object({
  link: viewerLink,
  access: viewerAccess,
  room: z.object({ shares: z.array(viewerRoomShareDto), nextCursor: z.string().nullable() }),
});
export type ViewerRoomContent = z.infer<typeof viewerRoomContentResponse>;

/** What a link viewer receives: a share link's share, or (P4-19) a room link's shares. */
export const viewerContentResponse = z.union([viewerShareContentResponse, viewerRoomContentResponse]);
export type ViewerContent = z.infer<typeof viewerContentResponse>;

// ---------------------------------------------------------------------------- abuse reports (Phase 2)
export const REPORT_CATEGORIES = [
  "malware", "phishing", "illegal", "child_safety", "copyright", "harassment", "spam", "other",
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const createReportBody = z
  .object({
    /** A link the reporter holds a grant for, or a share their device can see. */
    target: z.discriminatedUnion("type", [
      // P4-19: through a room link, the reported share is named (the link shows a whole room).
      z.object({ type: z.literal("link"), linkId, shareId: z.uuid().optional() }).strict(),
      z.object({ type: z.literal("share"), shareId: z.uuid() }).strict(),
    ]),
    category: z.enum(REPORT_CATEGORIES),
    details: z.string().max(2000).optional(),
    email: z.email().max(254).optional(),
    turnstileToken: z.string().min(1).max(2048).optional(),
  })
  .strict()
  .refine((body) => body.category !== "other" || (body.details?.trim().length ?? 0) >= 10, {
    message: "Describe the problem (at least 10 characters)",
    path: ["details"],
  });
export const createReportResponse = z.object({ report: z.object({ id: z.uuid() }) });

// ---------------------------------------------------------------------------- accounts (Phase 4A, §17.13)
/** This browser's user: anonymous or an account. The email is masked for display (§17.5.5). */
export const meResponse = z.object({
  user: z.object({
    id: z.uuid(),
    anonymous: z.boolean(),
    email: z.string().nullable(),
    displayName: z.string().nullable(),
  }),
  /** Sign-in providers linked to the account ("email", "google"). */
  methods: z.array(z.string()),
  mfa: z.object({ enrolled: z.boolean(), aal: z.enum(["aal1", "aal2"]) }),
  plan: z.enum(["free", "pro"]),
  deletion: z.object({ scheduledFor: isoDate }).nullable(),
});
export type MeResponse = z.infer<typeof meResponse>;

/** P4-22: DELETE /me answers 202 with the date the account is deleted on, unless the deletion is cancelled before it. */
export const deletionResponse = z.object({ scheduledFor: isoDate });

export const updateProfileBody = z.object({ displayName: z.string().max(200).nullable() }).strict();

export const deviceListItem = z.object({
  id: z.uuid(),
  label: z.string(),
  platform: z.string(),
  createdAt: isoDate,
  lastSeenAt: isoDate,
  /** The device this session is bound to. */
  current: z.boolean(),
  revokedAt: isoDate.nullable(),
});
export type DeviceListItem = z.infer<typeof deviceListItem>;
export const deviceListResponse = z.object({ devices: z.array(deviceListItem), maxDevices: z.number().int().positive() });
export type DeviceListResponse = z.infer<typeof deviceListResponse>;

/** The merge proof (§17.5.4): the secret is shown once and kept only in this browser until the merge. */
export const mergeIntentResponse = z.object({ intentId: z.uuid(), secret: z.string(), expiresAt: isoDate });
export type MergeIntentResponse = z.infer<typeof mergeIntentResponse>;
export const mergeAnonymousBody = z
  .object({ intentId: z.uuid(), secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
export const mergeAnonymousResponse = z.object({
  merged: z.object({
    shares: z.number().int().min(0),
    links: z.number().int().min(0),
    devices: z.number().int().min(0),
    memberships: z.number().int().min(0),
    bytes: z.number().int().min(0),
  }),
});
export type MergeAnonymousResponse = z.infer<typeof mergeAnonymousResponse>;

// ---------------------------------------------------------------------------- private rooms (Phase 4D, P4-17, §17.13)
/** A room name as sent; the server cleans it (NFC, no invisible characters) to 1–60 characters. Custom names are Pro (E18). */
const roomName = z.string().max(200);

/** POST /rooms (Pro, E17). Without a name, the room gets a generated one. */
export const createRoomBody = z.object({ name: roomName.optional() }).strict();

/**
 * PATCH /rooms/{roomId} (the owner). name: a custom name (Pro, E18) or null for a generated one; defaultExpirySeconds:
 * one of the owner's expiry options, or null for the poster's plan default.
 */
export const updateRoomBody = z
  .object({
    name: roomName.nullable().optional(),
    membersCanCreateLinks: z.boolean().optional(),
    defaultExpirySeconds: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "nothing to change");

export const ROOM_ROLES = ["owner", "member"] as const;

/** A room as its members see it (G-R4): no network, presence, owner identity or member list. */
export const roomDto = z.object({
  id: z.uuid(),
  label: z.string(),
  role: z.enum(ROOM_ROLES),
  memberCount: z.number().int().min(1),
  settings: z.object({
    membersCanCreateLinks: z.boolean(),
    defaultExpirySeconds: z.number().int().positive().nullable(),
  }),
  createdAt: isoDate,
});
export type RoomDto = z.infer<typeof roomDto>;
export const roomResponse = z.object({ room: roomDto });
export const roomListResponse = z.object({ rooms: z.array(roomDto), nextCursor: z.string().nullable() });

/**
 * A member as other members see them (D4-15): an opaque memberId (C4-18) and a label (the account's display name,
 * or the device name an anonymous member joined from). Never an email, user ID, network or presence.
 */
export const roomMemberDto = z.object({
  memberId: z.uuid(),
  role: z.enum(ROOM_ROLES),
  label: z.string(),
  joinedAt: isoDate,
  isYou: z.boolean(),
});
export type RoomMemberDto = z.infer<typeof roomMemberDto>;
export const roomMembersResponse = z.object({ members: z.array(roomMemberDto) });

const inviteId = z.string().regex(/^[A-Za-z0-9_-]{16}$/);
/** pairing (P4-18): a QR code, one use, 10 minutes. invite_link (P4-17): a copyable link, ≤ 7 days, optional maximum. */
export const INVITE_KINDS = ["pairing", "invite_link"] as const;
export type InviteKind = (typeof INVITE_KINDS)[number];

/**
 * POST /rooms/{roomId}/invites (the owner). An invite link (multiUseInvites, E21) takes its expiry and an optional
 * number of uses; a pairing code (E20) takes neither: it is always one use and 10 minutes.
 */
export const createInviteBody = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("invite_link"),
      expiresIn: z.number().int().positive(),
      maxUses: z.number().int().min(1).max(1000).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("pairing") }).strict(),
]);

/** Returned once: the URL carries the secret in its fragment, which is never stored. */
export const createdInviteDto = z.object({
  inviteId,
  kind: z.enum(INVITE_KINDS),
  url: z.url(),
  expiresAt: isoDate,
  maxUses: z.number().int().positive().nullable(),
});
export const createInviteResponse = z.object({ invite: createdInviteDto });

/** An open invite (link or pairing code) as the owner sees it later: never its secret or URL. */
export const inviteSummaryDto = z.object({
  inviteId,
  kind: z.enum(INVITE_KINDS),
  createdAt: isoDate,
  expiresAt: isoDate,
  useCount: z.number().int().min(0),
  maxUses: z.number().int().positive().nullable(),
});
export type InviteSummaryDto = z.infer<typeof inviteSummaryDto>;
export const inviteListResponse = z.object({ invites: z.array(inviteSummaryDto) });

/**
 * Preview and accept prove the invite's secret, from the URL's fragment. Its format isn't checked here: a malformed
 * secret gets the same 404 INVITE_UNAVAILABLE as a wrong one (§17.8.4.1).
 */
export const inviteSecretBody = z.object({ secret: z.string().max(256) }).strict();

/** Only after the secret is proven (D4-15): the room's name and size, nothing about its members, and the invite's kind. */
export const invitePreviewResponse = z.object({
  roomLabel: z.string(),
  memberCount: z.number().int().min(1),
  kind: z.enum(INVITE_KINDS),
  expiresAt: isoDate,
});
export type InvitePreviewResponse = z.infer<typeof invitePreviewResponse>;

// ---------------------------------------------------------------------------- transfer history (P4-20)
/**
 * Transfer history (phase 4 §17.8.6, E24): the caller's own shares in every state and what happened to them, within
 * the plan's history window. Actor kinds only, never who (D4-20): no user, device, network, IP or another person's
 * link. Query filters (`status`, `kind`, `shareId`) and paging are in the URL.
 */
export const HISTORY_SHARE_STATUSES = ["pending_upload", "active", "claimed", "consumed", "expired", "deleted", "blocked", "failed"] as const;
export const SHARE_END_REASONS = [
  "expired", "consumed", "deleted_by_creator", "deleted_by_owner", "blocked", "upload_failed", "room_deleted", "account_deleted",
] as const;
export type ShareEndReason = (typeof SHARE_END_REASONS)[number];
/** `active`: open and not yet expired; `ended`: everything else. */
export const HISTORY_STATUS_FILTERS = ["active", "ended"] as const;
export type HistoryStatusFilter = (typeof HISTORY_STATUS_FILTERS)[number];

export const historyShareDto = z.object({
  id: z.uuid(),
  kind: z.enum(["files", "text"]),
  /** The share's title, or its first file's name; null for an untitled text (its content is never in history). */
  title: z.string().nullable(),
  scope: z.enum(SHARE_SCOPES),
  room: z.object({ id: z.uuid(), label: z.string() }).optional(),
  /** An open share whose time has passed reads as `expired`, ended at its expiry, before the expiry job has run. */
  status: z.enum(HISTORY_SHARE_STATUSES),
  createdAt: isoDate,
  expiresAt: isoDate.nullable(),
  endedAt: isoDate.nullable(),
  endReason: z.enum(SHARE_END_REASONS).nullable(),
  burnAfterDownload: z.boolean(),
  fileCount: z.number().int().min(0),
  totalBytes: z.number().int().min(0),
});
export type HistoryShareDto = z.infer<typeof historyShareDto>;
export const historySharesResponse = z.object({ items: z.array(historyShareDto), nextCursor: z.string().nullable() });
export type HistorySharesResponse = z.infer<typeof historySharesResponse>;

export const DOWNLOAD_EVENTS = ["url_issued", "preview_issued", "burn_claimed", "burn_retry", "text_revealed"] as const;
export type DownloadEvent = (typeof DOWNLOAD_EVENTS)[number];
export const DOWNLOAD_ACTOR_KINDS = ["network_device", "creator", "link_viewer", "room_member"] as const;
export type DownloadActorKind = (typeof DOWNLOAD_ACTOR_KINDS)[number];

export const historyDownloadDto = z.object({
  id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  at: isoDate,
  share: z.object({ id: z.uuid(), title: z.string().nullable() }),
  file: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  event: z.enum(DOWNLOAD_EVENTS),
  actorKind: z.enum(DOWNLOAD_ACTOR_KINDS),
  /** A link viewer's link: its kind, and its ID only when the caller made the link. Never a secret. */
  link: z.object({ kind: z.enum(["share", "room"]), id: linkId.nullable() }).nullable(),
  /** The browser family ("Chrome"), as logged; nothing finer. */
  browser: z.string().nullable(),
});
export type HistoryDownloadDto = z.infer<typeof historyDownloadDto>;
export const historyDownloadsResponse = z.object({ items: z.array(historyDownloadDto), nextCursor: z.string().nullable() });
export type HistoryDownloadsResponse = z.infer<typeof historyDownloadsResponse>;

// ---------------------------------------------------------------------------- errors
export const errorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});
