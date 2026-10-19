"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Link2Off, Lock, LockOpen } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiRequestError } from "@/lib/client/api-error";
import { entitlementsQuery } from "@/lib/client/queries/entitlements";
import { queryKeys } from "@/lib/client/queries/keys";
import { shareLinksQuery } from "@/lib/client/queries/links";
import { useRuntime } from "@/lib/client/runtime";
import { createLinkResponse, regenerateCodeResponse, updateLinkResponse, type CreatedLinkDto, type ShareDto } from "@/lib/shared/api/schemas";
import { passwordLengthOk } from "@/lib/shared/link-password";
import { EXPIRY_LABELS, FREE_LIMITS } from "@/lib/shared/plans";
import { UpgradeHint } from "../billing/upgrade-hint";
import { ShareQr } from "../qr/share-qr";
import { expiresIn } from "../local/format";
import { BURN } from "../burn/copy";
import { CODE_HINT, LINK_WARNING, PASSWORD_COPY, QR_WARNING, REMOTE_BLOCKED } from "./copy";
import { PasswordField } from "./password-field";

/**
 * Share by link, QR code or share code (DEC-013, DEC-014, DEC-033): the creator of a share makes
 * a link to it, from any network. The URL (with the secret in its fragment) and the code exist
 * only in this dialog's component state, shown once: never in Zustand or the query cache, and
 * gone when the dialog closes. Existing links can be revoked or given a new code.
 *
 * Phase 4B (§17.6.5): the link and code options are the caller's plan's (GET /me/entitlements),
 * for new links and new codes on existing links alike (D4-12).
 *
 * Phase 4D (P4-16): a password for a new link, or set and changed on an existing one, when the plan has
 * linkPasswords; removal is offered whatever the plan (D4-12). Like the URL, a typed password lives only in
 * this dialog's state, is cleared once sent and leaves with the dialog; the server keeps only its hash.
 */

