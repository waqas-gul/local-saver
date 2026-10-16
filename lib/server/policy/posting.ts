import "server-only";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import type { Env } from "../env";
import { assertRemoteLinksEnabled, getRuntimeFlags } from "../flags";
import { ApiError } from "../http/errors";
import type { NetworkView } from "../network/current";
import { requesterKey } from "../network/requester";

/**
 * Who may post (DEC-033, 03 §3.7, §10): kill switches, per-user restrictions, and, for the
 * network destination, local mode being on for the caller's current network (fail closed, G5).
 * Link-only posts need no local network (they are never visible on one), but they need remote
 * links to be on, since a link is the only way to reach them.
 */

export type PostingTarget = {
  /** The space a network share goes into; null for a link-only share. */
  spaceId: string | null;
  /**
   * Key for the per-network daily volume and text rate limits. Network shares count against
   * their space; link-only shares against the same space when the network was observed, and
   * otherwise against the requester's network key, so switching destination doesn't add budget.
   */
  networkLimitKey: string;
};

async function assertMayPost(caller: Caller, env: Env, options: { files: boolean }): Promise<void> {
  const flags = await getRuntimeFlags(env);
  if ((options.files && !flags.uploadsEnabled) || (caller.principal.isAnonymous && !flags.anonymousUploadsEnabled)) {
    throw new ApiError(503, "UPLOADS_DISABLED", "Posting is temporarily disabled");
  }
  await assertNotRestricted(caller);
}

/** Upload-restricted users may neither post nor send their content off the network by link. */
export async function assertNotRestricted(caller: Caller): Promise<void> {
  const restriction = await getDb()
    .selectFrom("app.user_flags")
    .select("upload_restricted")
    .where("user_id", "=", caller.principal.userId)
    .executeTakeFirst();
  if (restriction?.upload_restricted) throw new ApiError(403, "UPLOADS_RESTRICTED", "Posting is not allowed for this account");
}

/** Returns the space the new share goes into. */
export async function assertCanPost(
  caller: Caller,
  network: NetworkView,
  env: Env,
  options: { files: boolean },
): Promise<string> {
  await assertMayPost(caller, env, options);
  if (network.status !== "ok" || !network.spaceId) {
    throw new ApiError(409, "LOCAL_SHARING_UNAVAILABLE", "Local sharing is off on this network", {
      status: network.status,
      reason: network.spaceId ? network.reason : (network.reason ?? "network_not_observed"),
    });
  }
  return network.spaceId;
}

/** Where a new share goes and which network budget it uses, for either destination. */
export async function postingTarget(
  caller: Caller,
  network: NetworkView,
  request: Request,
  env: Env,
  options: { files: boolean; destination: "network" | "link_only" },
): Promise<PostingTarget> {
  if (options.destination === "network") {
    const spaceId = await assertCanPost(caller, network, env, options);
    return { spaceId, networkLimitKey: spaceId };
  }
  await assertMayPost(caller, env, options);
  await assertRemoteLinksEnabled(env);
  return { spaceId: null, networkLimitKey: network.spaceId ?? `key:${requesterKey(request, env)}` };
}
