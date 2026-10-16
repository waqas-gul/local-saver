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
    | "burn.confirmed";
  /** A device of an (anonymous) user, a link viewer (no user), or the system. */
  actorKind?: "device" | "link_viewer" | "system";
  actorUserId?: string | null;
  actorDeviceId?: string | null;
  networkSpaceId: string | null;
  targetType: "share" | "link" | "report" | "network";
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
