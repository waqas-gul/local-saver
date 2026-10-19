import "server-only";
import type { Kysely, Transaction } from "kysely";
import type { DB } from "../db/types.gen";

/**
 * Audit events (03 §14): share and link lifecycle, reports and network status changes.
 * Metadata never holds secrets, codes, content, file names or IP data.
 */

export type AuditEvent = {
  action:
    | "share.created"
    | "share.deleted"
    | "link.created"
    | "link.revoked"
    | "link.code_created"
    | "code.resolve_failed"
    | "code.resolve_blocked"
    | "report.created"
    | "burn.confirmed"
    // Phase 4A (accounts). Device revocation and merges are audited by their database functions.
    | "profile.updated"
    | "account.merge_intent_created"
    // Phase 4C (billing). Subscription changes and disputes are audited by their database functions.
    | "billing.checkout_created"
    // Phase 4D (P4-14): the creator cancelled a multipart upload (the share then ends, audited by end_share).
    | "share.upload_cancelled"
    // Phase 4D (P4-15): an extension in place, or one by copy requested (its swap and failure are audited by
    // their database functions, actor system).
    | "share.extended"
    | "share.extension_requested"
    // Phase 4D (P4-16): link passwords. Never the password or its hash; failures only at their thresholds.
    | "link.password_set"
    | "link.password_removed"
    | "link.password_failed"
    // Phase 4D (P4-17): private rooms. room.deleted is audited by app.delete_room. Never a secret, name or user ID
    // other than the actor's.
    | "room.created"
    | "room.updated"
    | "member.joined"
    | "member.removed"
    | "invite.created"
    | "invite.accepted"
    | "invite.revoked";
  /** A device of an (anonymous) user, a link viewer (no user), or the system. */
  actorKind?: "device" | "link_viewer" | "system";
  actorUserId?: string | null;
  actorDeviceId?: string | null;
  networkSpaceId: string | null;
  targetType: "share" | "link" | "report" | "network" | "user" | "room" | "invite";
  /** Omitted when the target can't be named without IP-derived data (a requester's network). */
  targetId?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export async function audit(db: Kysely<DB> | Transaction<DB>, event: AuditEvent): Promise<void> {
  await db
    .insertInto("app.audit_events")
    .values({
      actor_kind: event.actorKind ?? "device",
      actor_user_id: event.actorUserId ?? null,
      actor_device_id: event.actorDeviceId ?? null,
      network_space_id: event.networkSpaceId,
      action: event.action,
      target_type: event.targetType,
      target_id: event.targetId ?? null,
      metadata: JSON.stringify(event.metadata ?? {}),
    })
    .execute();
}
