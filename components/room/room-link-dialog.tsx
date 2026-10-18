"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiRequestError } from "@/lib/client/api-error";
import { entitlementsQuery } from "@/lib/client/queries/entitlements";
import { queryKeys } from "@/lib/client/queries/keys";
import { roomLinksQuery } from "@/lib/client/queries/rooms";
import { useRuntime } from "@/lib/client/runtime";
import { createLinkResponse, updateLinkResponse, type RoomDto } from "@/lib/shared/api/schemas";
import { passwordLengthOk } from "@/lib/shared/link-password";
import { EXPIRY_LABELS } from "@/lib/shared/plans";
import { UpgradeHint } from "../billing/upgrade-hint";
import { expiresIn } from "../local/format";
import { ShareQr } from "../qr/share-qr";
import { PasswordField } from "../share/password-field";
import { ROOM_COPY } from "./copy";

/**
 * The owner's read-only room links (phase 4 §17.8.5, P4-19; E22, D4-16, D4-17), opened from the room's settings. A new
 * link's URL, with its secret in the fragment, lives only in this dialog's state and is shown once, as text and as a
 * QR code drawn in the browser (never in the query cache or a store, DEC-034); a typed password lives here until it is
 * sent. The room's links are listed without secrets; each can be turned off, and a password removed (D4-12). Without
 * roomLinks (a downgraded owner) the Pro hint replaces the form, and existing links can still be managed.
 */

const PREFERRED_EXPIRY = 86_400;

function refusalText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === "PASSWORD_INVALID") return ROOM_COPY.roomLinkErrors.password;
    if (error.code === "UPLOADS_RESTRICTED") return ROOM_COPY.roomLinkErrors.restricted;
    if (error.code === "ACCOUNT_DELETION_PENDING") return ROOM_COPY.roomLinkErrors.deletion;
    if (error.code === "REMOTE_LINKS_DISABLED") return ROOM_COPY.roomLinkErrors.paused;
    if (error.status === 429) return ROOM_COPY.roomLinkErrors.rateLimited;
  }
  return ROOM_COPY.roomLinkErrors.other;
}

export function RoomLinkDialog({ room, open, onOpenChange }: { room: RoomDto; open: boolean; onOpenChange: (open: boolean) => void }) {
  const runtime = useRuntime();
  const api = runtime?.api ?? null;
  const queryClient = useQueryClient();
  const entitlements = useQuery(entitlementsQuery(api));
  const allowed = entitlements.data?.features.roomLinks === true;
  const passwords = entitlements.data?.features.linkPasswords === true;
  const options = entitlements.data?.limits?.roomLinkExpiryOptionsSeconds ?? [];
  const links = useQuery(roomLinksQuery(api, room.id, open));
  const [chosen, setChosen] = useState<string | null>(null);
  const expiry = chosen ?? String(options.includes(PREFERRED_EXPIRY) ? PREFERRED_EXPIRY : (options[0] ?? PREFERRED_EXPIRY));
  const [password, setPassword] = useState("");
  // The one-time URL: component state only, gone when the dialog closes.
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<unknown>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.roomLinks(room.id) });

  const close = (next: boolean) => {
    if (!next) {
      setCreated(null);
      setPassword("");
    }
    onOpenChange(next);
  };

  const create = async () => {
    if (!api) return;
    if (password && !passwordLengthOk(password)) {
      setError(ROOM_COPY.roomLinkErrors.password);
      return;
    }
    setBusy(true);
    setError(null);
    setRefusal(null);
    try {
      const { link } = await api.request("POST", `/api/v1/rooms/${room.id}/links`, {
        body: { expiresIn: Number(expiry), ...(password ? { password } : {}) },
        schema: createLinkResponse,
      });
      setPassword("");
      setCreated(link.url);
      setCopied(false);
      refresh();
    } catch (e) {
      setError(refusalText(e));
      setRefusal(e);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (linkId: string) => {
    if (!api) return;
    await api.request("DELETE", `/api/v1/links/${linkId}`).catch(() => undefined);
    refresh();
  };

  const removePassword = async (linkId: string) => {
    if (!api) return;
    await api.request("PATCH", `/api/v1/links/${linkId}`, { body: { password: null }, schema: updateLinkResponse }).catch(() => undefined);
    refresh();
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent data-testid="room-link-dialog">
        <DialogHeader>
          <DialogTitle>{ROOM_COPY.roomLinkTitle}</DialogTitle>
          <DialogDescription>{ROOM_COPY.roomLinkDescription}</DialogDescription>
        </DialogHeader>
        <p className="text-xs font-medium text-destructive" data-testid="room-link-warning">
          {ROOM_COPY.roomLinkWarning}
        </p>
        {!allowed ? (
          entitlements.data && <UpgradeHint text={ROOM_COPY.roomLinkNotInPlan} />
        ) : created ? (
          <div className="flex flex-col items-center gap-2">
            <Input readOnly value={created} aria-label={ROOM_COPY.roomLinkTitle} data-testid="room-link-url" onFocus={(e) => e.target.select()} />
            <ShareQr url={created} size={180} label={ROOM_COPY.roomLinkTitle} />
            <p className="text-xs text-muted-foreground">{ROOM_COPY.roomLinkShownOnce}</p>
            <Button
              size="sm"
              onClick={() =>
                void navigator.clipboard.writeText(created).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              {copied ? ROOM_COPY.roomLinkCopied : ROOM_COPY.roomLinkCopy}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <Select value={expiry} onValueChange={setChosen}>
              <SelectTrigger size="sm" aria-label={ROOM_COPY.roomLinkExpiry} data-testid="room-link-expiry">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((seconds) => (
                  <SelectItem key={seconds} value={String(seconds)}>
                    {ROOM_COPY.roomLinkExpiry} {EXPIRY_LABELS[seconds] ?? `${seconds} s`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {passwords && <PasswordField id="room-link-password" label={ROOM_COPY.roomLinkPassword} value={password} onChange={setPassword} />}
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {refusal !== null && <UpgradeHint error={refusal} />}
        <section className="space-y-1" aria-label={ROOM_COPY.roomLinkList}>
          <h3 className="text-sm font-medium">{ROOM_COPY.roomLinkList}</h3>
          {links.data && links.data.length === 0 && <p className="text-xs text-muted-foreground">{ROOM_COPY.roomLinkNone}</p>}
          <ul className="space-y-1">
            {links.data?.map((link) => (
              <li key={link.id} className="flex flex-wrap items-center gap-2 text-xs" data-testid="room-link-row">
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {ROOM_COPY.roomLinkStates[link.state]}
                  {link.state === "active" && ` · ${expiresIn(link.expiresAt)}`}
                </span>
                {link.hasPassword && <Badge variant="secondary">{ROOM_COPY.roomLinkHasPassword}</Badge>}
                {link.hasPassword && (
                  <Button variant="ghost" size="sm" onClick={() => void removePassword(link.id)}>
                    {ROOM_COPY.roomLinkRemovePassword}
                  </Button>
                )}
                {link.state === "active" && (
                  <Button variant="ghost" size="sm" onClick={() => void revoke(link.id)}>
                    {ROOM_COPY.roomLinkRevoke}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            {ROOM_COPY.cancel}
          </Button>
          {allowed && !created && (
            <Button onClick={() => void create()} disabled={busy || !api || options.length === 0} data-testid="room-link-create">
              {ROOM_COPY.roomLinkCreate}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
