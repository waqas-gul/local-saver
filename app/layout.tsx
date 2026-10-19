import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { connection } from "next/server";
import type { PublicConfig } from "@/lib/client/config";
import { RootProviders } from "@/lib/client/providers";
import { getEnv } from "@/lib/server/env";
import "./globals.css";

// shadcn/ui theme tokens read the body font from --font-sans (app/globals.css).
const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Working name until Q-020 (product name and domain) is answered.
export const metadata: Metadata = {
  title: "Local Saver",
  description: "Share text and files between your devices.",
};

/** Browser-safe settings, read at request time so one build serves every environment (DV1-8). */
function publicConfig(): PublicConfig {
  const env = getEnv();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) return null;
  return {
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
    supabasePublishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    turnstileSiteKey: env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null,
  };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // The CSP nonce is generated per request in proxy.ts, so every page must render
  // dynamically (see the Next.js CSP guide). Never prerender or cache pages statically.
  await connection();
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  // Each route group adds its own providers: (app) the full app runtime, (share) the link
  // viewer's (no Supabase session), (legal) none.
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <RootProviders config={publicConfig()} nonce={nonce}>
          {children}
        </RootProviders>
      </body>
    </html>
  );
}
