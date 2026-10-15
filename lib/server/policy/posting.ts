import "server-only";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import type { Env } from "../env";
import { getRuntimeFlags } from "../flags";
import { ApiError } from "../http/errors";
import type { NetworkView } from "../network/current";

/**
 * Who may post to the network (DEC-033, 03 §3.7, §10): kill switches, per-user restrictions,
 * and local mode being on for the caller's current network (fail closed, G5).
 * Returns the space the new share goes into.
 */
export async function assertCanPost(
  caller: Caller,
  network: NetworkView,
  env: Env,
  options: { files: boolean },
): Promise<string> {
  const flags = await getRuntimeFlags(env);
  if ((options.files && !flags.uploadsEnabled) || (caller.principal.isAnonymous && !flags.anonymousUploadsEnabled)) {
    throw new ApiError(503, "UPLOADS_DISABLED", "Posting is temporarily disabled");
  }

  const restriction = await getDb()
    .selectFrom("app.user_flags")
    .select("upload_restricted")
    .where("user_id", "=", caller.principal.userId)
    .executeTakeFirst();
  if (restriction?.upload_restricted) throw new ApiError(403, "UPLOADS_RESTRICTED", "Posting is not allowed for this account");

  if (network.status !== "ok" || !network.spaceId) {
    throw new ApiError(409, "LOCAL_SHARING_UNAVAILABLE", "Local sharing is off on this network", {
      status: network.status,
      reason: network.spaceId ? network.reason : (network.reason ?? "network_not_observed"),
    });
  }
  return network.spaceId;
}
