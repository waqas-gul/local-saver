"use client";

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ApiRequestError } from "@/lib/client/api-error";
import { usePublicConfig } from "@/lib/client/config";
import { accountQuery } from "@/lib/client/queries/account";
import { queryKeys } from "@/lib/client/queries/keys";
import { useRuntime, type Runtime } from "@/lib/client/runtime";
import { requestCode, SignInError, verifyCode } from "@/lib/client/sign-in";
import { useSession } from "@/lib/client/stores/session";
import { deletionResponse, type MeResponse } from "@/lib/shared/api/schemas";
import { ACCOUNT_COPY } from "./copy";
import { ResendButton } from "./resend-button";

/**
 * Account deletion (phase 4 §17.5.7, P4-22). In account settings: what happens, a typed confirmation, then
 * DELETE /me. The server wants a sign-in from the last 10 minutes (D4-30): when it answers REAUTH_REQUIRED, a code is
 * emailed to the account and verified here, which signs this browser in again (the runtime moves its device to the
 * new session), and the request is sent once more. On every page, an account whose deletion is scheduled sees a
 * banner with "Cancel deletion" until its date. The server decides everything: the grace, the date, what is refused.
 */

const COPY = ACCOUNT_COPY.deletion;

export const formatDeletionDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

function errorText(error: unknown): string {
  if (error instanceof SignInError) {
    if (error.kind === "wrong_code") return ACCOUNT_COPY.errors.wrongCode;
    if (error.kind === "rate_limited") return ACCOUNT_COPY.errors.rateLimited;
  }
  if (error instanceof ApiRequestError) {
    if (error.code === "MFA_REQUIRED") return COPY.errors.mfa;
    if (error.code === "DELETION_DUE") return COPY.errors.due;
    if (error.code === "RATE_LIMITED") return COPY.errors.rateLimited;
  }
  return ACCOUNT_COPY.errors.generic;
}

/** The account (the banner, the settings section) and the plan (E30 makes it read-only) after a change. */
function refresh(queryClient: QueryClient): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.account() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.entitlements() }),
  ]);
}

