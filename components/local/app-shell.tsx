"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useRuntime } from "@/lib/client/runtime";
import { SessionStore, useSession } from "@/lib/client/stores/session";
import { deviceResponse } from "@/lib/shared/api/schemas";

/** Rename this device: the label others on the network see ("Blue Fox"). */
function DeviceLabel() {
  const runtime = useRuntime();
  const session = SessionStore.useStoreApi();
  const device = useSession((s) => s.device);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!device) return null;

  const save = async () => {
    if (!runtime) return;
    try {
      const { device: updated } = await runtime.api.request("PATCH", `/api/v1/devices/${device.id}`, {
        body: { label },
        schema: deviceResponse,
      });
      session.getState().setDevice(updated);
      setOpen(false);
    } catch {
      setError("Couldn't rename this device.");
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto max-w-full"
        onClick={() => {
          setLabel(device.label);
          setError(null);
          setOpen(true);
        }}
        data-testid="device-label"
      >
        <span className="truncate">{device.label}</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Name this device</DialogTitle>
            <DialogDescription>Others on the same network see this name next to what you post.</DialogDescription>
          </DialogHeader>
          <Textarea value={label} onChange={(e) => setLabel(e.target.value)} rows={1} maxLength={40} aria-label="Device name" />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button onClick={() => void save()} disabled={label.trim() === ""}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const nav = [
    { href: "/", label: "This network" },
    { href: "/uploads", label: "My uploads" },
  ];
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-6">
      {/* Phones: title and device name on the first row, the tabs on their own row below. */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="font-semibold whitespace-nowrap">Local Saver</span>
        <nav className="order-last flex w-full gap-1 text-sm sm:order-none sm:w-auto">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-md px-2 py-1 whitespace-nowrap ${pathname === item.href ? "bg-muted font-medium" : "text-muted-foreground"}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <DeviceLabel />
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
