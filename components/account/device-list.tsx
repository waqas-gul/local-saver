"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { timeAgo } from "@/components/local/format";
import { BootState } from "@/components/local/boot-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiRequestError } from "@/lib/client/api-error";
import { devicesQuery } from "@/lib/client/queries/account";
import { queryKeys } from "@/lib/client/queries/keys";
import { restartApp, signOut, useRuntime } from "@/lib/client/runtime";
import { useSession } from "@/lib/client/stores/session";
import type { DeviceListItem } from "@/lib/shared/api/schemas";
import { ACCOUNT_COPY } from "./copy";

/**
 * Devices of the account (phase 4 §17.5.6, P4-07): list and sign out (revoke). Also works for a
 * browser refused at the device cap (the device_limit phase): it has no device of its own, so it
 * lists and revokes with its session alone, then starts the app again.
 */

function Devices() {
  const runtime = useRuntime();
  const router = useRouter();
  const queryClient = useQueryClient();
  const phase = useSession((s) => s.phase);
  const devices = useQuery(devicesQuery(runtime?.api ?? null));
  const [confirming, setConfirming] = useState<DeviceListItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!runtime || !devices.data) return <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>;

  const revoke = async (device: DeviceListItem) => {
    setBusy(true);
    setError(null);
    try {
      await runtime.api.request("DELETE", `/api/v1/me/devices/${device.id}`);
      setConfirming(null);
      if (device.current) {
        // This browser: its session is gone on the server; finish signing out here.
        await signOut(runtime, null);
        router.replace("/");
        return;
      }
      if (phase === "device_limit") {
        // A place is free now: start the app again (any pending merge, then registration).
        restartApp();
        router.replace("/");
        return;
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.devices() });
    } catch (e) {
      setError(e instanceof ApiRequestError && e.code === "MFA_REQUIRED" ? ACCOUNT_COPY.mfaRequired : ACCOUNT_COPY.errors.generic);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{ACCOUNT_COPY.devicesIntro}</p>
      {phase === "device_limit" && <p className="text-sm font-medium" data-testid="device-limit">{ACCOUNT_COPY.deviceLimit}</p>}
      <ul className="space-y-2" data-testid="device-list">
        {devices.data.devices.map((device) => (
          <li key={device.id}>
            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {device.label} {device.current && <Badge variant="secondary">{ACCOUNT_COPY.thisDevice}</Badge>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {[device.platform, device.revokedAt ? ACCOUNT_COPY.signedOutDevice : ACCOUNT_COPY.lastSeen(timeAgo(device.lastSeenAt))]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                {!device.revokedAt && (
                  <Button variant="outline" size="sm" onClick={() => setConfirming(device)} data-testid="revoke-device">
                    {ACCOUNT_COPY.signOutDevice}
                  </Button>
                )}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <Dialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirming ? ACCOUNT_COPY.confirmSignOutDevice(confirming.label) : ""}</DialogTitle>
            <DialogDescription>{ACCOUNT_COPY.confirmSignOutDeviceBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)} disabled={busy}>
              {ACCOUNT_COPY.cancel}
            </Button>
            <Button variant="destructive" onClick={() => confirming && void revoke(confirming)} disabled={busy} data-testid="confirm-revoke">
              {ACCOUNT_COPY.signOutDevice}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function DeviceList() {
  const phase = useSession((s) => s.phase);
  const anonymous = useSession((s) => s.anonymous);
  if (phase === "device_limit") return <Devices />;
  return (
    <BootState>
      {anonymous ? (
        <Card>
          <CardContent className="space-y-3">
            <p className="text-sm">{ACCOUNT_COPY.anonymousAccount}</p>
            <Button asChild>
              <Link href="/login">{ACCOUNT_COPY.signIn}</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Devices />
      )}
    </BootState>
  );
}
