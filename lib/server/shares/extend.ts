import "server-only";
import { sql } from "kysely";
import type { z } from "zod";
import type { extendShareBody, ShareDto } from "@/lib/shared/api/schemas";
import { audit } from "../audit/log";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import { assertFeature, assertOption } from "../entitlements/enforce";
import { resolveEntitlements } from "../entitlements/resolve";
import type { Env } from "../env";
import { ApiError, notFound } from "../http/errors";
import type { NetworkView } from "../network/current";
import { assertMayWrite } from "../policy/posting";
import { enforceRateLimit } from "../ratelimit/limits";
import { loadShareDto } from "./dto";
import { requireOwnShare } from "./read";

/**
 * Extending a share's expiry (phase 4 §17.8.2, P4-15, E6, D4-13). The creator, on a plan with extendExpiry
 * (a new action follows the current plan), picks one of the plan's expiry options, counted from now, later
 * than the share's expiry: never beyond now + 90 days. Burn shares and shares that aren't active can't be
 * extended. The client sends only the option; the plan, the class and the date are the server's.
 *
 * app.request_share_extension decides under the share's lock: in place (200 with the share) when every
 * object outlives the new expiry by a day, counted from its upload date; otherwise by copy (202): the storage
 * janitor copies the objects to keys of a longer-lived class and the database swaps them when the last copy
 * is made (D-1: the web tier never copies or deletes objects). Downloads use the old keys until then.
 */

export type ExtendResult = { status: 200; share: ShareDto } | { status: 202 };

type Requested = {
  outcome: "extended" | "pending" | "not_found" | "not_allowed" | "pending_exists" | "not_later";
  previous_expires_at: Date | null;
  new_expires_at: Date | null;
  new_retention_class: string | null;
};

export async function extendShare(
  caller: Caller,
  network: NetworkView,
  shareId: string,
  body: z.infer<typeof extendShareBody>,
  env: Env,
): Promise<ExtendResult> {
  // Keeping a room share longer keeps it in front of the room: its creator must still be in it (P4-17).
  const share = await requireOwnShare(caller, network, shareId, { roomWrite: true });
  const entitlements = await resolveEntitlements(caller.principal);
  assertFeature(entitlements, "extendExpiry", "Extending a share is not in your plan");
  await assertMayWrite(caller, env, { files: false });
  if (share.burnAfterDownload) {
    throw new ApiError(422, "EXTEND_NOT_ALLOWED", "A burn-after-download share can't be extended", { reason: "burn" });
  }
  if (share.status !== "active") {
    throw new ApiError(422, "EXTEND_NOT_ALLOWED", "Only an active share can be extended", { reason: "not_active" });
  }
  const seconds = assertOption(entitlements, "localExpiryOptionsSeconds", body.expiresIn);
  await enforceRateLimit("extendShare", caller.principal.userId);

  return getDb()
    .transaction()
    .execute(async (trx) => {
      const { rows } = await sql<Requested>`
        select * from app.request_share_extension(${share.id}::uuid, ${caller.principal.userId}::uuid, ${seconds}::integer)
      `.execute(trx);
      const result = rows[0];
      const metadata = {
        from: result?.previous_expires_at?.toISOString() ?? null,
        to: result?.new_expires_at?.toISOString() ?? null,
      };
      const event = {
        actorUserId: caller.principal.userId,
        actorDeviceId: caller.device.id,
        networkSpaceId: share.networkSpaceId,
        targetType: "share",
        targetId: share.id,
      } as const;
      switch (result?.outcome) {
        case "extended":
          await audit(trx, { ...event, action: "share.extended", metadata: { ...metadata, mode: "in_place" } });
          return { status: 200, share: await loadShareDto(trx, share.id, caller.principal.userId, caller.device.id) };
        case "pending":
          // share.extended follows from the swap (app.finish_share_extension, actor system).
          await audit(trx, { ...event, action: "share.extension_requested", metadata: { ...metadata, retentionClass: result.new_retention_class } });
          return { status: 202 };
        case "pending_exists":
          throw new ApiError(409, "EXTENSION_PENDING", "This share is already being extended");
        case "not_later":
          throw new ApiError(422, "EXPIRY_NOT_ALLOWED", "Pick an expiry later than the share's", {
            reason: "not_later",
            allowed: entitlements.limits.localExpiryOptionsSeconds,
          });
        case "not_allowed":
          throw new ApiError(422, "EXTEND_NOT_ALLOWED", "Only an active share can be extended", { reason: "not_active" });
        default:
          // Gone since requireOwnShare read it (ended or past its expiry), as for every creator action.
          throw notFound();
      }
    });
}
