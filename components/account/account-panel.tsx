"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { BootState } from "@/components/local/boot-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiRequestError } from "@/lib/client/api-error";
import { accountQuery } from "@/lib/client/queries/account";
import { queryKeys } from "@/lib/client/queries/keys";
import { signOut, useRuntime, type Runtime } from "@/lib/client/runtime";
import { isEmail } from "@/lib/client/sign-in";
import { useSession } from "@/lib/client/stores/session";
import { meResponse, type MeResponse } from "@/lib/shared/api/schemas";
import { ACCOUNT_COPY } from "./copy";
import { DeleteAccountSection } from "./delete-account";
import { MfaPanel } from "./mfa-panel";

/**
 * Account settings (phase 4 §17.5.5, P4-08): display name, email (changed through Supabase Auth,
 * confirmed with a code on both addresses), sign-in methods, devices, plan and billing (4C), account deletion (P4-22,
 * delete-account.tsx), the authenticator app (P4-24, mfa-panel.tsx) and sign-out.
 */

function DisplayNameForm({ runtime, me }: { runtime: Runtime; me: MeResponse }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(me.user.displayName ?? "");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const updated = await runtime.api.request("PATCH", "/api/v1/me/profile", {
        body: { displayName: value.trim() === "" ? null : value },
        schema: meResponse,
      });
      queryClient.setQueryData(queryKeys.account(), updated);
      setValue(updated.user.displayName ?? "");
      setStatus(ACCOUNT_COPY.saved);
    } catch {
      setStatus(ACCOUNT_COPY.errors.generic);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="space-y-2" onSubmit={(e) => void save(e)}>
      <label htmlFor="display-name" className="block text-sm font-medium">
        {ACCOUNT_COPY.displayNameLabel}
      </label>
      <p className="text-xs text-muted-foreground">{ACCOUNT_COPY.displayNameHint}</p>
      <div className="flex gap-2">
        <Input id="display-name" value={value} maxLength={60} onChange={(e) => setValue(e.target.value)} data-testid="display-name" />
        <Button type="submit" disabled={busy} data-testid="display-name-save">
          {ACCOUNT_COPY.save}
        </Button>
      </div>
      {status && <p className="text-sm text-muted-foreground" role="status">{status}</p>}
    </form>
  );
}

