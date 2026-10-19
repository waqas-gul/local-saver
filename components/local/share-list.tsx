"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { entitlementsQuery } from "@/lib/client/queries/entitlements";
import { useRuntime } from "@/lib/client/runtime";
import type { RoomDto, ShareDto } from "@/lib/shared/api/schemas";
import { ReportDialog } from "../report/report-dialog";
import { ShareLinkDialog } from "../share/share-link-dialog";
import { ExtendDialog } from "./extend-dialog";
import { FilePreview } from "./file-preview";
import { ShareCard } from "./share-card";
import { useShareActions } from "./use-share-actions";

/**
 * Phase 4 (P4-17): on a room's page, the caller's place in the room: its owner deletes anyone's share, and a member
 * makes links to their own only while the room allows it (§17.11.1). The server decides both again.
 */
export type ShareListRoom = Pick<RoomDto, "role" | "settings">;

function ConnectedShareCard({ share, room }: { share: ShareDto; room?: ShareListRoom }) {
  const actions = useShareActions(share);
  const runtime = useRuntime();
  const api = runtime?.api ?? null;
  // Extend is offered only when the plan has it (§17.6.5); the server checks again.
  const entitlements = useQuery({ ...entitlementsQuery(api), enabled: api !== null && share.isMine });
  const canExtend = entitlements.data?.features.extendExpiry === true;
  const [dialog, setDialog] = useState<"link" | "report" | "extend" | null>(null);
  const close = (open: boolean) => !open && setDialog(null);
  const linksAllowed = !room || room.role === "owner" || room.settings.membersCanCreateLinks;
  return (
    <>
      <ShareCard
        share={share}
        actions={actions}
        renderPreview={(file) => <FilePreview file={file} />}
        onShareByLink={linksAllowed ? () => setDialog("link") : undefined}
        onReport={() => setDialog("report")}
        onExtend={canExtend ? () => setDialog("extend") : undefined}
        canDelete={share.isMine || room?.role === "owner"}
        showRoom={!room}
      />
      {dialog === "link" && <ShareLinkDialog share={share} open onOpenChange={close} />}
      {dialog === "extend" && <ExtendDialog share={share} open onOpenChange={close} />}
      {dialog === "report" && (
        <ReportDialog api={api} target={{ type: "share", shareId: share.id }} open onOpenChange={close} />
      )}
    </>
  );
}

export function ShareList({ shares, empty, room }: { shares: ShareDto[]; empty: string; room?: ShareListRoom }) {
  if (shares.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-3" aria-live="polite">
      {shares.map((share) => (
        <li key={share.id}>
          <ConnectedShareCard share={share} room={room} />
        </li>
      ))}
    </ul>
  );
}