const UNTIL_SHARE_EXPIRES = "share";

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === "REMOTE_FILE_BLOCKED") return REMOTE_BLOCKED;
    if (error.code === "REMOTE_LINKS_DISABLED") return "Sharing by link is paused right now.";
    if (error.code === "SHORT_CODES_DISABLED") return "Share codes are paused right now. Create the link without a code.";
    if (error.code === "UPLOAD_INCOMPLETE") return "Wait until the upload has finished.";
    if (error.code === "FEATURE_NOT_IN_PLAN") return PASSWORD_COPY.notInPlan;
    if (error.code === "PASSWORD_INVALID") return PASSWORD_COPY.invalid;
    if (error.code === "LINK_NOT_ACTIVE") return PASSWORD_COPY.notActive;
    if (error.code === "EXPIRY_NOT_ALLOWED") {
      return (error.details as { reason?: string } | undefined)?.reason === "after_share_expiry"
        ? "A link can't last longer than what it shares."
        : "This expiry isn't available on your plan.";
    }
    // OWNER REVIEW (phase 4 §17.6.4, E29 and E30).
    if (error.code === "UPLOADS_RESTRICTED") return "Sharing isn't allowed for this account.";
    if (error.code === "ACCOUNT_DELETION_PENDING") return "This account is being deleted. Cancel the deletion to share again.";
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
  const entitlements = useQuery(entitlementsQuery(api));
  const linkOptions: readonly number[] = entitlements.data?.limits?.linkExpiryOptionsSeconds ?? FREE_LIMITS.linkExpiryOptionsSeconds;
  const codeOptions: readonly number[] = entitlements.data?.limits?.shortCodeExpiryOptionsSeconds ?? FREE_LIMITS.shortCodeExpiryOptionsSeconds;
  const passwordsAllowed = entitlements.data?.features.linkPasswords === true;
  const [created, setCreated] = useState<CreatedLinkDto | null>(null);
  const [freshCode, setFreshCode] = useState<{ linkId: string; code: string; expiresAt: string } | null>(null);
  const [expiry, setExpiry] = useState(UNTIL_SHARE_EXPIRES);
  const [withCode, setWithCode] = useState(false);
  const [codeExpiry, setCodeExpiry] = useState(String(FREE_LIMITS.shortCodeDefaultExpirySeconds));
  const [withPassword, setWithPassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [createdWithPassword, setCreatedWithPassword] = useState(false);
  // The existing link whose password is being set or changed, and what has been typed.
  const [editing, setEditing] = useState<string | null>(null);
  const [editPassword, setEditPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<unknown>(null);
  // When the dialog opened: which expiry options still fit before the share ends.
  const [openedAt] = useState(() => Date.now());

  const remainingMs = Date.parse(share.expiresAt) - openedAt;
  const expiryOptions = linkOptions.filter((s) => s * 1000 < remainingMs - 60_000);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.shareLinks(share.id) });

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      // Secrets leave memory with the dialog.
      setCreated(null);
      setFreshCode(null);
      setNewPassword("");
      setWithPassword(false);
      setEditing(null);
      setEditPassword("");
      setError(null);
      setRefusal(null);
    }
  };

  const run = async (task: () => Promise<void>) => {
    if (!api) return;
    setBusy(true);
    setError(null);
    setRefusal(null);
    try {
      await task();
    } catch (e) {
      setError(errorText(e));
      setRefusal(e);
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
          ...(withPassword ? { password: newPassword } : {}),
        },
        schema: createLinkResponse,
      });
      setCreated(link);
      setCreatedWithPassword(withPassword);
      setNewPassword("");
      setWithPassword(false);
      setFreshCode(null);
      refresh();
    });

  const savePassword = (linkId: string) =>
    run(async () => {
      await api!.request("PATCH", `/api/v1/links/${linkId}`, { body: { password: editPassword }, schema: updateLinkResponse });
      setEditing(null);
      setEditPassword("");
      refresh();
    });

  const removePassword = (linkId: string) =>
    run(async () => {
      await api!.request("PATCH", `/api/v1/links/${linkId}`, { body: { password: null }, schema: updateLinkResponse });
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
            {createdWithPassword && (
              <p className="text-sm" data-testid="created-link-password">
                {PASSWORD_COPY.createdHint}
              </p>
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
                    {codeOptions.map((seconds) => (
                      <SelectItem key={seconds} value={String(seconds)}>
                        Code for {EXPIRY_LABELS[seconds]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {passwordsAllowed && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={withPassword} onChange={(e) => setWithPassword(e.target.checked)} data-testid="with-password" />
                  {PASSWORD_COPY.protect}
                </label>
              )}
            </div>
            {passwordsAllowed && withPassword && (
              <PasswordField id="new-link-password" label={PASSWORD_COPY.fieldLabel} value={newPassword} onChange={setNewPassword} />
            )}
            <Button
              onClick={() => void create()}
              disabled={busy || !api || (withPassword && !passwordLengthOk(newPassword))}
              data-testid="create-link"
            >
              Create link
            </Button>
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <UpgradeHint error={refusal} />

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
                    {link.hasPassword && (
                      <Badge variant="outline" data-testid="link-password-badge">
                        {PASSWORD_COPY.badge}
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {link.state === "active" ? expiresIn(link.expiresAt) : formatTime(link.expiresAt)}
                      {link.state === "active" && link.followsShareExpiry ? " (until the share expires)" : ""} · opened {link.unlockCount}×
                      {link.shortCodeExpiresAt ? " · has a code" : ""}
                    </span>
                    {link.state === "active" && (
                      <span className="ml-auto flex gap-1">
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void newCode(link.id)}>
                          <KeyRound aria-hidden />
                          New code
                        </Button>
                        {passwordsAllowed && (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => {
                              setEditing(link.id);
                              setEditPassword("");
                            }}
                          >
                            <Lock aria-hidden />
                            {link.hasPassword ? PASSWORD_COPY.change : PASSWORD_COPY.set}
                          </Button>
                        )}
                        {link.hasPassword && (
                          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void removePassword(link.id)}>
                            <LockOpen aria-hidden />
                            {PASSWORD_COPY.remove}
                          </Button>
                        )}
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void revoke(link.id)} aria-label="Turn off this link">
                          <Link2Off aria-hidden />
                          Turn off
                        </Button>
                      </span>
                    )}
                  </div>
                  {editing === link.id && link.state === "active" && (
                    <div className="space-y-2 pt-1">
                      <PasswordField id={`password-${link.id}`} label={PASSWORD_COPY.newPasswordLabel} value={editPassword} onChange={setEditPassword} />
                      <div className="flex gap-2">
                        <Button size="sm" disabled={busy || !passwordLengthOk(editPassword)} onClick={() => void savePassword(link.id)}>
                          {PASSWORD_COPY.save}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditing(null);
                            setEditPassword("");
                          }}
                        >
                          {PASSWORD_COPY.cancel}
                        </Button>
                      </div>
                    </div>
                  )}
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
