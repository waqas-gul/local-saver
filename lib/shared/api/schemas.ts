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
/** network: everyone on the network sees it. link_only: only through its links (DEC-033). */
export const SHARE_SCOPES = ["network", "link_only"] as const;

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
});
export type ShareDto = z.infer<typeof shareDto>;

export const shareResponse = z.object({ share: shareDto });

export const shareListResponse = z.object({
  shares: z.array(shareDto),
  nextCursor: z.string().nullable(),
});

export const localFeedResponse = shareListResponse.extend({ networkStatus });
export type LocalFeedResponse = z.infer<typeof localFeedResponse>;

/** This network, or Link only: never visible on any network, only through its links (DEC-033). */
const destination = z.enum(SHARE_SCOPES);
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

export const uploadTarget = z.object({
  fileId: z.uuid(),
  /** Sanitized name and declared size, so the client can match its file (03 §7.2). */
  name: z.string(),
  sizeBytes: z.number().int().positive(),
  url: z.url(),
  method: z.literal("PUT"),
  /** Send exactly these headers: they are part of the signature (DEC-010). */
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type UploadTarget = z.infer<typeof uploadTarget>;

export const createFileShareResponse = z.object({ share: shareDto, uploads: z.array(uploadTarget) });

export const emptyBody = z.object({}).strict();

/**
 * Download URLs. For a burn share the first one claims it, so the client must say it means it:
 * without confirm the server answers 409 CONFIRMATION_REQUIRED and nothing changes (phase 3 §17.8.8).
 */
export const downloadUrlBody = z.object({ confirm: z.literal(true).optional() }).strict();

/** Reveal a burn text: always a deliberate action (03 §5.4). Without confirm: 409, nothing changes. */
export const revealBody = z.object({ confirm: z.literal(true).optional() }).strict();

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

/** What this device may use (07 §2.2); resolved on the server, the UI only hides what it can't use. */
export const entitlementsResponse = z.object({
  plan: z.literal("free"),
  features: z.object({ burnAfterDownload: z.boolean() }),
});
export type EntitlementsResponse = z.infer<typeof entitlementsResponse>;

export const previewUrlResponse = z.object({
  url: z.url(),
  expiresAt: z.iso.datetime({ offset: true }),
});

// ---------------------------------------------------------------------------- share links (Phase 2)
const isoDate = z.iso.datetime({ offset: true });
const linkId = z.string().regex(/^[A-Za-z0-9_-]{16}$/);

/** Creator only. expiresIn omitted: the link lasts as long as the share (never longer). */
export const createLinkBody = z
  .object({
    expiresIn,
    shortCode: z.object({ expiresIn }).strict().optional(),
  })
  .strict();

export const regenerateCodeBody = z.object({ expiresIn }).strict();

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
});
export type LinkSummaryDto = z.infer<typeof linkSummaryDto>;
export const linkListResponse = z.object({ links: z.array(linkSummaryDto) });

// ---------------------------------------------------------------------------- link viewers (Phase 2)
export const unlockBody = z.object({ secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

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
});
export type ViewerFileDto = z.infer<typeof viewerFileDto>;

export const viewerContentResponse = z.object({
  link: z.object({ id: linkId, expiresAt: isoDate }),
  /** When this browser's access ends (the grant: ≤ 12 h, never after the link). */
  access: z.object({ expiresAt: isoDate }),
  share: z.object({
    kind: z.enum(["files", "text"]),
    expiresAt: isoDate,
    text: z.object({ content: z.string() }).nullable(),
    files: z.array(viewerFileDto),
    burn: burnStateDto.optional(),
  }),
});
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
      z.object({ type: z.literal("link"), linkId }).strict(),
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

// ---------------------------------------------------------------------------- errors
export const errorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});
