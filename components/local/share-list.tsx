"use client";

import type { ShareDto } from "@/lib/shared/api/schemas";
import { FilePreview } from "./file-preview";
import { ShareCard } from "./share-card";
import { useShareActions } from "./use-share-actions";

function ConnectedShareCard({ share }: { share: ShareDto }) {
  const actions = useShareActions(share);
  return <ShareCard share={share} actions={actions} renderPreview={(file) => <FilePreview file={file} />} />;
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
