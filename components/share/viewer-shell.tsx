import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Frame for share and code pages: no navigation into the app, no device name, no network
 * status. Viewers are not app users (03 §4.2). Links only to the code page and the legal pages.
 */
export function ViewerShell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-6">
      <header className="flex items-center gap-4">
        <span className="font-semibold whitespace-nowrap">Local Saver</span>
      </header>
      <main className="flex-1">{children}</main>
      <LegalFooter />
    </div>
  );
}

export function LegalFooter() {
  return (
    <footer className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <Link href="/terms">Terms</Link>
      <Link href="/privacy">Privacy</Link>
      <Link href="/acceptable-use">Acceptable use</Link>
      <Link href="/report">Report abuse</Link>
    </footer>
  );
}
