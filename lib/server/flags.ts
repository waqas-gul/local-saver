import "server-only";
import { getDb } from "./db/client";
import type { Env } from "./env";
import { ApiError } from "./http/errors";

/**
 * Kill switches (03 §10), read from app.runtime_flags and cached for at most
 * RUNTIME_FLAGS_CACHE_SECONDS (default 30 s). A missing row means "on".
 */

export type RuntimeFlags = {
  localSharingEnabled: boolean;
  uploadsEnabled: boolean;
  anonymousUploadsEnabled: boolean;
  /** Phase 2: links, link-only posting, unlocking, viewer content and downloads, codes. */
  remoteLinksEnabled: boolean;
  /** Phase 2: creating and resolving short codes. */
  shortCodesEnabled: boolean;
  /** Value of the egress_ranges flag ({ loadedAt, rows }), set by the list loader. */
  egressRanges: unknown;
};

let cached: { flags: RuntimeFlags; at: number } | undefined;

export async function getRuntimeFlags(env: Env): Promise<RuntimeFlags> {
  const ttl = env.RUNTIME_FLAGS_CACHE_SECONDS * 1000;
  if (cached && Date.now() - cached.at < ttl) return cached.flags;

  const rows = await getDb()
    .selectFrom("app.runtime_flags")
    .select(["key", "enabled", "value"])
    .where("key", "in", [
      "local_sharing_enabled",
      "uploads_enabled",
      "anonymous_uploads_enabled",
      "remote_links_enabled",
      "short_codes_enabled",
      "egress_ranges",
    ])
    .execute();
  const enabled = (key: string) => rows.find((r) => r.key === key)?.enabled ?? true;
  const flags = {
    localSharingEnabled: enabled("local_sharing_enabled"),
    uploadsEnabled: enabled("uploads_enabled"),
    anonymousUploadsEnabled: enabled("anonymous_uploads_enabled"),
    remoteLinksEnabled: enabled("remote_links_enabled"),
    shortCodesEnabled: enabled("short_codes_enabled"),
    egressRanges: rows.find((r) => r.key === "egress_ranges")?.value ?? null,
  };
  cached = { flags, at: Date.now() };
  return flags;
}

/** 503 when remote sharing is switched off (03 §10): links, link-only posts, viewers, codes. */
export async function assertRemoteLinksEnabled(env: Env, options: { shortCodes?: boolean } = {}): Promise<void> {
  const flags = await getRuntimeFlags(env);
  if (!flags.remoteLinksEnabled) {
    throw new ApiError(503, "REMOTE_LINKS_DISABLED", "Sharing by link is paused right now");
  }
  if (options.shortCodes && !flags.shortCodesEnabled) {
    throw new ApiError(503, "SHORT_CODES_DISABLED", "Share codes are paused right now");
  }
}
