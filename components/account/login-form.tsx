"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiRequestError } from "@/lib/client/api-error";
import { useAuthRuntime } from "@/lib/client/auth-runtime";
import { usePublicConfig } from "@/lib/client/config";
import type { MergeOutcome } from "@/lib/client/merge";
import {
  currentMode,
  googleEnabled,
  requestCode,
  SignInError,
  startGoogle,
  verifyCode,
  type CodeKind,
  type SignInMode,
} from "@/lib/client/sign-in";
import { ACCOUNT_COPY } from "./copy";
import { ResendButton } from "./resend-button";

/**
 * /login (phase 4 §17.5.2): email → code, or Google. On an anonymous browser this is the upgrade
 * (same user, nothing moves) or, when the email already has an account, the merge offer. A new code
 * can be asked for once a minute (P4-23, ResendButton).
 */

type Step = "loading" | "email" | "merge_offer" | "code" | "signed_in" | "merge_problem";

function errorText(error: unknown): string {
  if (error instanceof SignInError) {
    if (error.kind === "invalid_email") return ACCOUNT_COPY.errors.invalidEmail;
    if (error.kind === "wrong_code") return ACCOUNT_COPY.errors.wrongCode;
    if (error.kind === "rate_limited") return ACCOUNT_COPY.errors.rateLimited;
    if (error.kind === "no_account") return ACCOUNT_COPY.errors.noAccount;
  }
  if (error instanceof ApiRequestError) {
    if (error.code === "USER_SUSPENDED") return ACCOUNT_COPY.errors.suspended;
    if (error.status === 429) return ACCOUNT_COPY.errors.rateLimited;
  }
  return ACCOUNT_COPY.errors.generic;
}

export function callbackUrl(): string {
  return `${window.location.origin}/auth/callback`;
}

/** Shared with the callback page: what to say when a pending merge didn't finish. */
export function mergeProblem(merge: MergeOutcome | null): string | null {
  if (merge?.kind === "device_limit") return ACCOUNT_COPY.errors.mergeDeviceLimit;
  if (merge?.kind === "gone") return ACCOUNT_COPY.errors.mergeFailed;
  return null;
}

export function MergeProblem({ message }: { message: string }) {
  return (
    <div className="space-y-3" data-testid="merge-problem">
      <p className="text-sm">{message}</p>
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link href="/settings/devices">{ACCOUNT_COPY.manageDevices}</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/">{ACCOUNT_COPY.goToApp}</Link>
        </Button>
      </div>
    </div>
  );
}

export function GoogleButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <Button type="button" variant="outline" className="w-full" onClick={onClick} disabled={disabled} data-testid="google-sign-in">
      {ACCOUNT_COPY.google}
    </Button>
  );
}

