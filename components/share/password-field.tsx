"use client";

import { Input } from "@/components/ui/input";
import { isCommonPassword } from "@/lib/shared/link-password";
import { PASSWORD_COPY } from "./copy";

/**
 * The creator's link password input (phase 4 §17.8.3, P4-16): the rules stated, and a warning, never a
 * refusal, for a very common password. The value lives only in the dialog's component state and is cleared
 * once sent (never in Zustand or the query cache).
 */
export function PasswordField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="new-password"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        maxLength={512}
      />
      <p className="text-xs text-muted-foreground" data-testid="password-rules">
        {PASSWORD_COPY.rules}
      </p>
      {isCommonPassword(value) && (
        <p className="text-xs text-amber-700 dark:text-amber-400" role="status" data-testid="password-common">
          {PASSWORD_COPY.common}
        </p>
      )}
    </div>
  );
}
