import "server-only";
import type { EntitlementsResponse } from "@/lib/shared/api/schemas";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import type { Env } from "../env";
import { burnAvailable } from "../shares/burn";
import { resolveEntitlements } from "./resolve";

/**
 * GET /api/v1/me/entitlements (§17.6.3): what this caller may use right now, so the UI offers only
 * what the server will accept. The same resolution the write paths enforce; the UI never treats it
 * as authority. Features are the plan's, with the burn kill switch and beta flag applied as at
 * creation; features whose screens come with Phase 4D are reported but not offered yet.
 */
export async function describeEntitlements(caller: Caller, env: Env): Promise<EntitlementsResponse> {
  const entitlements = await resolveEntitlements(caller.principal);
  const { limits, features } = entitlements;
  const usage = await getDb()
    .selectFrom("app.storage_usage")
    .select(["bytes_committed", "bytes_reserved"])
    .where("subject_type", "=", "user")
    .where("subject_id", "=", caller.principal.userId)
    .executeTakeFirst();
  return {
    plan: entitlements.plan,
    source: entitlements.source,
    limits: {
      maxFileBytes: limits.maxFileBytes,
      maxFilesPerShare: limits.maxFilesPerShare,
      maxTextBytes: limits.maxTextBytes,
      activeStorageBytes: limits.activeStorageBytes,
      dailyUploadBytes: limits.dailyUploadBytes,
      expiryOptionsSeconds: [...limits.localExpiryOptionsSeconds],
      linkExpiryOptionsSeconds: [...limits.linkExpiryOptionsSeconds],
      shortCodeExpiryOptionsSeconds: [...limits.shortCodeExpiryOptionsSeconds],
      maxSignedInDevices: limits.maxSignedInDevices,
      maxRooms: limits.maxRooms,
      maxRoomMembers: limits.maxRoomMembers,
      historyRetentionDays: limits.historyRetentionDays,
      roomLinkExpiryOptionsSeconds: [...limits.roomLinkExpiryOptionsSeconds],
    },
    features: {
      burnAfterDownload: await burnAvailable(entitlements, env),
      linkPasswords: features.linkPasswords,
      privateRooms: features.privateRooms,
      customRoomNames: features.customRoomNames,
      roomLinks: features.roomLinks,
      multiUseInvites: features.multiUseInvites,
      transferHistory: features.transferHistory,
      extendExpiry: features.extendExpiry,
    },
    usage: {
      storageUsedBytes: Number(usage?.bytes_committed ?? 0),
      storageReservedBytes: Number(usage?.bytes_reserved ?? 0),
      storageQuotaBytes: limits.activeStorageBytes,
    },
    subscription: entitlements.subscription,
  };
}
