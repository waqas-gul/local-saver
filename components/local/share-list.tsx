"use client";

import { useState } from "react";
import { useRuntime } from "@/lib/client/runtime";
import type { ShareDto } from "@/lib/shared/api/schemas";
import { ReportDialog } from "../report/report-dialog";
import { ShareLinkDialog } from "../share/share-link-dialog";
import { FilePreview } from "./file-preview";
import { ShareCard } from "./share-card";
import { useShareActions } from "./use-share-actions";

function ConnectedShareCard({ share }: { share: ShareDto }) {
  const actions = useShareActions(share);
  const runtime = useRuntime();
  const [dialog, setDialog] = useState<"link" | "report" | null>(null);
  const close = (open: boolean) => !open && setDialog(null);
  return (
    <>
      <ShareCard
        share={share}
        actions={actions}
        renderPreview={(file) => <FilePreview file={file} />}
        onShareByLink={() => setDialog("link")}
        onReport={() => setDialog("report")}
      />
      {dialog === "link" && <ShareLinkDialog share={share} open onOpenChange={close} />}
      {dialog === "report" && (
        <ReportDialog api={runtime?.api ?? null} target={{ type: "share", shareId: share.id }} open onOpenChange={close} />
      )}
    </>
  );
}

export function ShareList({ shares, empty }: { shares: ShareDto[]; empty: string }) {
  if (shares.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-3" aria-live="polite">
      {shares.map((share) => (
        <li key={share.id}>
          <ConnectedShareCard share={share} />
        </li>
      ))}
    </ul>
  );
}
