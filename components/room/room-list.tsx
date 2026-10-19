"use client";

import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { entitlementsQuery } from "@/lib/client/queries/entitlements";
import { roomsQuery } from "@/lib/client/queries/rooms";
import { useRealtimeBridge } from "@/lib/client/realtime";
import { useRuntime } from "@/lib/client/runtime";
import type { RoomDto } from "@/lib/shared/api/schemas";
import { BILLING_COPY } from "../billing/copy";
import { UpgradeHint } from "../billing/upgrade-hint";
import { BootState } from "../local/boot-state";
import { ROOM_COPY } from "./copy";
import { CreateRoomDialog } from "./create-room-dialog";

/**
 * The caller's rooms (phase 4 §17.14, P4-17), from any network. Creating one is offered only when the plan has
 * private rooms (§17.6.5); everyone may be a member (D4-19). The user: topic refreshes the list when the caller
 * joins, leaves or is removed.
 */

function RoomRow({ room }: { room: RoomDto }) {
  return (
    <li>
      <Link
        href={`/rooms/${room.id}`}
        className="flex items-center gap-3 rounded-lg border p-3 hover:bg-muted"
        data-testid="room-row"
        data-room-id={room.id}
      >
        <Users className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{room.label}</span>
          <span className="block text-xs text-muted-foreground">{ROOM_COPY.members(room.memberCount)}</span>
        </span>
        <Badge variant={room.role === "owner" ? "secondary" : "outline"}>{room.role === "owner" ? ROOM_COPY.owner : ROOM_COPY.member}</Badge>
      </Link>
    </li>
  );
}

function RoomsList() {
  const runtime = useRuntime();
  const api = runtime?.api ?? null;
  // The user: topic only (membership.changed).
  useRealtimeBridge([]);
  const rooms = useQuery(roomsQuery(api));
  const entitlements = useQuery(entitlementsQuery(api));
  const canCreate = entitlements.data?.features.privateRooms === true;
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-4" data-testid="rooms-page">
      <p className="text-sm text-muted-foreground">{ROOM_COPY.intro}</p>
      {canCreate ? (
        <Button onClick={() => setCreating(true)} data-testid="create-room">
          {ROOM_COPY.create}
        </Button>
      ) : (
        entitlements.data && <UpgradeHint text={BILLING_COPY.hintFeature} />
      )}
      <section aria-label={ROOM_COPY.title}>
        {rooms.data ? (
          rooms.data.rooms.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{canCreate ? ROOM_COPY.emptyOwner : ROOM_COPY.empty}</p>
          ) : (
            <ul className="space-y-2">
              {rooms.data.rooms.map((room) => (
                <RoomRow key={room.id} room={room} />
              ))}
            </ul>
          )
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">{ROOM_COPY.loading}</p>
        )}
      </section>
      {creating && <CreateRoomDialog customNames={entitlements.data?.features.customRoomNames === true} open onOpenChange={setCreating} />}
    </div>
  );
}

export function RoomsHome() {
  return (
    <BootState>
      <RoomsList />
    </BootState>
  );
}
