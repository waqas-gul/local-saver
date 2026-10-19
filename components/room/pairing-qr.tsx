"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiRequestError } from "@/lib/client/api-error";
import { queryKeys } from "@/lib/client/queries/keys";
import { roomInvitesQuery } from "@/lib/client/queries/rooms";
import { useRuntime } from "@/lib/client/runtime";
import { createInviteResponse, type RoomDto } from "@/lib/shared/api/schemas";
import { ShareQr } from "../qr/share-qr";
import { ROOM_COPY } from "./copy";

/**
 * QR pairing (phase 4 §17.8.4.1, P4-18; E20): the owner's "Show QR code" dialog. Opening it makes a pairing code (one
 * use, 10 minutes; a downgraded owner may too, D4-16) and draws its URL, secret included, as a QR code in the browser
 * (components/qr/share-qr.tsx: no QR service ever sees it). The URL lives only in this dialog's state: it is never
 * shown as text, linked, copied, cached or stored (DEC-034). A phone's camera opens /j/{inviteId}, which shows the
 * room's name and joins only when that person taps Join.
 *
 * States: making → shown, with a countdown → used (the code left the owner's open invites before it expired: someone
 * joined; Realtime's member.changed refetches that list) or expired; refused (why, and try again). Closing the dialog
 * while the code is still unused turns it off, so a photo of the screen is useless afterwards.
 */

type Code = { inviteId: string; url: string; expiresAt: number; madeAt: number };

function refusalText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 429) return ROOM_COPY.pairErrors.rateLimited;
    if (error.code === "UPLOADS_RESTRICTED") return ROOM_COPY.pairErrors.restricted;
    if (error.code === "ACCOUNT_DELETION_PENDING") return ROOM_COPY.pairErrors.deletion;
  }
  return ROOM_COPY.pairErrors.other;
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function PairingDialog({ room, open, onOpenChange }: { room: RoomDto; open: boolean; onOpenChange: (open: boolean) => void }) {
  const runtime = useRuntime();
  const api = runtime?.api ?? null;
  const queryClient = useQueryClient();
  // The code's URL: component state only, gone when the dialog closes.
  const [code, setCode] = useState<Code | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const started = useRef(false);
  const invites = useQuery(roomInvitesQuery(api, room.id, open && code !== null));

  const make = useCallback(() => {
    if (!api) return;
    void api
      .request("POST", `/api/v1/rooms/${room.id}/invites`, { body: { kind: "pairing" }, schema: createInviteResponse })
      .then(({ invite }) => {
        const madeAt = Date.now();
        setNow(madeAt);
        setRefusal(null);
        setCode({ inviteId: invite.inviteId, url: invite.url, expiresAt: Date.parse(invite.expiresAt), madeAt });
        void queryClient.invalidateQueries({ queryKey: queryKeys.roomInvites(room.id) });
      })
      .catch((e: unknown) => setRefusal(refusalText(e)));
  }, [api, room.id, queryClient]);

  useEffect(() => {
    if (!open || !api || started.current) return; // once per opening, even if React mounts twice
    started.current = true;
    make();
  }, [open, api, make]);

  useEffect(() => {
    if (!code) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [code]);

  const remaining = code ? Math.max(0, Math.ceil((code.expiresAt - now) / 1000)) : 0;
  const expired = code !== null && remaining === 0;
  // Used: a list fetched after the code was made no longer has it, before its expiry.
  const used =
    code !== null &&
    !expired &&
    invites.data !== undefined &&
    invites.dataUpdatedAt >= code.madeAt &&
    !invites.data.some((invite) => invite.inviteId === code.inviteId);
  const live = code !== null && !expired && !used;

  const again = () => {
    setCode(null);
    setRefusal(null);
    make();
  };

  const close = (next: boolean) => {
    if (!next) {
      if (live && code && api) {
        void api
          .request("DELETE", `/api/v1/invites/${code.inviteId}`)
          .catch(() => undefined)
          .finally(() => void queryClient.invalidateQueries({ queryKey: queryKeys.roomInvites(room.id) }));
      }
      setCode(null);
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent data-testid="pairing-dialog">
        <DialogHeader>
          <DialogTitle>{ROOM_COPY.pairTitle}</DialogTitle>
          <DialogDescription>{ROOM_COPY.pairDescription}</DialogDescription>
        </DialogHeader>
        {refusal ? (
          <p className="text-sm text-destructive" data-testid="pairing-error">
            {refusal}
          </p>
        ) : !code ? (
          <p className="text-sm text-muted-foreground" data-testid="pairing-making">
            {ROOM_COPY.pairMaking}
          </p>
        ) : used ? (
          <p className="text-sm" data-testid="pairing-used">
            {ROOM_COPY.pairUsed}
          </p>
        ) : expired ? (
          <p className="text-sm" data-testid="pairing-expired">
            {ROOM_COPY.pairExpired}
          </p>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <ShareQr url={code.url} size={220} label={ROOM_COPY.pairQrLabel(room.label)} />
            <p className="max-w-full truncate text-sm font-medium" data-testid="pairing-room">
              {ROOM_COPY.pairScan(room.label)}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums" data-testid="pairing-countdown">
              {ROOM_COPY.pairExpiresIn(clock(remaining))}
            </p>
            <p className="text-xs text-muted-foreground" data-testid="pairing-warning">
              {ROOM_COPY.pairWarning}
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            {ROOM_COPY.pairClose}
          </Button>
          {(refusal !== null || used || expired) && (
            <Button onClick={again} disabled={!api} data-testid="pairing-new">
              {ROOM_COPY.pairNew}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
