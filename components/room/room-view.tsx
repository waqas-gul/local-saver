"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiRequestError } from "@/lib/client/api-error";
import { queryKeys } from "@/lib/client/queries/keys";
import { roomQuery, roomSharesQuery } from "@/lib/client/queries/rooms";
import { useRealtimeBridge, useRoomRealtime } from "@/lib/client/realtime";
import { useRuntime } from "@/lib/client/runtime";
import { BootState } from "../local/boot-state";
import { Composer } from "../local/composer";
import { ShareList } from "../local/share-list";
import { UploadQueue } from "../local/upload-queue";
import { ROOM_COPY } from "./copy";
import { InviteDialog } from "./invite-dialog";
import { MemberList } from "./member-list";
import { PairingDialog } from "./pairing-qr";
import { RoomLinkDialog } from "./room-link-dialog";
import { RoomSettingsDialog } from "./room-settings";

/**
 * A private room's page (phase 4 §17.14, P4-17): its feed and composer (posting to this room only), its members, and
 * the owner's invite, QR pairing (P4-18), settings and (from the settings) read-only room link (P4-19) dialogs. The QR code is offered to the owner whatever their
 * plan (D4-16); invite links say when they need Pro. It works from any network and never observes one. Realtime on
 * room:{id} and the user: topic only invalidate; a 404 from the room means the caller isn't (or is no longer) a
 * member, or it was deleted: the page then drops what it held about the room, and with it the room's channel.
 */

function RoomView({ roomId }: { roomId: string }) {
  const runtime = useRuntime();
  const api = runtime?.api ?? null;
  const queryClient = useQueryClient();
  const router = useRouter();
  useRealtimeBridge([]);
  const room = useQuery(roomQuery(api, roomId));
  const gone = room.error instanceof ApiRequestError && room.error.status === 404;
  useRoomRealtime(room.data && !gone ? roomId : null);
  const shares = useQuery(roomSharesQuery(api, roomId, room.data !== undefined && !gone));
  const [dialog, setDialog] = useState<"invite" | "pair" | "settings" | "links" | "leave" | null>(null);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!gone) return;
    for (const key of [queryKeys.roomShares(roomId), queryKeys.roomMembers(roomId), queryKeys.roomInvites(roomId)]) {
      queryClient.removeQueries({ queryKey: key });
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.rooms() });
  }, [gone, roomId, queryClient]);

  const leave = async () => {
    if (!api) return;
    setLeaveError(null);
    try {
      await api.request("DELETE", `/api/v1/rooms/${roomId}/members/me`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.rooms() });
      router.push("/rooms");
    } catch {
      setLeaveError(ROOM_COPY.settingsErrors.other);
    }
  };

  if (gone) {
    return (
      <div className="space-y-3 py-12 text-center" data-testid="room-gone">
        <p className="text-sm">{ROOM_COPY.gone}</p>
        <Button asChild variant="outline">
          <Link href="/rooms">{ROOM_COPY.backToRooms}</Link>
        </Button>
      </div>
    );
  }
  if (!room.data) return <p className="py-12 text-center text-sm text-muted-foreground">{ROOM_COPY.loading}</p>;
  const current = room.data;

  return (
    <div className="space-y-4" data-testid="room-page">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold" data-testid="room-label">
          {current.label}
        </h2>
        <span className="text-xs whitespace-nowrap text-muted-foreground" data-testid="room-member-count">
          {ROOM_COPY.members(current.memberCount)}
        </span>
        {current.role === "owner" ? (
          <>
            <Button size="sm" variant="outline" onClick={() => setDialog("invite")} data-testid="room-invite">
              {ROOM_COPY.invite}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDialog("pair")} data-testid="room-pair">
              {ROOM_COPY.pair}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDialog("settings")} data-testid="room-settings-open">
              {ROOM_COPY.settings}
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setDialog("leave")} data-testid="room-leave">
            {ROOM_COPY.leave}
          </Button>
        )}
      </header>
      <Composer key={current.id} room={{ id: current.id, label: current.label, defaultExpirySeconds: current.settings.defaultExpirySeconds }} />
      <UploadQueue />
      <section aria-label={ROOM_COPY.feedLabel} data-testid="room-feed">
        {shares.data ? (
          <ShareList shares={shares.data.shares} empty={ROOM_COPY.feedEmpty} room={current} />
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">{ROOM_COPY.loading}</p>
        )}
      </section>
      <MemberList room={current} />

      {dialog === "invite" && <InviteDialog room={current} open onOpenChange={(open) => !open && setDialog(null)} />}
      {dialog === "pair" && <PairingDialog room={current} open onOpenChange={(open) => !open && setDialog(null)} />}
      {dialog === "links" && <RoomLinkDialog room={current} open onOpenChange={(open) => !open && setDialog(null)} />}
      {dialog === "settings" && (
        <RoomSettingsDialog
          room={current}
          open
          onOpenChange={(open) => !open && setDialog(null)}
          onDeleted={() => router.push("/rooms")}
          onRoomLinks={() => setDialog("links")}
        />
      )}
      <Dialog open={dialog === "leave"} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{ROOM_COPY.leaveTitle}</DialogTitle>
            <DialogDescription>{ROOM_COPY.leaveDescription}</DialogDescription>
          </DialogHeader>
          {leaveError && <p className="text-sm text-destructive">{leaveError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              {ROOM_COPY.cancel}
            </Button>
            <Button variant="destructive" onClick={() => void leave()} data-testid="confirm-leave">
              {ROOM_COPY.leave}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function RoomPage({ roomId }: { roomId: string }) {
  return (
    <BootState>
      <RoomView roomId={roomId} />
    </BootState>
  );
}
