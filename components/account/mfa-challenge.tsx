"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { confirmWithAuthenticator, MfaError } from "@/lib/client/mfa";
import { restartApp, signOut, useRuntime } from "@/lib/client/runtime";
import { ACCOUNT_COPY } from "./copy";

/**
 * The authenticator step (phase 4 §17.5.9, P4-24): the mfa phase shows it instead of the app, for an account session the
 * server refused with MFA_REQUIRED. A code from the app raises this session to aal2 (Supabase Auth), then the app starts
 * again. A session Auth has ended (the account added its authenticator from another browser) can't confirm: the browser
 * signs out and starts again without it. So can the person, to use another account.
 */

const COPY = ACCOUNT_COPY.mfa;

export function mfaErrorText(error: unknown): string {
  if (error instanceof MfaError) {
    if (error.kind === "wrong_code") return COPY.errors.wrongCode;
    if (error.kind === "expired") return COPY.errors.expired;
    if (error.kind === "rate_limited") return COPY.errors.rateLimited;
  }
  return COPY.errors.generic;
}

export function MfaGate() {
  const runtime = useRuntime();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!runtime) return null;

  const leave = async () => {
    setBusy(true);
    await signOut(runtime, null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await confirmWithAuthenticator(runtime.supabase, code);
      restartApp();
    } catch (failed) {
      if (failed instanceof MfaError && failed.kind === "session_gone") return leave();
      setError(mfaErrorText(failed));
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-sm space-y-3 py-12" data-testid="mfa-gate">
      <h2 className="font-medium">{COPY.challengeTitle}</h2>
      <p className="text-sm text-muted-foreground">{COPY.challengeIntro}</p>
      <form className="space-y-3" onSubmit={(e) => void submit(e)}>
        <label htmlFor="mfa-gate-code" className="block text-sm font-medium">
          {COPY.codeLabel}
        </label>
        <Input
          id="mfa-gate-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={12}
          className="font-mono text-lg tracking-widest"
          data-testid="mfa-gate-code"
        />
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || code.trim() === ""} data-testid="mfa-gate-continue">
            {COPY.challengeContinue}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void leave()} data-testid="mfa-gate-sign-out">
            {COPY.signOut}
          </Button>
        </div>
      </form>
      <p className="text-xs text-muted-foreground">{COPY.lost}</p>
    </div>
  );
}
