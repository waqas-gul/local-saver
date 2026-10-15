import "server-only";
import { sql } from "kysely";
import type { z } from "zod";
import type { createTextBody, editTextBody, ShareDto } from "@/lib/shared/api/schemas";
import { audit } from "../audit/log";
import type { Caller } from "../auth/device";
import { getDb } from "../db/client";
import { resolveEntitlements } from "../entitlements/plans";
import type { Env } from "../env";
import { ApiError, notFound } from "../http/errors";
import type { NetworkView } from "../network/current";
import { assertCanPost } from "../policy/posting";
import { enforceRateLimit } from "../ratelimit/limits";
import { loadShareDto } from "./dto";
import { resolveExpiry } from "./expiry";
import { requireOwnShare } from "./read";

/** Text shares (04 §4.5, DEC-027): versioned last-writer-wins edits by the creator only (Q-021). */

function assertTextSize(content: string, maxBytes: number): number {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxBytes) throw new ApiError(413, "TEXT_TOO_LARGE", "This text is too long", { maxBytes });
  return bytes;
}

export async function createText(
  caller: Caller,
  network: NetworkView,
  body: z.infer<typeof createTextBody>,
  env: Env,
): Promise<ShareDto> {
  const spaceId = await assertCanPost(caller, network, env, { files: false });
  const entitlements = resolveEntitlements(caller.principal);
  const bytes = assertTextSize(body.content, entitlements.limits.maxTextBytes);
  const expiry = resolveExpiry(entitlements, body.expiresIn);
  await enforceRateLimit("textWriteUser", caller.principal.userId);
  await enforceRateLimit("textWriteSpace", spaceId);

  return getDb().transaction().execute(async (trx) => {
    const share = await trx
      .insertInto("app.shares")
      .values({
        scope: "network",
        network_space_id: spaceId,
        kind: "text",
        created_by_user_id: caller.principal.userId,
        created_by_device_id: caller.device.id,
        billing_subject_type: "user",
        billing_subject_id: caller.principal.userId,
        status: "active",
        retention_class: expiry.retentionClass,
        expires_at: sql<Date>`now() + make_interval(secs => ${expiry.seconds})`,
        entitlement_snapshot: JSON.stringify(entitlements),
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
    await trx.updateTable("app.network_spaces").set({ last_share_at: sql`now()` }).where("id", "=", spaceId).execute();
    await audit(trx, {
      action: "share.created",
      actorUserId: caller.principal.userId,
      actorDeviceId: caller.device.id,
      networkSpaceId: spaceId,
      targetType: "share",
      targetId: share.id,
      metadata: { kind: "text", scope: "network" },
    });
    return loadShareDto(trx, share.id, caller.principal.userId);
  });
}

export async function editText(
  caller: Caller,
  network: NetworkView,
  shareId: string,
  body: z.infer<typeof editTextBody>,
): Promise<ShareDto> {
  const share = await requireOwnShare(caller, network, shareId);
  if (share.kind !== "text" || share.status !== "active") throw notFound();
  const entitlements = resolveEntitlements(caller.principal);
  const bytes = assertTextSize(body.content, entitlements.limits.maxTextBytes);
  await enforceRateLimit("textWriteUser", caller.principal.userId);
  if (share.networkSpaceId) await enforceRateLimit("textWriteSpace", share.networkSpaceId);

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
  return loadShareDto(db, share.id, caller.principal.userId);
}
