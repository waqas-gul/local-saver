"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { UserMinus } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { queryKeys } from "@/lib/client/queries/keys";
import { roomMembersQuery } from "@/lib/client/queries/rooms";
import { useRuntime } from "@/lib/client/runtime";
import type { RoomDto, RoomMemberDto } from "@/lib/shared/api/schemas";
import { ROOM_COPY } from "./copy";

/**
 * Who is in the room (D4-15): a label and a role per member, never an email, a user ID, a network or presence. The
 * owner may remove members; a member may leave (the room page offers that). The server decides both again.
 */

export function MemberList({ room }: { room: RoomDto }) {
  const runtime = useRuntime();
  const api = runtime?.api ?? null;
  const queryClient = useQueryClient();
  const members = useQuery(roomMembersQuery(api, room.id));
  const [removing, setRemoving] = useState<RoomMemberDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    if (!api || !removing) return;
    setError(null);
    try {
      await api.request("DELETE", `/api/v1/rooms/${room.id}/members/${removing.memberId}`);
      setRemoving(null);
    } catch {
      setError(ROOM_COPY.settingsErrors.other);
    } finally {
      void queryClient.invalidateQueries({ queryKey: queryKeys.roomMembers(room.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.room(room.id) });
    }
  };

  return (
    <section aria-label={ROOM_COPY.membersTitle} className="space-y-2" data-testid="member-list">
      <h2 className="text-sm font-medium">{ROOM_COPY.membersTitle}</h2>
      {members.data ? (
        <ul className="space-y-1">
          {members.data.map((member) => (
            <li key={member.memberId} className="flex items-center gap-2 text-sm" data-testid="member-row">
              <span className="min-w-0 flex-1 truncate">
                {member.label}
                {member.isYou && <span className="text-muted-foreground"> ({ROOM_COPY.you})</span>}
              </span>
              {member.role === "owner" && <Badge variant="secondary">{ROOM_COPY.owner}</Badge>}
              {room.role === "owner" && member.role === "member" && (
                <Button variant="ghost" size="sm" onClick={() => setRemoving(member)} aria-label={`${ROOM_COPY.remove} ${member.label}`}>
                  <UserMinus aria-hidden />
                  {ROOM_COPY.remove}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{ROOM_COPY.loading}</p>
      )}
      <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{ROOM_COPY.removeTitle}</DialogTitle>
            <DialogDescription>{ROOM_COPY.removeDescription}</DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              {ROOM_COPY.cancel}
            </Button>
            <Button variant="destructive" onClick={() => void remove()} data-testid="confirm-remove">
              {ROOM_COPY.remove}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
