import Link from "next/link";
import { LegalFooter } from "@/components/share/viewer-shell";

/**
 * Marketing pages (phase 4 §17.6.5): plain server-rendered content, no client runtime, no Supabase
 * session and no third-party scripts.
 */
export default function MarketingLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-6">
      <header>
        <Link href="/" className="font-semibold">
          Local Saver
        </Link>
      </header>
      <main className="flex-1">{children}</main>
      <LegalFooter />
    </div>
  );
}
