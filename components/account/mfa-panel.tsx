"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cancelEnrolment, confirmEnrolment, removeAuthenticator, startEnrolment, type Enrolment } from "@/lib/client/mfa";
import { queryKeys } from "@/lib/client/queries/keys";
import type { Runtime } from "@/lib/client/runtime";
import type { MeResponse } from "@/lib/shared/api/schemas";
import { ShareQr } from "../qr/share-qr";
import { ACCOUNT_COPY } from "./copy";
import { mfaErrorText } from "./mfa-challenge";

/**
 * Account settings: the authenticator app (phase 4 §17.5.9, P4-24), optional TOTP through Supabase Auth.
 * - Enrolling: Auth makes the factor; its otpauth:// URI is drawn as a QR code here (components/qr: no QR service sees
 *   it) beside its key, and the first code from the app verifies it. The secret lives only in this component's state.
 *   Verifying raises this session to aal2, and Auth ends the account's other sessions.
 * - Removing: a fresh code from the app, then Auth removes the factor (it refuses below aal2).
 * The status comes from GET /me (`mfa.enrolled`), refetched after each change.
 */

const COPY = ACCOUNT_COPY.mfa;

type Step = "idle" | "enrolling" | "done" | "removing" | "removed";

/** The base32 key in groups of four, as authenticator apps show it. */
const grouped = (secret: string) => secret.replace(/(.{4})(?=.)/g, "$1 ");

export function MfaPanel({ runtime, me }: { runtime: Runtime; me: MeResponse }) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("idle");
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failed) {
      setError(mfaErrorText(failed));
    } finally {
      setBusy(false);
    }
  };

  const begin = () =>
    run(async () => {
      setEnrolment(await startEnrolment(runtime.supabase, COPY.factorName));
      setCode("");
      setStep("enrolling");
    });

  const confirm = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await confirmEnrolment(runtime.supabase, enrolment!.factorId, code);
      setEnrolment(null);
      setStep("done");
      await queryClient.invalidateQueries({ queryKey: queryKeys.account() });
    });
  };

  const cancel = () =>
    run(async () => {
      if (enrolment) await cancelEnrolment(runtime.supabase, enrolment.factorId);
      setEnrolment(null);
      setStep("idle");
    });

  const remove = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await removeAuthenticator(runtime.supabase, code);
      setStep("removed");
      await queryClient.invalidateQueries({ queryKey: queryKeys.account() });
    });
  };

  const errorLine = error && (
    <p className="text-sm text-destructive" role="alert">
      {error}
    </p>
  );

  const codeField = (id: string) => (
    <>
      <label htmlFor={id} className="block text-sm font-medium">
        {COPY.codeLabel}
      </label>
      <Input
        id={id}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        autoComplete="one-time-code"
        inputMode="numeric"
        maxLength={12}
        className="font-mono tracking-widest"
        data-testid={id}
      />
    </>
  );

  return (
    <section className="space-y-2" data-testid="mfa-panel">
      <h2 className="text-sm font-medium">{COPY.title}</h2>
      <p className="text-sm text-muted-foreground" data-testid="mfa-status">
        {me.mfa.enrolled ? COPY.on : COPY.off}
      </p>

      {step === "done" && (
        <p className="text-sm" role="status" data-testid="mfa-done">
          {COPY.enabled}
        </p>
      )}
      {step === "removed" && (
        <p className="text-sm" role="status" data-testid="mfa-removed">
          {COPY.removed}
        </p>
      )}

      {step === "enrolling" && enrolment ? (
        <form className="space-y-3" onSubmit={confirm}>
          <p className="text-sm">{COPY.scan}</p>
          <ShareQr url={enrolment.uri} size={176} label={COPY.qrLabel} />
          <p className="text-xs text-muted-foreground">{COPY.keyLabel}</p>
          <p className="break-all font-mono text-sm" data-testid="mfa-key">
            {grouped(enrolment.secret)}
          </p>
          {codeField("mfa-code")}
          {errorLine}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || code.trim() === ""} data-testid="mfa-confirm">
              {COPY.confirm}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => void cancel()} data-testid="mfa-cancel">
              {COPY.cancel}
            </Button>
          </div>
        </form>
      ) : step === "removing" ? (
        <form className="space-y-3" onSubmit={remove}>
          <p className="text-sm font-medium">{COPY.removeTitle}</p>
          <p className="text-sm text-muted-foreground">{COPY.removeBody}</p>
          {codeField("mfa-remove-code")}
          {errorLine}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="destructive" disabled={busy || code.trim() === ""} data-testid="mfa-remove-confirm">
              {COPY.removeConfirm}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setStep("idle")}>
              {COPY.cancel}
            </Button>
          </div>
        </form>
      ) : step === "idle" && me.mfa.enrolled ? (
        <>
          <p className="text-xs text-muted-foreground">{COPY.lost}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setCode("");
              setError(null);
              setStep("removing");
            }}
            data-testid="mfa-remove"
          >
            {COPY.remove}
          </Button>
        </>
      ) : step === "idle" ? (
        <>
          <p className="text-xs text-muted-foreground">{COPY.intro}</p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void begin()} data-testid="mfa-setup">
            {COPY.setUp}
          </Button>
          {errorLine}
        </>
      ) : null}
    </section>
  );
}