function DeleteDialog({ runtime, open, onOpenChange }: { runtime: Runtime; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const config = usePublicConfig();
  const [step, setStep] = useState<"confirm" | "code">("confirm");
  const [typed, setTyped] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentAt, setSentAt] = useState(0);

  const close = (next: boolean) => {
    if (!next) {
      setStep("confirm");
      setTyped("");
      setCode("");
      setError(null);
    }
    onOpenChange(next);
  };

  /** A code to the account's own address (D4-30): its verification is the recent sign-in. */
  const sendCode = async () => {
    const address = (await runtime.supabase.auth.getUser()).data.user?.email ?? "";
    await requestCode(runtime.supabase, runtime.api, address, "account", {
      redirectTo: `${window.location.origin}/auth/callback`,
      turnstileSiteKey: config?.turnstileSiteKey ?? null,
    });
    setEmail(address);
    setSentAt(Date.now());
    setStep("code");
  };

  const schedule = async () => {
    try {
      const { scheduledFor } = await runtime.api.request("DELETE", "/api/v1/me", { schema: deletionResponse });
      queryClient.setQueryData<MeResponse>(queryKeys.account(), (me) => (me ? { ...me, deletion: { scheduledFor } } : me));
      await refresh(queryClient);
      close(false);
    } catch (failed) {
      if (failed instanceof ApiRequestError && failed.code === "REAUTH_REQUIRED" && step === "confirm") return sendCode();
      if (failed instanceof ApiRequestError && failed.code === "DELETION_PENDING") {
        await refresh(queryClient);
        return close(false);
      }
      throw failed;
    }
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failed) {
      setError(errorText(failed));
    } finally {
      setBusy(false);
    }
  };

  const confirm = (event: FormEvent) => {
    event.preventDefault();
    void run(schedule);
  };

  const verify = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await verifyCode(runtime.supabase, runtime.api, email, code, "signin");
      await schedule();
    });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent data-testid="delete-account-dialog">
        <DialogHeader>
          <DialogTitle>{COPY.dialogTitle}</DialogTitle>
          <DialogDescription>{step === "confirm" ? COPY.intro : COPY.reauthIntro(email)}</DialogDescription>
        </DialogHeader>
        {step === "confirm" ? (
          <form className="space-y-3" onSubmit={confirm}>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {COPY.willHappen.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <label htmlFor="delete-confirm" className="block text-sm font-medium">
              {COPY.confirmLabel}
            </label>
            <Input id="delete-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" data-testid="delete-confirm" />
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                {ACCOUNT_COPY.cancel}
              </Button>
              <Button type="submit" variant="destructive" disabled={busy || typed.trim() !== COPY.confirmWord} data-testid="delete-submit">
                {COPY.confirm}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <form className="space-y-3" onSubmit={verify}>
            <label htmlFor="delete-code" className="block text-sm font-medium">
              {ACCOUNT_COPY.codeLabel}
            </label>
            <Input
              id="delete-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              data-testid="delete-code"
            />
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            <DialogFooter>
              <ResendButton sentAt={sentAt} disabled={busy} onClick={() => void run(sendCode)} testId="delete-resend" />
              <Button type="submit" variant="destructive" disabled={busy || code.trim() === ""} data-testid="delete-verify">
                {COPY.confirm}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Account settings: the section, or where the scheduled deletion stands. */
export function DeleteAccountSection({ runtime, me }: { runtime: Runtime; me: MeResponse }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="space-y-2" data-testid="delete-account">
      <h2 className="text-sm font-medium">{COPY.title}</h2>
      {me.deletion ? (
        <p className="text-sm text-muted-foreground">{COPY.pendingHere(formatDeletionDate(me.deletion.scheduledFor))}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{COPY.intro}</p>
          <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="delete-account-open">
            {COPY.open}
          </Button>
          <DeleteDialog runtime={runtime} open={open} onOpenChange={setOpen} />
        </>
      )}
    </section>
  );
}

/** Every page, for an account whose deletion is scheduled (§17.5.7 "Signing in shows a banner"). */
export function DeletionBanner() {
  const account = useSession((s) => s.phase === "ready" && !s.anonymous);
  return account ? <ScheduledDeletion /> : null;
}

function ScheduledDeletion() {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const me = useQuery({ ...accountQuery(runtime?.api ?? null), enabled: Boolean(runtime) });
  const [now] = useState(() => Date.now());
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scheduledFor = me.data?.deletion?.scheduledFor;
  if (!runtime || !scheduledFor) {
    return message ? (
      <p className="text-sm" role="status" data-testid="deletion-cancelled">
        {message}
      </p>
    ) : null;
  }
  const due = new Date(scheduledFor).getTime() <= now;

  const cancel = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await runtime.api.request("POST", "/api/v1/me/deletion/cancel", { body: {} });
      setMessage(COPY.cancelled);
    } catch (failed) {
      // 404: cancelled elsewhere already; the refetch hides the banner.
      if (!(failed instanceof ApiRequestError && failed.status === 404)) setMessage(errorText(failed));
    } finally {
      await refresh(queryClient);
      setBusy(false);
    }
  };

  return (
    <Alert variant="destructive" data-testid="deletion-banner">
      <AlertTitle>{due ? COPY.due : COPY.scheduled(formatDeletionDate(scheduledFor))}</AlertTitle>
      {!due && (
        <AlertDescription className="flex flex-wrap items-center gap-2">
          <span>{COPY.readOnly}</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void cancel()} data-testid="cancel-deletion">
            {COPY.cancel}
          </Button>
        </AlertDescription>
      )}
      {message && <p className="text-sm">{message}</p>}
    </Alert>
  );
}
