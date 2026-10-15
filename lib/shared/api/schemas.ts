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
export const SHARE_STATUSES = ["pending_upload", "active"] as const;
export const FILE_STATUSES = ["pending", "verified", "rejected", "deleted"] as const;

export const fileDto = z.object({
  id: z.uuid(),
  name: z.string(),
  sizeBytes: z.number().int().min(0),
  /** Declared or detected type, for display only. */
  type: z.string(),
  status: z.enum(FILE_STATUSES),
  previewable: z.boolean(),
  riskFlags: z.array(z.string()),
});
export type FileDto = z.infer<typeof fileDto>;

export const shareDto = z.object({
  id: z.uuid(),
  kind: z.enum(["files", "text"]),
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
});
export type ShareDto = z.infer<typeof shareDto>;

export const shareResponse = z.object({ share: shareDto });

export const shareListResponse = z.object({
  shares: z.array(shareDto),
  nextCursor: z.string().nullable(),
});

export const localFeedResponse = shareListResponse.extend({ networkStatus });
export type LocalFeedResponse = z.infer<typeof localFeedResponse>;

const destination = z.literal("network");
const expiresIn = z.number().int().positive().optional();

export const createTextBody = z
  .object({
    destination,
    content: z.string().refine((value) => value.trim().length > 0, "content must not be empty"),
    expiresIn,
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

export const downloadUrlResponse = z.object({
  url: z.url(),
  expiresAt: z.iso.datetime({ offset: true }),
  fileName: z.string(),
  sizeBytes: z.number().int().min(0),
  riskFlags: z.array(z.string()),
});

export const previewUrlResponse = z.object({
  url: z.url(),
  expiresAt: z.iso.datetime({ offset: true }),
});

// ---------------------------------------------------------------------------- errors
export const errorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});
