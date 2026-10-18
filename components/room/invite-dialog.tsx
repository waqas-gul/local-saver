"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { entitlementsQuery } from "@/lib/client/queries/entitlements";
import { queryKeys } from "@/lib/client/queries/keys";
import { roomInvitesQuery } from "@/lib/client/queries/rooms";
import { useRuntime } from "@/lib/client/runtime";
import { createInviteResponse, type RoomDto } from "@/lib/shared/api/schemas";
import { EXPIRY_LABELS, INVITE_LINK_EXPIRY_OPTIONS_SECONDS } from "@/lib/shared/plans";
import { UpgradeHint } from "../billing/upgrade-hint";
import { ROOM_COPY } from "./copy";

/**
 * The owner's invite links (phase 4 §17.8.4.1; E21). A new link's URL, with its secret in the fragment, lives only in
 * this dialog's state and is shown once (never in the query cache or a store, DEC-034); the open links are listed
 * without secrets, each can be turned off. QR pairing codes have their own dialog (pairing-qr.tsx, P4-18); the open
 * list the server returns includes them, and this dialog shows only the links.
 */

const UNLIMITED = "unlimited";
const MAX_USES = [1, 5, 10, 25];

export function InviteDialog({ room, open, onOpenChange }: { room: RoomDto; open: boolean; onOpenChange: (open: boolean) => void }) {
  const runtime = useRuntime();
  const api = runtime?.api ?? null;
  const queryClient = useQueryClient();
  const entitlements = useQuery(entitlementsQuery(api));
  const allowed = entitlements.data?.features.multiUseInvites === true;
  const invites = useQuery(roomInvitesQuery(api, room.id, open));
  const links = invites.data?.filter((invite) => invite.kind === "invite_link");
  const [expiresIn, setExpiresIn] = useState(String(INVITE_LINK_EXPIRY_OPTIONS_SECONDS[1]));
  const [maxUses, setMaxUses] = useState(UNLIMITED);
  // The one-time URL: component state only, gone when the dialog closes.
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<unknown>(null);

  const close = (next: boolean) => {
    if (!next) setCreated(null);
    onOpenChange(next);
  };

  const create = async () => {
    if (!api) return;
    setBusy(true);
    setError(null);
    setRefusal(null);
    try {
      const { invite } = await api.request("POST", `/api/v1/rooms/${room.id}/invites`, {
        body: { kind: "invite_link", expiresIn: Number(expiresIn), ...(maxUses === UNLIMITED ? {} : { maxUses: Number(maxUses) }) },
        schema: createInviteResponse,
      });
      setCreated(invite.url);
      setCopied(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.roomInvites(room.id) });
    } catch (e) {
      setError(ROOM_COPY.inviteErrors.other);
      setRefusal(e);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (inviteId: string) => {
    if (!api) return;
    await api.request("DELETE", `/api/v1/invites/${inviteId}`).catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: queryKeys.roomInvites(room.id) });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent data-testid="invite-dialog">
        <DialogHeader>
          <DialogTitle>{ROOM_COPY.inviteTitle}</DialogTitle>
          <DialogDescription>{ROOM_COPY.inviteDescription}</DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground" data-testid="invite-warning">
          {ROOM_COPY.inviteWarning}
        </p>
        {!allowed ? (
          entitlements.data && <UpgradeHint text={ROOM_COPY.inviteNotInPlan} />
        ) : created ? (
          <div className="space-y-2">
            <Input readOnly value={created} aria-label={ROOM_COPY.inviteTitle} data-testid="invite-url" onFocus={(e) => e.target.select()} />
            <p className="text-xs text-muted-foreground">{ROOM_COPY.inviteShownOnce}</p>
            <Button
              size="sm"
              onClick={() =>
                void navigator.clipboard.writeText(created).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              {copied ? ROOM_COPY.inviteCopied : ROOM_COPY.inviteCopy}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Select value={expiresIn} onValueChange={setExpiresIn}>
              <SelectTrigger size="sm" aria-label={ROOM_COPY.inviteExpiry} data-testid="invite-expiry">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INVITE_LINK_EXPIRY_OPTIONS_SECONDS.map((seconds) => (
                  <SelectItem key={seconds} value={String(seconds)}>
                    {ROOM_COPY.inviteExpiry} {EXPIRY_LABELS[seconds]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={maxUses} onValueChange={setMaxUses}>
              <SelectTrigger size="sm" aria-label={ROOM_COPY.inviteMaxUses} data-testid="invite-max-uses">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNLIMITED}>{ROOM_COPY.inviteUnlimited}</SelectItem>
                {MAX_USES.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {ROOM_COPY.inviteUses(n)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {refusal !== null && <UpgradeHint error={refusal} />}
        {allowed && (
          <section className="space-y-1" aria-label={ROOM_COPY.inviteOpen}>
            <h3 className="text-sm font-medium">{ROOM_COPY.inviteOpen}</h3>
            {links && links.length === 0 && <p className="text-xs text-muted-foreground">{ROOM_COPY.inviteOpenNone}</p>}
            <ul className="space-y-1">
              {links?.map((invite) => (
                <li key={invite.inviteId} className="flex items-center gap-2 text-xs" data-testid="open-invite">
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {ROOM_COPY.inviteUsed(invite.useCount, invite.maxUses)} ·{" "}
                    {ROOM_COPY.inviteExpires(new Date(invite.expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }))}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => void revoke(invite.inviteId)}>
                    {ROOM_COPY.inviteRevoke}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            {ROOM_COPY.cancel}
          </Button>
          {allowed && !created && (
            <Button onClick={() => void create()} disabled={busy || !api} data-testid="invite-create">
              {ROOM_COPY.inviteCreate}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
