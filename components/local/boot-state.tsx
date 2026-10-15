"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/client/stores/session";

/** Shows the bootstrap state (session and device) and renders children once ready. */
export function BootState({ children }: { children: ReactNode }) {
  const phase = useSession((s) => s.phase);
  const error = useSession((s) => s.error);

  if (phase === "ready") return <>{children}</>;
  if (phase === "not_configured") {
    return <p className="py-12 text-center text-sm text-muted-foreground">Sharing isn&apos;t set up on this server yet.</p>;
  }
  if (phase === "error") {
    return (
      <div className="space-y-3 py-12 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    );
  }
  return <p className="py-12 text-center text-sm text-muted-foreground">Connecting…</p>;
}
