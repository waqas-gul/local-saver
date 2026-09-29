import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { connection } from "next/server";
import { AppProviders } from "@/lib/client/providers";
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

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // The CSP nonce is generated per request in proxy.ts, so every page must render
  // dynamically (see the Next.js CSP guide). Never prerender or cache pages statically.
  await connection();

  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
