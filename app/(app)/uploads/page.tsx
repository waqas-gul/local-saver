import type { Metadata } from "next";
import { AppShell } from "@/components/local/app-shell";
import { MyUploads } from "@/components/local/my-uploads";

export const metadata: Metadata = { title: "My uploads · Local Saver" };

// The creator's own shares, from any network (T-014).
export default function UploadsPage() {
  return (
    <AppShell>
      <h1 className="sr-only">My uploads</h1>
      <MyUploads />
    </AppShell>
  );
}
