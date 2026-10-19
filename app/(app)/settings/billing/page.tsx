import type { Metadata } from "next";
import { Suspense } from "react";
import { BillingFromUrl } from "@/components/billing/billing-panel";
import { AppShell } from "@/components/local/app-shell";

export const metadata: Metadata = { title: "Plan and billing · Local Saver" };

// Plan and billing (phase 4 §17.7.6, §17.14): checkout, the provider's portal, and the return page
// after a checkout, which only polls the server for the result.
export default function BillingSettingsPage() {
  return (
    <AppShell>
      <h1 className="mb-4 text-lg font-medium">Plan and billing</h1>
      {/* useSearchParams needs a Suspense boundary (Next.js 16). */}
      <Suspense fallback={null}>
        <BillingFromUrl />
      </Suspense>
    </AppShell>
  );
}
