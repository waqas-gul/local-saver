import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * Frame for the legal drafts (Phase 2 scope: "legal review happens before public beta"). Every
 * page says it is an unreviewed draft. Text marked [OWNER] waits for an owner decision
 * (Q-020 name and domain, Q-022 operator and legal contact, Q-016 markets).
 */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <article className="space-y-4 text-sm leading-relaxed [&_h2]:mt-6 [&_h2]:text-base [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc">
      <h1 className="text-xl font-semibold">{title}</h1>
      <Alert data-testid="legal-draft">
        <AlertTitle>Draft: not yet reviewed by a lawyer</AlertTitle>
        <AlertDescription>
          This text is a working draft for testing. It is not in force and will change after legal review, before the
          service opens to the public.
        </AlertDescription>
      </Alert>
      <p className="text-xs text-muted-foreground">Draft of {updated}. &quot;Local Saver&quot; is a working name.</p>
      {children}
    </article>
  );
}
