import type { Metadata } from "next";
import { DeviceList } from "@/components/account/device-list";
import { AppShell } from "@/components/local/app-shell";

export const metadata: Metadata = { title: "Devices · Local Saver" };

// The account's devices (phase 4 §17.5.6): list and sign out, also from a browser at the device cap.
export default function DeviceSettingsPage() {
  return (
    <AppShell>
      <h1 className="mb-4 text-lg font-medium">Devices</h1>
      <DeviceList />
    </AppShell>
  );
}
