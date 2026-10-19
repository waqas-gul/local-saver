"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ApiRequestError } from "@/lib/client/api-error";
import { queryKeys } from "@/lib/client/queries/keys";
import { useRuntime } from "@/lib/client/runtime";
import { roomResponse } from "@/lib/shared/api/schemas";
import { UpgradeHint } from "../billing/upgrade-hint";
import { ROOM_COPY } from "./copy";

/**
 * Create a private room (phase 4 §17.8.4, E17, E18). The name field is offered only when the plan has custom names;
 * otherwise the server generates one. The server checks the plan, the cap and the name again.
 */

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === "ROOM_LIMIT") return ROOM_COPY.createErrors.limit((error.details as { maxRooms?: number } | undefined)?.maxRooms ?? 0);
    if (error.code === "UPLOADS_RESTRICTED") return ROOM_COPY.createErrors.restricted;
    if (error.code === "ACCOUNT_DELETION_PENDING") return ROOM_COPY.createErrors.deletion;
    if (error.status === 429) return ROOM_COPY.createErrors.rateLimited;
  }
  return ROOM_COPY.createErrors.other;
}

export function CreateRoomDialog({ customNames, open, onOpenChange }: { customNames: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<unknown>(null);

  const submit = async () => {
    if (!runtime) return;
    setBusy(true);
    setError(null);
    setRefusal(null);
    try {
      const trimmed = name.trim();
      const { room } = await runtime.api.request("POST", "/api/v1/rooms", {
        body: customNames && trimmed ? { name: trimmed } : {},
        schema: roomResponse,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.rooms() });
      onOpenChange(false);
      router.push(`/rooms/${room.id}`);
    } catch (e) {
      setError(errorText(e));
      setRefusal(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="create-room-dialog">
        <DialogHeader>
          <DialogTitle>{ROOM_COPY.createTitle}</DialogTitle>
          <DialogDescription>{ROOM_COPY.createDescription}</DialogDescription>
        </DialogHeader>
        {customNames ? (
          <label className="space-y-1 text-sm">
            <span className="block">{ROOM_COPY.nameLabel}</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              placeholder={ROOM_COPY.namePlaceholder}
              data-testid="room-name"
            />
          </label>
        ) : (
          <p className="text-sm text-muted-foreground">{ROOM_COPY.nameNotInPlan}</p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <UpgradeHint error={refusal} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {ROOM_COPY.cancel}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !runtime} data-testid="create-room-submit">
            {ROOM_COPY.createSubmit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
