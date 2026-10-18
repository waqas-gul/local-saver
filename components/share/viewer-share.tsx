"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, Eye, FileText } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiRequestError } from "@/lib/client/api-error";
import type { ApiClient } from "@/lib/client/api-client";
import { queryKeys } from "@/lib/client/queries/keys";
import { viewerPreviewQuery } from "@/lib/client/queries/links";
import { downloadUrlResponse, revealResponse, type ViewerFileDto, type ViewerShareContent } from "@/lib/shared/api/schemas";
import { BurnConfirmDialog } from "../burn/burn-confirm-dialog";
import { BURN, burnErrorText, formatClock } from "../burn/copy";
import { RISK_LABELS } from "../local/copy";
import { formatBytes } from "../local/format";
import { LinkedText } from "../local/linked-text";
import { ROOM_COPY } from "../room/copy";
import { REMOTE_RISK_WARNING } from "./copy";

/**
 * One share as a link viewer sees it (03 §4.2): its text and files, the burn rules (Phase 3) and the remote file
 * warning. Used by the share page for a share link's one share, and (P4-19) for each share of a room link.
 */

function Preview({ api, linkId, file }: { api: ApiClient; linkId: string; file: ViewerFileDto }) {
  const { data } = useQuery(viewerPreviewQuery(api, linkId, file.id));
  if (!data) return <div className="size-12 shrink-0 animate-pulse rounded-md bg-muted" aria-hidden />;
  // eslint-disable-next-line @next/next/no-img-element -- deliberate: no image optimization of user content
  return <img src={data.url} alt={file.name} className="size-12 shrink-0 rounded-md object-cover" referrerPolicy="no-referrer" />;
}

/** One share as a viewer sees it: its text and files, with the burn rules. A share link's, or one of a room link's. */
export type ViewerShareBody = { kind: "files" | "text"; text: { content: string } | null; files: ViewerFileDto[]; burn?: ViewerContentBurn };
type ViewerContentBurn = NonNullable<ViewerShareContent["share"]["burn"]>;

/**
 * One share's text, files and burn actions (downloads, Reveal, "Got it"), with their confirmations. Through a room
 * link (P4-19) `shareId` names the share in the burn requests (the link shows a whole room); a share link sends none.
 * A file the link may not hand out (`blocked`, a room link's E16) is listed without a download.
 */
export function ViewerShare({ api, linkId, share, shareId }: { api: ApiClient; linkId: string; share: ViewerShareBody; shareId?: string }) {
  const queryClient = useQueryClient();
  const [risky, setRisky] = useState<ViewerFileDto | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<{ kind: "file"; file: ViewerFileDto } | { kind: "text" } | null>(null);
  const [revealed, setRevealed] = useState<{ content: string; left: number } | null>(null);
  const burn = share.burn;
  // The claimant's retries need no second confirmation.
  const claims = !!burn && !burn.byYou;
  const text = share.text?.content ?? revealed?.content ?? null;
  const named = shareId ? { shareId } : {};
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.linkContent(linkId) });
  // Through a room link, a post that ended meanwhile answers 404: say so, and refresh the list.
  const gone = (e: unknown) => shareId !== undefined && e instanceof ApiRequestError && e.status === 404;

  const download = async (file: ViewerFileDto, confirmed = false) => {
    setError(null);
    try {
      const { url } = await api.request("POST", `/api/v1/links/${linkId}/files/${file.id}/download-url`, {
        body: burn && (confirmed || burn.byYou) ? { confirm: true } : {},
        schema: downloadUrlResponse,
      });
      if (burn) refresh();
      // Content-Disposition: attachment (signed at upload), so this downloads in place.
      window.location.assign(url);
    } catch (e) {
      if (burnErrorText(e) || gone(e)) refresh();
      setError(e instanceof ApiRequestError && e.code === "LINK_DAILY_LIMIT"
        ? "This link has reached its download limit for today. Try again tomorrow."
        : gone(e)
          ? ROOM_COPY.roomLinkGone
          : (burnErrorText(e) ?? "Couldn't start the download. Try again."));
    }
  };

  const startDownload = (file: ViewerFileDto) => (claims ? setClaiming({ kind: "file", file }) : void download(file));

  const reveal = async () => {
    setError(null);
    try {
      const result = await api.request("POST", `/api/v1/links/${linkId}/reveal`, { body: { confirm: true, ...named }, schema: revealResponse });
      setRevealed({ content: result.text.content, left: result.burn.left });
      refresh();
    } catch (e) {
      if (burnErrorText(e) || gone(e)) refresh();
      setError(gone(e) ? ROOM_COPY.roomLinkGone : (burnErrorText(e) ?? "Something went wrong. Try again."));
    }
  };

  const confirmReceived = async () => {
    setError(null);
    try {
      await api.request("POST", `/api/v1/links/${linkId}/confirm-received`, { body: named });
    } catch {
      setError("Something went wrong. Try again.");
    }
    refresh();
  };

  return (
    <>
      {burn?.textHidden && text === null && (
        <Button size="sm" onClick={() => (claims ? setClaiming({ kind: "text" }) : void reveal())} data-testid="burn-reveal">
          <Eye aria-hidden />
          {BURN.reveal}
        </Button>
      )}
      {text !== null && (
        <>
          <div data-testid="shared-text">
            <LinkedText text={text} />
          </div>
          {revealed && (
            <p className="text-xs text-muted-foreground" data-testid="reveals-left">
              {BURN.revealsLeft(revealed.left)}
            </p>
          )}
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
        </>
      )}
      {share.files.length > 0 && (
        <ul className="space-y-2">
          {share.files.map((file) => (
            <li key={file.id} className="flex items-center gap-3 rounded-lg border p-2">
              {file.previewable ? <Preview api={api} linkId={linkId} file={file} /> : <FileText className="size-8 shrink-0 text-muted-foreground" aria-hidden />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{file.name}</p>
                <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  {formatBytes(file.sizeBytes)}
                  {file.riskFlags.map((flag) => (
                    <Badge key={flag} variant="destructive">
                      {RISK_LABELS[flag] ?? flag}
                    </Badge>
                  ))}
                  {file.downloadsLeft !== undefined && <span data-testid="downloads-left">{BURN.downloadsLeft(file.downloadsLeft)}</span>}
                </p>
                {file.blocked && (
                  <p className="text-xs text-muted-foreground" data-testid="file-blocked">
                    {ROOM_COPY.roomLinkFileBlocked}
                  </p>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                aria-label={`Download ${file.name}`}
                disabled={file.downloadsLeft === 0 || file.blocked === true}
                onClick={() => (file.riskFlags.length > 0 ? setRisky(file) : startDownload(file))}
              >
                <Download aria-hidden />
                Download
              </Button>
            </li>
          ))}
        </ul>
      )}
      {burn?.claimed && burn.byYou && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted p-2" data-testid="burn-claimant">
          <p className="text-xs">{burn.availableUntil && BURN.availableUntil(formatClock(burn.availableUntil))}</p>
          <Button size="sm" variant="outline" onClick={() => void confirmReceived()} data-testid="burn-got-it">
            {BURN.gotIt}
          </Button>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Dialog open={risky !== null} onOpenChange={(open) => !open && setRisky(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{REMOTE_RISK_WARNING.title}</DialogTitle>
            <DialogDescription>{REMOTE_RISK_WARNING.body}</DialogDescription>
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
              {REMOTE_RISK_WARNING.confirm}
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
          if (pending?.kind === "file") void download(pending.file, true);
          else if (pending?.kind === "text") void reveal();
        }}
      />
    </>
  );
}
