import "server-only";
import type { Kysely, Transaction } from "kysely";
import { FREE_LIMITS } from "@/lib/shared/plans";
import type { FileDto, ShareDto } from "@/lib/shared/api/schemas";
import type { DB } from "../db/types.gen";

/**
 * DTO mapping for shares (02 §8 "output shaping"): never serialize rows. Viewers on the
 * network and creators get the same shape; isMine tells the UI which actions to offer.
 * Nothing about the network (keys, space IDs) appears in a share DTO.
 */

type Db = Kysely<DB> | Transaction<DB>;

export async function loadShareDtos(db: Db, shareIds: string[], viewerUserId: string): Promise<Map<string, ShareDto>> {
  const result = new Map<string, ShareDto>();
  if (shareIds.length === 0) return result;

  const [shares, files, texts] = await Promise.all([
    db
      .selectFrom("app.shares as s")
      .leftJoin("app.devices as d", "d.id", "s.created_by_device_id")
      .select([
        "s.id", "s.kind", "s.scope", "s.status", "s.created_at", "s.expires_at", "s.created_by_user_id",
        "s.file_count", "s.total_bytes", "d.label as from_label",
      ])
      .where("s.id", "in", shareIds)
      .execute(),
    db
      .selectFrom("app.files")
      .select([
        "id", "share_id", "original_name", "declared_size_bytes", "size_bytes", "declared_mime", "detected_mime",
        "upload_status", "preview_kind", "risk_flags",
      ])
      .where("share_id", "in", shareIds)
      .where("upload_status", "in", ["pending", "verified"])
      .orderBy("position")
      .orderBy("id")
      .execute(),
    db.selectFrom("app.text_items").select(["share_id", "content", "version"]).where("share_id", "in", shareIds).execute(),
  ]);

  for (const share of shares) {
    const shareFiles: FileDto[] = files
      .filter((f) => f.share_id === share.id)
      .map((f) => {
        const size = Number(f.size_bytes ?? f.declared_size_bytes);
        return {
          id: f.id,
          name: f.original_name,
          sizeBytes: size,
          type: f.detected_mime ?? f.declared_mime,
          status: f.upload_status as FileDto["status"],
          previewable: f.upload_status === "verified" && f.preview_kind === "image" && size <= FREE_LIMITS.maxPreviewBytes,
          riskFlags: f.risk_flags,
        };
      });
    const text = texts.find((t) => t.share_id === share.id);
    result.set(share.id, {
      id: share.id,
      kind: share.kind as ShareDto["kind"],
      scope: share.scope as ShareDto["scope"],
      status: share.status as ShareDto["status"],
      createdAt: share.created_at.toISOString(),
      expiresAt: (share.expires_at as Date).toISOString(),
      isMine: share.created_by_user_id === viewerUserId,
      fromLabel: share.from_label ?? null,
      text: text && text.content !== null ? { content: text.content, version: text.version } : null,
      files: shareFiles,
      fileCount: share.file_count,
      totalBytes: Number(share.total_bytes),
    });
  }
  return result;
}

export async function loadShareDto(db: Db, shareId: string, viewerUserId: string): Promise<ShareDto> {
  const dto = (await loadShareDtos(db, [shareId], viewerUserId)).get(shareId);
  if (!dto) throw new Error("share disappeared while loading");
  return dto;
}
