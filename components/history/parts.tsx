"use client";

import { UpgradeHint, upgradeHint } from "@/components/billing/upgrade-hint";
import { Button } from "@/components/ui/button";
import { ApiRequestError } from "@/lib/client/api-error";
import { HISTORY_COPY } from "./copy";

/** Pieces both history lists share (P4-20). */

export function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** A row of choices for one URL filter; `null` is "all". */
export function Choices<T extends string>({
  label,
  name,
  value,
  options,
  onChange,
}: {
  label: string;
  name: string;
  value: T | null;
  options: readonly (readonly [T | null, string])[];
  onChange: (value: T | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={label}>
      <span className="mr-1 text-xs text-muted-foreground">{label}</span>
      {options.map(([option, text]) => (
        <Button
          key={option ?? "all"}
          variant={value === option ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          data-testid={`history-${name}-${option ?? "all"}`}
        >
          {text}
        </Button>
      ))}
    </div>
  );
}

/** A plan without history (403, E24) gets the Pro hint when Pro would help; anything else, a retry message. */
export function HistoryProblem({ error }: { error: unknown }) {
  if (error instanceof ApiRequestError && error.code === "FEATURE_NOT_IN_PLAN") {
    if (upgradeHint(error)) return <UpgradeHint text={HISTORY_COPY.notInPlan} />;
    return <p className="text-sm text-muted-foreground">{HISTORY_COPY.unavailable}</p>;
  }
  return (
    <p className="text-sm text-destructive" role="alert">
      {HISTORY_COPY.loadFailed}
    </p>
  );
}

export function OlderButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <Button variant="outline" size="sm" className="w-full" onClick={onClick} disabled={busy} data-testid="history-older">
      {HISTORY_COPY.older}
    </Button>
  );
}
