import "server-only";
import { getDb } from "./db/client";
import type { Env } from "./env";

/**
 * Kill switches (03 §10), read from app.runtime_flags and cached for at most
 * RUNTIME_FLAGS_CACHE_SECONDS (default 30 s). A missing row means "on".
 */

export type RuntimeFlags = {
  localSharingEnabled: boolean;
  uploadsEnabled: boolean;
  anonymousUploadsEnabled: boolean;
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
    .where("key", "in", ["local_sharing_enabled", "uploads_enabled", "anonymous_uploads_enabled", "egress_ranges"])
    .execute();
  const enabled = (key: string) => rows.find((r) => r.key === key)?.enabled ?? true;
  const flags = {
    localSharingEnabled: enabled("local_sharing_enabled"),
    uploadsEnabled: enabled("uploads_enabled"),
    anonymousUploadsEnabled: enabled("anonymous_uploads_enabled"),
    egressRanges: rows.find((r) => r.key === "egress_ranges")?.value ?? null,
  };
  cached = { flags, at: Date.now() };
  return flags;
}
