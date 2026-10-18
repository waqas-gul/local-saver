import type { Metadata } from "next";
import { AccountPanel } from "@/components/account/account-panel";
import { AppShell } from "@/components/local/app-shell";

export const metadata: Metadata = { title: "Account · Local Saver" };

// Account settings (phase 4 §17.5.5): email, display name, sign-in methods, devices, sign-out.
export default function AccountSettingsPage() {
  return (
    <AppShell>
      <h1 className="mb-4 text-lg font-medium">Account</h1>
      <AccountPanel />
    </AppShell>
  );
}
