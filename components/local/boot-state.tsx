"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ACCOUNT_COPY } from "@/components/account/copy";
import { MfaGate } from "@/components/account/mfa-challenge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SessionStore, useSession } from "@/lib/client/stores/session";

/** A one-time notice from the bootstrap ("This device was signed out"), dismissable. */
function BootNotice() {
  const notice = useSession((s) => s.notice);
  const session = SessionStore.useStoreApi();
  if (!notice) return null;
  return (
    <Alert className="mb-4" data-testid="boot-notice">
      <AlertDescription className="flex items-center justify-between gap-2">
        <span>{notice}</span>
        <Button variant="ghost" size="sm" onClick={() => session.getState().dismissNotice()}>
          OK
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** Shows the bootstrap state (session and device) and renders children once ready. P4-24: the authenticator step first. */
export function BootState({ children }: { children: ReactNode }) {
  const phase = useSession((s) => s.phase);
  const error = useSession((s) => s.error);

  if (phase === "ready") {
    return (
      <>
        <BootNotice />
        {children}
      </>
    );
  }
  if (phase === "not_configured") {
    return <p className="py-12 text-center text-sm text-muted-foreground">Sharing isn&apos;t set up on this server yet.</p>;
  }
  if (phase === "mfa") return <MfaGate />;
  if (phase === "device_limit") {
    return (
      <div className="space-y-3 py-12 text-center" data-testid="device-limit">
        <p className="text-sm">{ACCOUNT_COPY.deviceLimit}</p>
        <Button asChild>
          <Link href="/settings/devices">{ACCOUNT_COPY.manageDevices}</Link>
        </Button>
      </div>
    );
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
