"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiRequestError } from "@/lib/client/api-error";
import { entitlementsQuery } from "@/lib/client/queries/entitlements";
import { queryKeys } from "@/lib/client/queries/keys";
import { useRuntime } from "@/lib/client/runtime";
import { roomResponse, type RoomDto } from "@/lib/shared/api/schemas";
import { EXPIRY_LABELS } from "@/lib/shared/plans";
import { UpgradeHint } from "../billing/upgrade-hint";
import { ROOM_COPY } from "./copy";

/**
 * The owner's room settings (phase 4 §17.8.4): the name (custom names are Pro, E18; a generated name always), whether
 * members may share their posts by link, the default expiry (one of the owner's options), and deleting the room.
 * Every change is checked by the server again.
 */

const NONE = "none";

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === "FEATURE_NOT_IN_PLAN") return ROOM_COPY.settingsErrors.names;
    if (error.code === "EXPIRY_NOT_ALLOWED") return ROOM_COPY.settingsErrors.expiry;
  }
  return ROOM_COPY.settingsErrors.other;
}

export function RoomSettingsDialog({
  room,
  open,
  onOpenChange,
  onDeleted,
  onRoomLinks,
}: {
  room: RoomDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
  /** P4-19: opens the owner's read-only room links (room-link-dialog.tsx). */
  onRoomLinks?: () => void;
}) {
  const runtime = useRuntime();
  const api = runtime?.api ?? null;
  const queryClient = useQueryClient();
  const entitlements = useQuery(entitlementsQuery(api));
  const customNames = entitlements.data?.features.customRoomNames === true;
  const options: readonly number[] = entitlements.data?.limits?.expiryOptionsSeconds ?? [];
  const [name, setName] = useState(room.label);
  const [links, setLinks] = useState(room.settings.membersCanCreateLinks);
  const [expiry, setExpiry] = useState(room.settings.defaultExpirySeconds === null ? NONE : String(room.settings.defaultExpirySeconds));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<unknown>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.room(room.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.rooms() });
  };

  const save = async (body: Record<string, unknown>) => {
    if (!api) return;
    setBusy(true);
    setError(null);
    setRefusal(null);
    try {
      await api.request("PATCH", `/api/v1/rooms/${room.id}`, { body, schema: roomResponse });
      refresh();
      onOpenChange(false);
    } catch (e) {
      setError(errorText(e));
      setRefusal(e);
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    const body: Record<string, unknown> = {};
    const trimmed = name.trim();
    if (customNames && trimmed && trimmed !== room.label) body.name = trimmed;
    if (links !== room.settings.membersCanCreateLinks) body.membersCanCreateLinks = links;
    const chosen = expiry === NONE ? null : Number(expiry);
    if (chosen !== room.settings.defaultExpirySeconds) body.defaultExpirySeconds = chosen;
    if (Object.keys(body).length === 0) onOpenChange(false);
    else void save(body);
  };

  const remove = async () => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      await api.request("DELETE", `/api/v1/rooms/${room.id}`);
      refresh();
      onDeleted();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="room-settings">
        <DialogHeader>
          <DialogTitle>{ROOM_COPY.settings}</DialogTitle>
          <DialogDescription>{ROOM_COPY.settingsDescription}</DialogDescription>
        </DialogHeader>
        {confirmDelete ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">{ROOM_COPY.deleteTitle}</p>
            <p className="text-sm text-muted-foreground">{ROOM_COPY.deleteDescription}</p>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDelete(false)}>
                {ROOM_COPY.cancel}
              </Button>
              <Button variant="destructive" onClick={() => void remove()} disabled={busy} data-testid="confirm-delete-room">
                {ROOM_COPY.deleteRoom}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <label className="block space-y-1 text-sm">
              <span className="block">{ROOM_COPY.rename}</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} disabled={!customNames} data-testid="room-rename" />
            </label>
            {!customNames && <p className="text-xs text-muted-foreground">{ROOM_COPY.settingsErrors.names}</p>}
            <Button variant="link" size="sm" className="px-0" onClick={() => void save({ name: null })} disabled={busy}>
              {ROOM_COPY.generatedName}
            </Button>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4" checked={links} onChange={(e) => setLinks(e.target.checked)} data-testid="room-links-setting" />
              {ROOM_COPY.membersCanCreateLinks}
            </label>
            <div className="space-y-1 text-sm">
              <span className="block">{ROOM_COPY.defaultExpiry}</span>
              <Select value={expiry} onValueChange={setExpiry}>
                <SelectTrigger size="sm" aria-label={ROOM_COPY.defaultExpiry} data-testid="room-default-expiry">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{ROOM_COPY.defaultExpiryNone}</SelectItem>
                  {options.map((seconds) => (
                    <SelectItem key={seconds} value={String(seconds)}>
                      {EXPIRY_LABELS[seconds]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {onRoomLinks && (
              <div className="space-y-1 text-sm">
                <span className="block">{ROOM_COPY.roomLinkTitle}</span>
                <Button size="sm" variant="outline" onClick={onRoomLinks} data-testid="open-room-links">
                  {ROOM_COPY.roomLinksOpen}
                </Button>
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <UpgradeHint error={refusal} />
            <DialogFooter className="flex-wrap gap-2 sm:justify-between">
              <Button variant="ghost" className="text-destructive" onClick={() => setConfirmDelete(true)} data-testid="delete-room">
                {ROOM_COPY.deleteRoom}
              </Button>
              <Button onClick={submit} disabled={busy || !api} data-testid="room-settings-save">
                {ROOM_COPY.save}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
