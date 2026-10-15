"use client";

import { Copy, Download, FileText, Pencil, Trash2 } from "lucide-react";
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
import { RISK_LABELS, RISK_WARNING } from "./copy";
import { expiresIn, formatBytes, timeAgo } from "./format";
import { LinkedText } from "./linked-text";

/**
 * One local share. Everyone who can see it may copy text and download files; only its
 * creator may edit or delete it (DEC-033). Risky files need a confirmation (03 §7.4).
 * Presentational: data and actions come from the container.
 */

export type ShareActions = {
  download: (file: FileDto) => Promise<void>;
  remove: () => Promise<void>;
  /** Resolves "conflict" when the text changed on another device (409). */
  saveText: (content: string, version: number) => Promise<"ok" | "conflict">;
  reload: () => void;
};

function FileRow({ file, onDownload, preview }: { file: FileDto; onDownload: (file: FileDto) => void; preview?: ReactNode }) {
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
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={file.status !== "verified"}
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
}: {
  share: ShareDto;
  actions: ShareActions;
  renderPreview?: (file: FileDto) => ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(share.text?.content ?? "");
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [risky, setRisky] = useState<FileDto | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const requestDownload = (file: FileDto) => {
    if (file.riskFlags.length > 0) setRisky(file);
    else void run(() => actions.download(file));
  };

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
        <Badge variant="secondary">{expiresIn(share.expiresAt)}</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {share.text &&
          (editing ? (
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
            <LinkedText text={share.text.content} />
          ))}

        {share.files.length > 0 && (
          <ul className="space-y-2">
            {share.files.map((file) => (
              <FileRow key={file.id} file={file} onDownload={requestDownload} preview={file.previewable ? renderPreview?.(file) : undefined} />
            ))}
          </ul>
        )}

        <div className="flex flex-wrap gap-2">
          {share.text && !editing && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void navigator.clipboard.writeText(share.text?.content ?? "").then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              <Copy aria-hidden />
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
          {share.isMine && share.text && !editing && (
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
          {share.isMine && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(actions.remove)}>
              <Trash2 aria-hidden />
              Delete
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
                if (file) void run(() => actions.download(file));
              }}
            >
              {RISK_WARNING.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
