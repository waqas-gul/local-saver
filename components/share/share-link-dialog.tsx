"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Link2Off } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiRequestError } from "@/lib/client/api-error";
import { queryKeys } from "@/lib/client/queries/keys";
import { shareLinksQuery } from "@/lib/client/queries/links";
import { useRuntime } from "@/lib/client/runtime";
import { createLinkResponse, regenerateCodeResponse, type CreatedLinkDto, type ShareDto } from "@/lib/shared/api/schemas";
import { EXPIRY_LABELS, FREE_LIMITS } from "@/lib/shared/plans";
import { ShareQr } from "../qr/share-qr";
import { expiresIn } from "../local/format";
import { BURN } from "../burn/copy";
import { CODE_HINT, LINK_WARNING, QR_WARNING, REMOTE_BLOCKED } from "./copy";

/**
 * Share by link, QR code or share code (DEC-013, DEC-014, DEC-033): the creator of a share makes
 * a link to it, from any network. The URL (with the secret in its fragment) and the code exist
 * only in this dialog's component state, shown once: never in Zustand or the query cache, and
 * gone when the dialog closes. Existing links can be revoked or given a new code.
 */

const UNTIL_SHARE_EXPIRES = "share";

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === "REMOTE_FILE_BLOCKED") return REMOTE_BLOCKED;
    if (error.code === "REMOTE_LINKS_DISABLED") return "Sharing by link is paused right now.";
    if (error.code === "SHORT_CODES_DISABLED") return "Share codes are paused right now. Create the link without a code.";
    if (error.code === "UPLOAD_INCOMPLETE") return "Wait until the upload has finished.";
    if (error.code === "EXPIRY_NOT_ALLOWED") return "A link can't last longer than what it shares.";
    if (error.status === 429) return "You've created many links. Wait a little and try again.";
  }
  return "Something went wrong. Try again.";
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function CopyButton({ value, label, testId }: { value: string; label: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      data-testid={testId}
      onClick={() =>
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      <Copy aria-hidden />
      {copied ? "Copied" : label}
    </Button>
  );
}

export function ShareLinkDialog({ share, open, onOpenChange }: { share: ShareDto; open: boolean; onOpenChange: (open: boolean) => void }) {
  const runtime = useRuntime();
  const api = runtime?.api ?? null;
  const queryClient = useQueryClient();
  const links = useQuery(shareLinksQuery(api, share.id, open));
  const [created, setCreated] = useState<CreatedLinkDto | null>(null);
  const [freshCode, setFreshCode] = useState<{ linkId: string; code: string; expiresAt: string } | null>(null);
  const [expiry, setExpiry] = useState(UNTIL_SHARE_EXPIRES);
  const [withCode, setWithCode] = useState(false);
  const [codeExpiry, setCodeExpiry] = useState(String(FREE_LIMITS.shortCodeDefaultExpirySeconds));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When the dialog opened: which expiry options still fit before the share ends.
  const [openedAt] = useState(() => Date.now());

  const remainingMs = Date.parse(share.expiresAt) - openedAt;
  const expiryOptions = FREE_LIMITS.linkExpiryOptionsSeconds.filter((s) => s * 1000 < remainingMs - 60_000);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.shareLinks(share.id) });

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      // Secrets leave memory with the dialog.
      setCreated(null);
      setFreshCode(null);
      setError(null);
    }
  };

  const run = async (task: () => Promise<void>) => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    run(async () => {
      const { link } = await api!.request("POST", `/api/v1/shares/${share.id}/links`, {
        body: {
          ...(expiry === UNTIL_SHARE_EXPIRES ? {} : { expiresIn: Number(expiry) }),
          ...(withCode ? { shortCode: { expiresIn: Number(codeExpiry) } } : {}),
        },
        schema: createLinkResponse,
      });
      setCreated(link);
      setFreshCode(null);
      refresh();
    });

  const revoke = (linkId: string) =>
    run(async () => {
      await api!.request("DELETE", `/api/v1/links/${linkId}`);
      if (created?.id === linkId) setCreated(null);
      if (freshCode?.linkId === linkId) setFreshCode(null);
      refresh();
    });

  const newCode = (linkId: string) =>
    run(async () => {
      const { shortCode } = await api!.request("POST", `/api/v1/links/${linkId}/code`, {
        body: { expiresIn: Number(codeExpiry) },
        schema: regenerateCodeResponse,
      });
      setFreshCode({ linkId, ...shortCode });
      refresh();
    });

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] overflow-y-auto" data-testid="share-link-dialog">
        <DialogHeader>
          <DialogTitle>Share by link</DialogTitle>
          <DialogDescription>{LINK_WARNING}</DialogDescription>
        </DialogHeader>
        {share.burn && (
          <p className="text-sm text-destructive" data-testid="burn-link-warning">
            {BURN.linkWarning}
          </p>
        )}

        {created ? (
          <div className="space-y-3" data-testid="created-link">
            <div className="flex gap-2">
              <Input readOnly value={created.url} aria-label="Share link" data-testid="share-link-url" onFocus={(e) => e.target.select()} />
              <CopyButton value={created.url} label="Copy" testId="copy-link" />
            </div>
            <div className="flex flex-col items-center gap-2">
              <ShareQr url={created.url} />
              <p className="text-center text-xs text-muted-foreground">
                {QR_WARNING} The link works until {formatTime(created.expiresAt)}.
              </p>
            </div>
            {created.shortCode && (
              <div className="rounded-lg border p-3 text-center">
                <p className="text-xs text-muted-foreground">Share code</p>
                <p className="font-mono text-2xl tracking-widest" data-testid="share-code">
                  {created.shortCode.code}
                </p>
                <p className="text-xs text-muted-foreground">
                  Works until {formatTime(created.shortCode.expiresAt)} at {window.location.origin}/c. {CODE_HINT}
                </p>
              </div>
            )}
            <Button variant="ghost" size="sm" onClick={() => setCreated(null)}>
              Create another link
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={expiry} onValueChange={setExpiry}>
                <SelectTrigger size="sm" aria-label="Link expires">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNTIL_SHARE_EXPIRES}>Until the share expires</SelectItem>
                  {expiryOptions.map((seconds) => (
                    <SelectItem key={seconds} value={String(seconds)}>
                      For {EXPIRY_LABELS[seconds]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={withCode} onChange={(e) => setWithCode(e.target.checked)} data-testid="with-code" />
                Also make a share code
              </label>
              {withCode && (
                <Select value={codeExpiry} onValueChange={setCodeExpiry}>
                  <SelectTrigger size="sm" aria-label="Code expires">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FREE_LIMITS.shortCodeExpiryOptionsSeconds.map((seconds) => (
                      <SelectItem key={seconds} value={String(seconds)}>
                        Code for {EXPIRY_LABELS[seconds]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <Button onClick={() => void create()} disabled={busy || !api} data-testid="create-link">
              Create link
            </Button>
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        {links.data && links.data.length > 0 && (
          <section aria-label="Links to this share" className="space-y-2 border-t pt-3">
            <h3 className="text-sm font-medium">Links to this share</h3>
            <ul className="space-y-2">
              {links.data.map((link) => (
                <li key={link.id} className="space-y-1 rounded-lg border p-2 text-sm" data-testid="link-row" data-link-id={link.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={link.state === "active" ? "secondary" : "outline"}>
                      {link.state === "active" ? "Active" : link.state === "revoked" ? "Turned off" : "Expired"}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {link.state === "active" ? expiresIn(link.expiresAt) : formatTime(link.expiresAt)} · opened {link.unlockCount}×
                      {link.shortCodeExpiresAt ? " · has a code" : ""}
                    </span>
                    {link.state === "active" && (
                      <span className="ml-auto flex gap-1">
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void newCode(link.id)}>
                          <KeyRound aria-hidden />
                          New code
                        </Button>
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void revoke(link.id)} aria-label="Turn off this link">
                          <Link2Off aria-hidden />
                          Turn off
                        </Button>
                      </span>
                    )}
                  </div>
                  {freshCode?.linkId === link.id && (
                    <p className="font-mono text-lg tracking-widest" data-testid="fresh-code">
                      {freshCode.code}{" "}
                      <span className="font-sans text-xs tracking-normal text-muted-foreground">until {formatTime(freshCode.expiresAt)}</span>
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}