/** §17.5.5: Supabase sends a code to the current and to the new address (double_confirm_changes). */
function EmailChangeForm({ runtime }: { runtime: Runtime }) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<"closed" | "email" | "codes" | "done">("closed");
  const [newEmail, setNewEmail] = useState("");
  const [currentCode, setCurrentCode] = useState("");
  const [newCode, setNewCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const request = async (event: FormEvent) => {
    event.preventDefault();
    if (!isEmail(newEmail)) return setError(ACCOUNT_COPY.errors.invalidEmail);
    setBusy(true);
    setError(null);
    const { error: failed } = await runtime.supabase.auth.updateUser(
      { email: newEmail.trim() },
      { emailRedirectTo: `${window.location.origin}/auth/callback` },
    );
    setBusy(false);
    if (failed) return setError(failed.code === "email_exists" ? ACCOUNT_COPY.mergeTitle : ACCOUNT_COPY.errors.generic);
    setStep("codes");
  };

  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const current = (await runtime.supabase.auth.getUser()).data.user?.email ?? "";
    for (const [email, token] of [
      [newEmail.trim(), newCode.trim()],
      [current, currentCode.trim()],
    ] as const) {
      const { error: failed } = await runtime.supabase.auth.verifyOtp({ email, token, type: "email_change" });
      if (failed) {
        setBusy(false);
        return setError(ACCOUNT_COPY.errors.wrongCode);
      }
    }
    await runtime.supabase.auth.refreshSession();
    await queryClient.invalidateQueries({ queryKey: queryKeys.account() });
    setBusy(false);
    setStep("done");
  };

  if (step === "closed") {
    return (
      <Button variant="outline" size="sm" onClick={() => setStep("email")} data-testid="change-email">
        {ACCOUNT_COPY.changeEmail}
      </Button>
    );
  }
  if (step === "done") return <p className="text-sm" role="status">{ACCOUNT_COPY.emailChanged}</p>;
  if (step === "email") {
    return (
      <form className="space-y-2" onSubmit={(e) => void request(e)}>
        <label htmlFor="new-email" className="block text-sm font-medium">
          {ACCOUNT_COPY.newEmailLabel}
        </label>
        <div className="flex gap-2">
          <Input id="new-email" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} autoComplete="email" />
          <Button type="submit" disabled={busy || newEmail.trim() === ""}>
            {ACCOUNT_COPY.sendCode}
          </Button>
        </div>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      </form>
    );
  }
  return (
    <form className="space-y-2" onSubmit={(e) => void confirm(e)}>
      <p className="text-sm text-muted-foreground">{ACCOUNT_COPY.changeEmailSent}</p>
      <label htmlFor="current-code" className="block text-sm font-medium">
        {ACCOUNT_COPY.currentCodeLabel}
      </label>
      <Input id="current-code" value={currentCode} onChange={(e) => setCurrentCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" />
      <label htmlFor="new-code" className="block text-sm font-medium">
        {ACCOUNT_COPY.newCodeLabel}
      </label>
      <Input id="new-code" value={newCode} onChange={(e) => setNewCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" />
      <Button type="submit" disabled={busy || currentCode.trim() === "" || newCode.trim() === ""}>
        {ACCOUNT_COPY.verify}
      </Button>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    </form>
  );
}

function AccountDetails() {
  const runtime = useRuntime();
  const router = useRouter();
  const anonymous = useSession((s) => s.anonymous);
  const device = useSession((s) => s.device);
  const me = useQuery({ ...accountQuery(runtime?.api ?? null), enabled: Boolean(runtime) && !anonymous });
  const [signingOut, setSigningOut] = useState(false);

  if (anonymous) {
    return (
      <Card>
        <CardContent className="space-y-3" data-testid="account-anonymous">
          <p className="text-sm">{ACCOUNT_COPY.anonymousAccount}</p>
          <Button asChild>
            <Link href="/login">{ACCOUNT_COPY.signIn}</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (!runtime || !me.data) {
    return me.error instanceof ApiRequestError ? (
      <p className="text-sm text-destructive">{ACCOUNT_COPY.errors.generic}</p>
    ) : (
      <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
    );
  }

  const leave = async () => {
    setSigningOut(true);
    await signOut(runtime, device?.id ?? null);
    router.replace("/");
  };

  return (
    <Card>
      <CardContent className="space-y-6" data-testid="account-panel">
        <section className="space-y-2">
          <h2 className="text-sm font-medium">{ACCOUNT_COPY.emailLabel}</h2>
          <p className="text-sm" data-testid="account-email">
            {me.data.user.email}
          </p>
          <EmailChangeForm runtime={runtime} />
        </section>
        <DisplayNameForm runtime={runtime} me={me.data} />
        <section className="space-y-1">
          <h2 className="text-sm font-medium">{ACCOUNT_COPY.methodsLabel}</h2>
          <ul className="text-sm text-muted-foreground" data-testid="account-methods">
            {me.data.methods.map((m) => (
              <li key={m}>{ACCOUNT_COPY.methodNames[m] ?? m}</li>
            ))}
          </ul>
        </section>
        <MfaPanel runtime={runtime} me={me.data} />
        <section className="space-y-2">
          <h2 className="text-sm font-medium">{ACCOUNT_COPY.devicesTitle}</h2>
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/devices">{ACCOUNT_COPY.manageDevices}</Link>
          </Button>
        </section>
        <section className="space-y-2">
          <h2 className="text-sm font-medium">{ACCOUNT_COPY.billingTitle}</h2>
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/billing" data-testid="account-billing-link">
              {ACCOUNT_COPY.manageBilling}
            </Link>
          </Button>
        </section>
        <DeleteAccountSection runtime={runtime} me={me.data} />
        <section className="space-y-2">
          <p className="text-xs text-muted-foreground">{ACCOUNT_COPY.signOutHint}</p>
          <Button variant="destructive" onClick={() => void leave()} disabled={signingOut} data-testid="sign-out">
            {ACCOUNT_COPY.signOut}
          </Button>
        </section>
      </CardContent>
    </Card>
  );
}

export function AccountPanel() {
  return (
    <BootState>
      <AccountDetails />
    </BootState>
  );
}
