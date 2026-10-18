import "server-only";
import { sql } from "kysely";
import type { z } from "zod";
import type { createTextBody, editTextBody, ShareDto } from "@/lib/shared/api/schemas";
import { audit } from "../audit/log";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import { assertNotDeletionPending, assertTextSize } from "../entitlements/enforce";
import { resolveEntitlements } from "../entitlements/resolve";
import { readSnapshot } from "../entitlements/snapshot";
import type { Env } from "../env";
import { ApiError, notFound } from "../http/errors";
import type { NetworkView } from "../network/current";
import { assertMayWrite, postingTarget, requestedExpiry } from "../policy/posting";
import { enforceRateLimit } from "../ratelimit/limits";
import { lockRoomForPosting } from "../rooms/access";
import { burnSnapshot } from "./burn";
import { loadShareDto } from "./dto";
import { resolveExpiry } from "./expiry";
import { requireOwnShare } from "./read";

/**
 * Text shares (04 §4.5, DEC-027): posted to this network or link-only (DEC-033); versioned
 * last-writer-wins edits by the creator only (Q-021). A text may be burn-after-download
 * (phase 3 §17.10): then only Reveal shows it, once claimed, and it can't be edited.
 *
 * Phase 4 (§17.6.4): a new text gets the caller's plan's size (E3: 100 KB Free, 1 MB Pro); an edit
 * keeps the size its share was created with, whatever the plan is now (E4, D4-12). Edits obey the
 * kill switches and upload restrictions, as posting does (E29, C4-15).
 *
 * Phase 4 (P4-17): a text may go into a private room the caller is a member of (E23); room texts count against the
 * room's text limit (300 a minute, 03 §10) instead of a network's. Only its creator edits it, and only while still
 * in the room (a removed member can't put new words in front of it).
 */

/**
 * Request bodies of the text routes: the database's hard cap (1 MiB, Pro's limit) as JSON, with room
 * for escaping. The plan's size is checked on the decoded text.
 */
export const TEXT_BODY_MAX_BYTES = 2 * 1024 * 1024 + 64 * 1024;

export async function createText(
  caller: Caller,
  network: NetworkView,
  body: z.infer<typeof createTextBody>,
  env: Env,
  request: Request,
): Promise<ShareDto> {
  const target = await postingTarget(caller, network, request, env, { files: false, destination: body.destination });
  const { spaceId, roomId, networkLimitKey } = target;
  const entitlements = await resolveEntitlements(caller.principal);
  assertNotDeletionPending(entitlements);
  const bytes = assertTextSize(entitlements, body.content);
  const expiry = resolveExpiry(entitlements, requestedExpiry(entitlements, target, body.expiresIn));
  const snapshot = await burnSnapshot(entitlements, env, body.burnAfterDownload);
  const burn = body.burnAfterDownload === true;
  await enforceRateLimit("textWriteUser", caller.principal.userId);
  if (roomId) await enforceRateLimit("textWriteRoom", roomId);
  else await enforceRateLimit("textWriteSpace", networkLimitKey);

  return getDb().transaction().execute(async (trx) => {
    if (roomId) await lockRoomForPosting(trx, roomId, caller.principal.userId);
    const share = await trx
      .insertInto("app.shares")
      .values({
        scope: target.scope,
        network_space_id: spaceId,
        room_id: roomId,
        kind: "text",
        created_by_user_id: caller.principal.userId,
        created_by_device_id: caller.device.id,
        billing_subject_type: "user",
        billing_subject_id: caller.principal.userId,
        status: "active",
        retention_class: expiry.retentionClass,
        expires_at: sql<Date>`now() + make_interval(secs => ${expiry.seconds})`,
        burn_after_download: burn,
        entitlement_snapshot: JSON.stringify(snapshot),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await trx
      .insertInto("app.text_items")
      .values({
        share_id: share.id,
        network_space_id: spaceId,
        content: body.content,
        content_bytes: bytes,
        updated_by_device_id: caller.device.id,
      })
      .execute();
    if (spaceId) {
      await trx.updateTable("app.network_spaces").set({ last_share_at: sql`now()` }).where("id", "=", spaceId).execute();
    }
    await audit(trx, {
      action: "share.created",
      actorUserId: caller.principal.userId,
      actorDeviceId: caller.device.id,
      networkSpaceId: spaceId,
      targetType: "share",
      targetId: share.id,
      metadata: { kind: "text", scope: target.scope, ...(roomId ? { roomId } : {}), ...(burn ? { burn } : {}) },
    });
    return loadShareDto(trx, share.id, caller.principal.userId, caller.device.id);
  });
}

export async function editText(
  caller: Caller,
  network: NetworkView,
  shareId: string,
  body: z.infer<typeof editTextBody>,
  env: Env,
): Promise<ShareDto> {
  const share = await requireOwnShare(caller, network, shareId, { roomWrite: true });
  // A burn text is fixed once posted: someone may already be reading it.
  if (share.kind !== "text" || share.status !== "active" || share.burnAfterDownload) throw notFound();
  await assertMayWrite(caller, env, { files: false });
  const bytes = assertTextSize(readSnapshot(share.entitlementSnapshot), body.content, { snapshot: true });
  await enforceRateLimit("textWriteUser", caller.principal.userId);
  if (share.networkSpaceId) await enforceRateLimit("textWriteSpace", share.networkSpaceId);
  if (share.roomId) await enforceRateLimit("textWriteRoom", share.roomId);

  const db = getDb();
  const updated = await db
    .updateTable("app.text_items")
    .set({
      content: body.content,
      content_bytes: bytes,
      version: sql<number>`version + 1`,
      updated_at: sql`now()`,
      updated_by_device_id: caller.device.id,
    })
    .where("share_id", "=", share.id)
    .where("version", "=", body.version)
    .where("content", "is not", null)
    .returning("version")
    .executeTakeFirst();

  if (!updated) {
    const current = await db.selectFrom("app.text_items").select("version").where("share_id", "=", share.id).executeTakeFirst();
    throw new ApiError(409, "VERSION_CONFLICT", "This text was changed on another device", {
      currentVersion: current?.version ?? null,
    });
  }
  return loadShareDto(db, share.id, caller.principal.userId, caller.device.id);
}
