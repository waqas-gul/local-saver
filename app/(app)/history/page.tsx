import type { Metadata } from "next";
import { Suspense } from "react";
import { HistoryFromUrl } from "@/components/history/history-view";
import { AppShell } from "@/components/local/app-shell";

export const metadata: Metadata = { title: "Transfer history · Local Saver" };

// Transfer history (phase 4 §17.8.6, §17.14; P4-20): Pro's record of the caller's own shares and their downloads.
export default function HistoryPage() {
  return (
    <AppShell>
      <h1 className="mb-4 text-lg font-medium">Transfer history</h1>
      {/* useSearchParams needs a Suspense boundary (Next.js 16). */}
      <Suspense fallback={null}>
        <HistoryFromUrl />
      </Suspense>
    </AppShell>
  );
}
