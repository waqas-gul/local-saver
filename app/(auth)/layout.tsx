import type { Metadata } from "next";
import Link from "next/link";
import { AuthProviders } from "@/lib/client/providers";

/**
 * Sign-in pages (phase 4 §17.5.2, C4-1): the Supabase client without the app's bootstrap, so these
 * pages never create an anonymous user. noindex and no-referrer here and in proxy.ts headers: the
 * callback URL carries a one-time code.
 */
export const metadata: Metadata = {
  title: "Sign in · Local Saver",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <AuthProviders>
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6">
        <header>
          <Link href="/" className="font-semibold">
            Local Saver
          </Link>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
        </footer>
      </div>
    </AuthProviders>
  );
}
