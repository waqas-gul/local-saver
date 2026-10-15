import { Users, WifiOff } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { NetworkStatus } from "@/lib/shared/api/schemas";
import { networkLine, statusCopy } from "./copy";

/**
 * Network status: on an ok network, the network and how many devices are here now (the
 * audience itself is stated in the composer, DEC-033); otherwise local sharing is off and the
 * copy says why (03 §3.5).
 */
export function NetworkStatusPanel({
  status,
  reason,
  devicesHere,
}: {
  status: NetworkStatus;
  reason: string | null;
  devicesHere: number;
}) {
  const copy = statusCopy(status, reason);
  if (!copy) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Users className="size-4" aria-hidden />
        <span data-testid="network-line">{networkLine(devicesHere)}</span>
      </div>
    );
  }
  return (
    <Alert data-testid="network-off">
      <WifiOff aria-hidden />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>{copy.body}</AlertDescription>
    </Alert>
  );
}
