import "server-only";
import type { Kysely, Transaction } from "kysely";
import type { DB } from "../db/types.gen";

/**
 * Audit events (03 §14): share lifecycle and network status changes. Metadata never holds
 * secrets, content, file names or IP data.
 */

export type AuditEvent = {
  action: "share.created" | "share.deleted";
  actorUserId: string;
  actorDeviceId: string;
  networkSpaceId: string | null;
  targetType: "share";
  targetId: string;
  metadata?: Record<string, string | number | boolean>;
};

export async function audit(db: Kysely<DB> | Transaction<DB>, event: AuditEvent): Promise<void> {
  await db
    .insertInto("app.audit_events")
    .values({
      actor_kind: "device",
      actor_user_id: event.actorUserId,
      actor_device_id: event.actorDeviceId,
      network_space_id: event.networkSpaceId,
      action: event.action,
      target_type: event.targetType,
      target_id: event.targetId,
      metadata: JSON.stringify(event.metadata ?? {}),
    })
    .execute();
}