export function LoginForm() {
  const runtime = useAuthRuntime();
  const config = usePublicConfig();
  const router = useRouter();
  const [step, setStep] = useState<Step>("loading");
  const [mode, setMode] = useState<SignInMode>("fresh");
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null);
  const [google, setGoogle] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [kind, setKind] = useState<CodeKind>("signin");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState(0);

  useEffect(() => {
    if (!runtime || !config) return;
    let cancelled = false;
    void currentMode(runtime.supabase).then(({ mode: m, email: e }) => {
      if (cancelled) return;
      setMode(m);
      setSignedInEmail(e);
      setStep(m === "account" ? "signed_in" : "email");
    });
    void googleEnabled(config.supabaseUrl, config.supabasePublishableKey).then((on) => !cancelled && setGoogle(on));
    return () => {
      cancelled = true;
    };
  }, [runtime, config]);

  if (!runtime || !config) return <p className="text-sm text-muted-foreground">{ACCOUNT_COPY.errors.notConfigured}</p>;
  if (step === "loading") return <p className="text-sm text-muted-foreground">…</p>;

  const options = { redirectTo: callbackUrl(), turnstileSiteKey: config.turnstileSiteKey };

  const send = async (mergeConfirmed = false) => {
    setBusy(true);
    setError(null);
    try {
      const result = await requestCode(runtime.supabase, runtime.api, email, mode, { ...options, mergeConfirmed });
      if (result.next === "merge_offer") setStep("merge_offer");
      else {
        setKind(result.kind);
        setCode("");
        setSentAt(Date.now());
        setStep("code");
      }
    } catch (e) {
      // Supabase's per-address interval: the resend button waits it out.
      if (e instanceof SignInError && e.kind === "rate_limited") setSentAt(Date.now());
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { merge } = await verifyCode(runtime.supabase, runtime.api, email, code, kind);
      const message = mergeProblem(merge);
      if (message) {
        setProblem(message);
        setStep("merge_problem");
        setBusy(false);
        return;
      }
      router.replace("/");
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const withGoogle = async (merge = false) => {
    setBusy(true);
    setError(null);
    try {
      await startGoogle(runtime.supabase, runtime.api, mode, { redirectTo: options.redirectTo, merge });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const errorLine = error && (
    <p className="text-sm text-destructive" role="alert" data-testid="login-error">
      {error}
    </p>
  );

  if (step === "signed_in") {
    return (
      <Card>
        <CardContent className="space-y-3">
          <p className="text-sm" data-testid="login-signed-in">
            {ACCOUNT_COPY.alreadySignedIn(signedInEmail)}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/">{ACCOUNT_COPY.goToApp}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/settings/account">{ACCOUNT_COPY.goToAccount}</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (step === "merge_problem" && problem) {
    return (
      <Card>
        <CardContent>
          <MergeProblem message={problem} />
        </CardContent>
      </Card>
    );
  }

  if (step === "merge_offer") {
    return (
      <Card>
        <CardContent className="space-y-3" data-testid="merge-offer">
          <h2 className="font-medium">{ACCOUNT_COPY.mergeTitle}</h2>
          <p className="text-sm text-muted-foreground">{ACCOUNT_COPY.mergeBody}</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void send(true)} disabled={busy} data-testid="merge-continue">
              {ACCOUNT_COPY.mergeContinue}
            </Button>
            <Button variant="outline" onClick={() => setStep("email")} disabled={busy}>
              {ACCOUNT_COPY.useAnotherEmail}
            </Button>
          </div>
          {errorLine}
        </CardContent>
      </Card>
    );
  }

  if (step === "code") {
    return (
      <Card>
        <CardContent>
          <form className="space-y-3" onSubmit={(e) => void verify(e)}>
            <p className="text-sm text-muted-foreground" data-testid="code-sent">
              {ACCOUNT_COPY.codeSent(email.trim())}
            </p>
            <label htmlFor="login-code" className="block text-sm font-medium">
              {ACCOUNT_COPY.codeLabel}
            </label>
            <Input
              id="login-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={12}
              className="font-mono text-lg tracking-widest"
              data-testid="login-code"
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy || code.trim() === ""} data-testid="login-verify">
                {ACCOUNT_COPY.verify}
              </Button>
              <ResendButton sentAt={sentAt} disabled={busy} onClick={() => void send(kind === "merge")} testId="login-resend" />
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setStep("email")}>
                {ACCOUNT_COPY.useAnotherEmail}
              </Button>
            </div>
            {errorLine}
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <p className="text-sm text-muted-foreground">{mode === "anonymous" ? ACCOUNT_COPY.anonymousIntro : ACCOUNT_COPY.loginIntro}</p>
          <label htmlFor="login-email" className="block text-sm font-medium">
            {ACCOUNT_COPY.emailLabel}
          </label>
          <Input
            id="login-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            maxLength={254}
            data-testid="login-email"
          />
          <Button type="submit" className="w-full" disabled={busy || email.trim() === ""} data-testid="login-send">
            {ACCOUNT_COPY.sendCode}
          </Button>
          {google && (
            <>
              <p className="text-center text-xs text-muted-foreground">{ACCOUNT_COPY.or}</p>
              <GoogleButton onClick={() => void withGoogle()} disabled={busy} />
            </>
          )}
          {errorLine}
        </form>
      </CardContent>
    </Card>
  );
}
