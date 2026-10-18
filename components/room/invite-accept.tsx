"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ApiRequestError } from "@/lib/client/api-error";
import { queryKeys } from "@/lib/client/queries/keys";
import { useRuntime } from "@/lib/client/runtime";
import { invitePreviewResponse, roomResponse, type InviteKind, type InvitePreviewResponse } from "@/lib/shared/api/schemas";
import { BootState } from "../local/boot-state";
import { ROOM_COPY } from "./copy";

/**
 * /j/{inviteId}#k={secret} (phase 4 §17.8.4.1). The secret is read once from the fragment (browsers never send it),
 * kept in this component's state only (never the query cache or a store, DEC-034) and stripped from the address at
 * once. The page proves it for a preview (the room's name and size), then waits for the person to confirm: link
 * unfurlers, which have no fragment and don't click, can never join. Joining needs a session, so the page runs inside
 * the app's bootstrap (an anonymous browser becomes an anonymous user, D4-19).
 *
 * P4-18: a QR pairing code opens this same page (a phone's camera reads the URL). Its preview says it is a pairing
 * code, so the page adds that it works once and should be scanned from the screen it is on, and words a refusal
 * after the preview in pairing terms. Scanning alone never joins: only the Join tap does.
 */

function readSecret(): string | null {
  if (!window.location.hash) return null;
  return new URLSearchParams(window.location.hash.slice(1)).get("k");
}

function errorText(error: unknown, kind: InviteKind | null = null): string {
  if (error instanceof ApiRequestError) {
    if (error.code === "INVITE_EXPIRED") return kind === "pairing" ? ROOM_COPY.joinPairingExpired : ROOM_COPY.joinExpired;
    if (error.code === "ROOM_MEMBER_LIMIT") return ROOM_COPY.joinFull;
    if (error.code === "INVITE_UNAVAILABLE") return ROOM_COPY.joinUnavailable;
    if (error.status === 429) return ROOM_COPY.joinRateLimited;
  }
  return ROOM_COPY.joinOther;
}

function Accept({ inviteId }: { inviteId: string }) {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const router = useRouter();
  // Read once, in the browser; the first render shows "Checking…" either way, so hydration matches.
  const [secret] = useState(() => (typeof window === "undefined" ? null : readSecret()));
  const [preview, setPreview] = useState<InvitePreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (window.location.hash) window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }, []);

  useEffect(() => {
    if (!runtime || !secret || started.current) return; // once per page load, even if React mounts twice
    started.current = true;
    runtime.api
      .request("POST", `/api/v1/invites/${inviteId}/preview`, { body: { secret }, schema: invitePreviewResponse })
      .then(setPreview)
      .catch((e: unknown) => setError(errorText(e)));
  }, [runtime, inviteId, secret]);

  const join = async () => {
    if (!runtime || !secret) return;
    setBusy(true);
    setError(null);
    try {
      const { room } = await runtime.api.request("POST", `/api/v1/invites/${inviteId}/accept`, { body: { secret }, schema: roomResponse });
      void queryClient.invalidateQueries({ queryKey: queryKeys.rooms() });
      router.push(`/rooms/${room.id}`);
    } catch (e) {
      setError(errorText(e, preview?.kind ?? null));
      setBusy(false);
    }
  };

  // Opened without its secret (copied in part, or reloaded after the address was cleaned): nothing to prove.
  const shown = error ?? (secret === null ? ROOM_COPY.joinUnavailable : null);
  return (
    <Card data-testid="invite-accept">
      <CardContent className="space-y-3">
        {shown ? (
          <>
            <p className="text-sm" data-testid="invite-error">
              {shown}
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href="/rooms">{ROOM_COPY.backToRooms}</Link>
            </Button>
          </>
        ) : preview ? (
          <>
            <p className="font-medium" data-testid="invite-room">
              {ROOM_COPY.joinPrompt(preview.roomLabel)}
            </p>
            <p className="text-sm text-muted-foreground">{ROOM_COPY.joinMembers(preview.memberCount)}</p>
            {preview.kind === "pairing" && (
              <p className="text-xs text-muted-foreground" data-testid="invite-pairing-hint">
                {ROOM_COPY.joinPairingHint}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{ROOM_COPY.joinWarning}</p>
            <Button onClick={() => void join()} disabled={busy} data-testid="invite-join">
              {ROOM_COPY.join}
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{ROOM_COPY.joinChecking}</p>
        )}
      </CardContent>
    </Card>
  );
}

export function InviteAccept({ inviteId }: { inviteId: string }) {
  return (
    <BootState>
      <Accept inviteId={inviteId} />
    </BootState>
  );
}
