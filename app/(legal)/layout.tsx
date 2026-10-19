import Link from "next/link";
import { LegalFooter } from "@/components/share/viewer-shell";

/** Legal pages (Phase 2 drafts): plain server-rendered text, no client runtime and no Supabase session. */
export default function LegalLayout({ children }: LayoutProps<"/">) {
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
