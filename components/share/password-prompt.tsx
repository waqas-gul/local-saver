"use client";

import { KeyRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { ApiClient } from "@/lib/client/api-client";
import { ApiRequestError } from "@/lib/client/api-error";
import { usePublicConfig } from "@/lib/client/config";
import { getTurnstileToken } from "@/lib/client/turnstile";
import { PASSWORD_COPY } from "./copy";

/**
 * The share page's password prompt (phase 4 §17.8.3, P4-16). Shown when this browser's grant for a password
 * link hasn't proved the password (409 PASSWORD_REQUIRED from the unlock, a code or the content). The
 * password is never stored: it is in component state while typed, cleared on submit, and sent once, directly
 * (not through a mutation or the query cache). After a lock the server asks for Turnstile, which runs only then.
 */

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === "PASSWORD_INCORRECT") return PASSWORD_COPY.incorrect;
    if (error.code === "LINK_LOCKED") return PASSWORD_COPY.locked(Math.max(1, Math.ceil((error.retryAfterSeconds ?? 900) / 60)));
    if (error.code === "TURNSTILE_REQUIRED") return PASSWORD_COPY.check;
    if (error.code === "SERVER_BUSY") return PASSWORD_COPY.busy;
    if (error.status === 429) return PASSWORD_COPY.limited;
  }
  return PASSWORD_COPY.failed;
}

/** The link itself changed (ended, gone, paused): the page shows that instead of the prompt. */
function handsBack(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 404 || error.status === 410 || error.code === "REMOTE_LINKS_DISABLED");
}

export function PasswordPrompt({
  api,
  linkId,
  onVerified,
  onEnded,
}: {
  api: ApiClient;
  linkId: string;
  onVerified: () => void;
  onEnded: (error: unknown) => void;
}) {
  const config = usePublicConfig();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const typed = password;
    setPassword("");
    setBusy(true);
    setError(null);
    const send = (turnstileToken?: string) =>
      api.request("POST", `/api/v1/links/${linkId}/password`, { body: { password: typed, ...(turnstileToken ? { turnstileToken } : {}) } });
    try {
      try {
        await send();
      } catch (e) {
        // After a lock: solve the check once and try again (phase 4 §17.8.3).
        if (!(e instanceof ApiRequestError && e.code === "TURNSTILE_REQUIRED" && config?.turnstileSiteKey)) throw e;
        await send(await getTurnstileToken(config.turnstileSiteKey));
      }
      onVerified();
    } catch (e) {
      if (handsBack(e)) onEnded(e);
      else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="password-prompt">
      <CardContent>
        <form className="space-y-3" onSubmit={(e) => void submit(e)}>
          <h2 className="flex items-center gap-2 text-lg font-medium">
            <KeyRound aria-hidden className="size-5" />
            {PASSWORD_COPY.promptTitle}
          </h2>
          <p className="text-sm text-muted-foreground">{PASSWORD_COPY.promptBody}</p>
          <label htmlFor="link-password" className="block text-sm font-medium">
            {PASSWORD_COPY.label}
          </label>
          <Input
            id="link-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={512}
            data-testid="password-input"
          />
          <Button type="submit" disabled={busy || password === ""} data-testid="password-submit">
            {PASSWORD_COPY.submit}
          </Button>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
