import type { Metadata } from "next";
import { ViewerShell } from "@/components/share/viewer-shell";
import { ViewerProviders } from "@/lib/client/providers";

/**
 * Share and code pages (Phase 2, 03 §4.1): static shells with generic metadata, so link-preview
 * bots learn nothing; noindex and no-referrer here and in proxy.ts headers (T-047). No Supabase
 * session and no third-party scripts (Turnstile loads only if a check is actually required).
 */
export const metadata: Metadata = {
  title: "Something was shared with you · Local Saver",
  description: "Open this link on your device to see what was shared with you.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
  openGraph: { title: "Something was shared with you", description: "Open this link to see it." },
};

export default function ShareLayout({ children }: LayoutProps<"/">) {
  return (
    <ViewerProviders>
      <ViewerShell>{children}</ViewerShell>
    </ViewerProviders>
  );
}
