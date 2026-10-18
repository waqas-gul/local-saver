import type { Metadata } from "next";
import { BILLING_COPY } from "@/components/billing/copy";
import { PricingTable } from "@/components/billing/pricing-table";

export const metadata: Metadata = { title: "Plans · Local Saver" };

/** GET /pricing (phase 4 §17.6.5): the Free and Pro comparison. Checkout comes with billing (4C). */
export default function PricingPage() {
  return (
    <article className="space-y-4">
      <h1 className="text-2xl font-semibold">{BILLING_COPY.pricingTitle}</h1>
      <p className="text-sm text-muted-foreground">{BILLING_COPY.pricingIntro}</p>
      <PricingTable />
      <p className="text-xs text-muted-foreground">{BILLING_COPY.needsAccount}</p>
    </article>
  );
}
