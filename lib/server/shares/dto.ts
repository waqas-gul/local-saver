import "server-only";
import type { Kysely, Transaction } from "kysely";
import { FREE_LIMITS } from "@/lib/shared/plans";
import type { FileDto, ShareDto } from "@/lib/shared/api/schemas";
import type { DB } from "../db/types.gen";
import { issuancesUsed, left } from "./burn";

/**
 * DTO mapping for shares (02 §8 "output shaping"): never serialize rows. Viewers on the
 * network and creators get the same shape; isMine tells the UI which actions to offer.
 * Nothing about the network (keys, space IDs) appears in a share DTO.
 *
 * Burn-after-download shares (Phase 3) add `burn`, and only they: every other share keeps its
 * Phase 1–2 shape. Their text is withheld from everyone but the creator (only Reveal returns it),
 * they never have previews, and the claimant sees how many downloads are left per file.
 */

type Db = Kysely<DB> | Transaction<DB>;

export async function loadShareDtos(
  db: Db,
  shareIds: string[],
  viewerUserId: string,
  viewerDeviceId?: string,
): Promise<Map<string, ShareDto>> {
  const result = new Map<string, ShareDto>();
  if (shareIds.length === 0) return result;

  const [shares, files, texts] = await Promise.all([
    db
      .selectFrom("app.shares as s")
      .leftJoin("app.devices as d", "d.id", "s.created_by_device_id")
      .select([
        "s.id", "s.kind", "s.scope", "s.status", "s.created_at", "s.expires_at", "s.created_by_user_id",
        "s.file_count", "s.total_bytes", "d.label as from_label",
        "s.burn_after_download", "s.claimed_by_user_id", "s.claimed_device_id", "s.claim_grace_until",
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

  const claimedIds = shares
    .filter((s) => s.burn_after_download && s.claimed_by_user_id === viewerUserId && s.claimed_device_id === viewerDeviceId)
    .map((s) => s.id);
  const used = await issuancesUsed(db, claimedIds);

  for (const share of shares) {
    const isMine = share.created_by_user_id === viewerUserId;
    const burn = share.burn_after_download;
    const byYou = burn && viewerDeviceId !== undefined && share.claimed_by_user_id === viewerUserId && share.claimed_device_id === viewerDeviceId;
    const shareUsed = used.get(share.id);
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
          previewable: !burn && f.upload_status === "verified" && f.preview_kind === "image" && size <= FREE_LIMITS.maxPreviewBytes,
          riskFlags: f.risk_flags,
          ...(byYou ? { downloadsLeft: left(shareUsed?.get(f.id)) } : {}),
        };
      });
    const text = texts.find((t) => t.share_id === share.id);
    const textHidden = burn && share.kind === "text" && !isMine;
    const claimed = share.status === "claimed";
    result.set(share.id, {
      id: share.id,
      kind: share.kind as ShareDto["kind"],
      scope: share.scope as ShareDto["scope"],
      status: share.status as ShareDto["status"],
      createdAt: share.created_at.toISOString(),
      expiresAt: (share.expires_at as Date).toISOString(),
      isMine,
      fromLabel: share.from_label ?? null,
      text: text && text.content !== null && !textHidden ? { content: text.content, version: text.version } : null,
      files: shareFiles,
      fileCount: share.file_count,
      totalBytes: Number(share.total_bytes),
      ...(burn
        ? {
            burn: {
              claimed,
              byYou,
              availableUntil: claimed && (byYou || isMine) && share.claim_grace_until ? share.claim_grace_until.toISOString() : null,
              textHidden,
              revealsLeft: byYou && share.kind === "text" ? left(shareUsed?.get("text")) : null,
            },
          }
        : {}),
    });
  }
  return result;
}

export async function loadShareDto(db: Db, shareId: string, viewerUserId: string, viewerDeviceId?: string): Promise<ShareDto> {
  const dto = (await loadShareDtos(db, [shareId], viewerUserId, viewerDeviceId)).get(shareId);
  if (!dto) throw new Error("share disappeared while loading");
  return dto;
}
