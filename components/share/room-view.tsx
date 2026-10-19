"use client";

import { Flag } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { ApiClient } from "@/lib/client/api-client";
import { viewerRoomContentResponse, type ViewerRoomContent, type ViewerRoomShareDto } from "@/lib/shared/api/schemas";
import { BURN } from "../burn/copy";
import { expiresIn } from "../local/format";
import { ReportDialog } from "../report/report-dialog";
import { ROOM_COPY } from "../room/copy";
import { ViewerShare } from "./viewer-share";

/**
 * The share page for a read-only room link (phase 4 §17.8.5, P4-19). The room's current active shares, newest first,
 * polled with the rest of the page (no Realtime for viewers); older ones on request, by the server's cursor. Each
 * share is shown as a share link's share is (ViewerShare), and its burn actions and reports name it. Nothing about the
 * room itself is shown or known here: no name, members, settings, who posted, networks or presence (G4).
 */
export function RoomViewerContent({ api, content }: { api: ApiClient; content: ViewerRoomContent }) {
  const linkId = content.link.id;
  const [older, setOlder] = useState<ViewerRoomShareDto[]>([]);
  // undefined: the newest page's cursor (it follows the polling); afterwards, the last page's.
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [reporting, setReporting] = useState<string | null>(null);
  const next = cursor === undefined ? content.room.nextCursor : cursor;
  const shares = [...content.room.shares, ...older.filter((o) => !content.room.shares.some((s) => s.id === o.id))];

  const loadOlder = async () => {
    if (!next) return;
    setLoading(true);
    try {
      const page = await api.request("GET", `/api/v1/links/${linkId}/content?cursor=${encodeURIComponent(next)}`, { schema: viewerRoomContentResponse });
      setOlder((previous) => [...previous, ...page.room.shares]);
      setCursor(page.room.nextCursor);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card data-testid="room-viewer">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <p className="text-sm font-medium">{ROOM_COPY.roomLinkViewerTitle}</p>
        <Badge variant="secondary">{expiresIn(content.link.expiresAt)}</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {shares.length === 0 && <p className="text-sm text-muted-foreground">{ROOM_COPY.roomLinkViewerEmpty}</p>}
        <ul className="space-y-3">
          {shares.map((share) => (
            <li key={share.id} className="space-y-2 rounded-lg border p-3" data-testid="room-share">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{new Date(share.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
                <span className="flex gap-1">
                  {share.burn && (
                    <Badge variant="destructive" data-testid="burn-badge">
                      {BURN.badge}
                    </Badge>
                  )}
                  <Badge variant="secondary">{expiresIn(share.expiresAt)}</Badge>
                </span>
              </div>
              <ViewerShare api={api} linkId={linkId} share={share} shareId={share.id} />
              <Button size="sm" variant="ghost" onClick={() => setReporting(share.id)}>
                <Flag aria-hidden />
                Report
              </Button>
            </li>
          ))}
        </ul>
        {next && (
          <Button size="sm" variant="outline" onClick={() => void loadOlder()} disabled={loading} data-testid="room-older">
            {ROOM_COPY.roomLinkOlder}
          </Button>
        )}
        <p className="text-xs text-muted-foreground">Your access on this device ends {expiresIn(content.access.expiresAt).replace("Expires in", "in")}.</p>
      </CardContent>
      <ReportDialog
        api={api}
        target={{ type: "link", linkId, shareId: reporting ?? undefined }}
        open={reporting !== null}
        onOpenChange={(open) => !open && setReporting(null)}
      />
    </Card>
  );
}
