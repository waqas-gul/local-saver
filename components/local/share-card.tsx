"use client";

import { CalendarPlus, Copy, Download, Eye, FileText, Flag, Link2, Pencil, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { FileDto, ShareDto } from "@/lib/shared/api/schemas";
import { BurnConfirmDialog } from "../burn/burn-confirm-dialog";
import { BURN, burnErrorText, formatClock } from "../burn/copy";
import { ROOM_COPY } from "../room/copy";
import { EXTEND_COPY, RISK_LABELS, RISK_WARNING } from "./copy";
import { expiresIn, formatBytes, timeAgo } from "./format";
import { LinkedText } from "./linked-text";

/**
 * One share. Everyone who can see it may copy text, download files and report it; only its
 * creator may edit, delete or share it by link (DEC-033). Risky files need a confirmation
 * (03 §7.4). Presentational: data and actions come from the container.
 *
 * Burn after download (Phase 3, phase 3 §17.9): the first download or Reveal claims the share, so
 * it always needs a confirmation first. The claimant then sees how long it stays theirs, what is
 * left and "I've got it"; the creator sees that it was opened. A revealed text lives only in this
 * component's state: never in the query cache, and never fetched again on remount.
 *
 * Extend (Phase 4, P4-15): the creator may keep the share longer when it can be extended and the plan has it
 * (the container passes onExtend only then); while its files are copied, and after a failed extension, the
 * card says so.
 *
 * Rooms (Phase 4, P4-17): a room share shows its room outside the room's page (My uploads); in a room, its owner may
 * delete anyone's share (canDelete), and the container offers a link only when the room allows it. The server
 * decides each of these again.
 */

export type ShareActions = {
  /** confirm: the user confirmed a burn claim (sent as { confirm: true }). */
  download: (file: FileDto, options?: { confirm?: boolean }) => Promise<void>;
  remove: () => Promise<void>;
  /** Resolves "conflict" when the text changed on another device (409). */
  saveText: (content: string, version: number) => Promise<"ok" | "conflict">;
  reload: () => void;
  /** Burn texts (Phase 3): reveal, which claims it. */
  reveal?: () => Promise<{ content: string; left: number; availableUntil: string }>;
  /** Burn shares (Phase 3): the claimant's "I've got it". */
  confirmReceived?: () => Promise<void>;
};

function FileRow({
  file,
  onDownload,
  preview,
  note,
}: {
  file: FileDto;
  onDownload: (file: FileDto) => void;
  preview?: ReactNode;
  note?: string;
}) {
  return (
    <li className="flex items-center gap-3 rounded-lg border p-2">
      {preview ?? <FileText className="size-8 shrink-0 text-muted-foreground" aria-hidden />}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{file.name}</p>
        <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {formatBytes(file.sizeBytes)}
          {file.riskFlags.map((flag) => (
            <Badge key={flag} variant="destructive">
              {RISK_LABELS[flag] ?? flag}
            </Badge>
          ))}
          {note && <span data-testid="downloads-left">{note}</span>}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={file.status !== "verified" || file.downloadsLeft === 0}
        onClick={() => onDownload(file)}
        aria-label={`Download ${file.name}`}
      >
        <Download aria-hidden />
        {file.status === "verified" ? "Download" : "Uploading…"}
      </Button>
    </li>
  );
}

export function ShareCard({
  share,
  actions,
  renderPreview,
  onShareByLink,
  onReport,
  onExtend,
  canDelete = share.isMine,
  showRoom = true,
}: {
  share: ShareDto;
  actions: ShareActions;
  renderPreview?: (file: FileDto) => ReactNode;
  /** Creator only (Phase 2): make a link, QR code or code. */
  onShareByLink?: () => void;
  /** Everyone else (Phase 2): report the share. */
  onReport?: () => void;
  /** Creator only (Phase 4, P4-15): keep the share longer. Omitted when the plan doesn't have it. */
  onExtend?: () => void;
  /** Phase 4 (P4-17): the creator, or the owner of the share's room. */
  canDelete?: boolean;
  /** Phase 4 (P4-17): name the share's room (not on the room's own page). */
  showRoom?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(share.text?.content ?? "");
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [risky, setRisky] = useState<FileDto | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Burn after download: what waits for the confirmation, and a revealed text (component state only).
  const [claiming, setClaiming] = useState<{ kind: "file"; file: FileDto } | { kind: "text" } | null>(null);
  const [revealed, setRevealed] = useState<{ content: string; left: number } | null>(null);

  const burn = share.burn;
  // The claimant's own retries need no second confirmation; the creator never claims (D-7).
  const claims = !!burn && !share.isMine && !burn.byYou;
  const text = share.text?.content ?? revealed?.content ?? null;

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(burnErrorText(e) ?? "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const startDownload = (file: FileDto) => {
    if (claims) setClaiming({ kind: "file", file });
    // The claimant's retries still say they mean it; everything else is a Phase 1 download.
    else if (burn && !share.isMine) void run(() => actions.download(file, { confirm: true }));
    else void run(() => actions.download(file));
  };

  const requestDownload = (file: FileDto) => {
    if (file.riskFlags.length > 0) setRisky(file);
    else startDownload(file);
  };

  const reveal = () =>
    run(async () => {
      if (!actions.reveal) return;
      const result = await actions.reveal();
      setRevealed({ content: result.content, left: result.left });
    });

  const save = () =>
    run(async () => {
      if (!share.text) return;
      const result = await actions.saveText(draft, share.text.version);
      if (result === "conflict") setConflict(true);
      else setEditing(false);
    });

  return (
    <Card size="sm" data-testid="share-card" data-share-id={share.id}>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{share.isMine ? "You" : (share.fromLabel ?? "Someone")}</span>
          {" · "}
          {timeAgo(share.createdAt)}
        </p>
        <span className="flex gap-1">
          {burn && (
            <Badge variant="destructive" data-testid="burn-badge">
              {BURN.badge}
            </Badge>
          )}
          {share.scope === "link_only" && <Badge variant="outline">Link only</Badge>}
          {share.room && showRoom && (
            <Badge variant="outline" className="max-w-40 truncate" data-testid="room-badge">
              {ROOM_COPY.roomBadge(share.room.label)}
            </Badge>
          )}
          {share.isMine && share.expiry?.extensionPending && (
            <Badge variant="outline" data-testid="extension-pending">
              {EXTEND_COPY.pendingBadge}
            </Badge>
          )}
          <Badge variant="secondary">{expiresIn(share.expiresAt)}</Badge>
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        {share.text &&
          editing ? (
            <div className="space-y-2">
              <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} aria-label="Edit text" />
              {conflict && (
                <p className="text-sm text-destructive">
                  This text was changed on another device.{" "}
                  <Button variant="link" size="sm" onClick={actions.reload}>
                    Load the latest version
                  </Button>
                </p>
              )}
              <div className="flex gap-2">
                <Button size="sm" onClick={save} disabled={busy || draft.trim() === ""}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            text !== null && (
              <div data-testid="share-text">
                <LinkedText text={text} />
              </div>
            )
          )}

        {burn?.textHidden && text === null && (
          <Button size="sm" disabled={busy} onClick={() => (claims ? setClaiming({ kind: "text" }) : void reveal())} data-testid="burn-reveal">
            <Eye aria-hidden />
            {BURN.reveal}
          </Button>
        )}
        {revealed && (
          <p className="text-xs text-muted-foreground" data-testid="reveals-left">
            {BURN.revealsLeft(revealed.left)}
          </p>
        )}

        {share.files.length > 0 && (
          <ul className="space-y-2">
            {share.files.map((file) => (
              <FileRow
                key={file.id}
                file={file}
                onDownload={requestDownload}
                preview={file.previewable ? renderPreview?.(file) : undefined}
                note={file.downloadsLeft !== undefined ? BURN.downloadsLeft(file.downloadsLeft) : undefined}
              />
            ))}
          </ul>
        )}

        {burn?.claimed && burn.byYou && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted p-2" data-testid="burn-claimant">
            <p className="text-xs">{burn.availableUntil && BURN.availableUntil(formatClock(burn.availableUntil))}</p>
            {actions.confirmReceived && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(actions.confirmReceived!)} data-testid="burn-got-it">
                {BURN.gotIt}
              </Button>
            )}
          </div>
        )}
        {share.isMine && share.expiry?.extensionFailed && (
          <p className="text-xs text-destructive" data-testid="extension-failed">
            {EXTEND_COPY.failed}
          </p>
        )}
        {burn?.claimed && share.isMine && burn.availableUntil && (
          <p className="text-xs text-muted-foreground" data-testid="burn-opened">
            {BURN.openedBySomeone(formatClock(burn.availableUntil))}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {text !== null && !editing && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void navigator.clipboard.writeText(text).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              <Copy aria-hidden />
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
          {share.isMine && share.text && !editing && !burn && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(share.text?.content ?? "");
                setConflict(false);
                setEditing(true);
              }}
            >
              <Pencil aria-hidden />
              Edit
            </Button>
          )}
          {share.isMine && onShareByLink && share.status === "active" && (
            <Button size="sm" variant="ghost" onClick={onShareByLink}>
              <Link2 aria-hidden />
              Share link
            </Button>
          )}
          {share.isMine && onExtend && share.expiry?.extendable && (
            <Button size="sm" variant="ghost" onClick={onExtend}>
              <CalendarPlus aria-hidden />
              {EXTEND_COPY.button}
            </Button>
          )}
          {canDelete && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(actions.remove)}>
              <Trash2 aria-hidden />
              Delete
            </Button>
          )}
          {!share.isMine && onReport && (
            <Button size="sm" variant="ghost" onClick={onReport}>
              <Flag aria-hidden />
              Report
            </Button>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>

      <Dialog open={risky !== null} onOpenChange={(open) => !open && setRisky(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{RISK_WARNING.title}</DialogTitle>
            <DialogDescription>{RISK_WARNING.body}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRisky(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const file = risky;
                setRisky(null);
                if (file) startDownload(file);
              }}
            >
              {RISK_WARNING.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <BurnConfirmDialog
        open={claiming !== null}
        action={claiming?.kind === "text" ? "reveal" : "download"}
        onCancel={() => setClaiming(null)}
        onConfirm={() => {
          const pending = claiming;
          setClaiming(null);
          if (pending?.kind === "file") void run(() => actions.download(pending.file, { confirm: true }));
          else if (pending?.kind === "text") void reveal();
        }}
      />
    </Card>
  );
}
