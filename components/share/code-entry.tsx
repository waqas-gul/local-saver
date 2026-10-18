"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiRequestError } from "@/lib/client/api-error";
import { usePublicConfig } from "@/lib/client/config";
import { getTurnstileToken } from "@/lib/client/turnstile";
import { createViewerApiClient } from "@/lib/client/viewer-api";
import { resolveCodeResponse } from "@/lib/shared/api/schemas";
import { normalizeShortCode } from "@/lib/shared/short-code";

/**
 * The code page (/c, DEC-014): a short code opens its share on this device. The server turns a
 * valid code into a grant for this browser and returns only the link ID; the page then shows the
 * share at /s/{linkId}, without the link's secret. After several wrong codes the server asks for
 * a Turnstile check, which this page runs only then.
 *
 * A code for a password link (Phase 4, P4-16) gets 409 PASSWORD_REQUIRED with the link ID: the grant is
 * made, unverified, and the share page asks for the password.
 */

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === "CODE_UNAVAILABLE") return "That code isn't valid or has expired. Check it and try again.";
    if (error.code === "TURNSTILE_REQUIRED") return "Please complete the check and try again.";
    if (error.status === 429) return "Too many wrong codes. Please wait and try again later.";
    if (error.code === "REMOTE_LINKS_DISABLED" || error.code === "SHORT_CODES_DISABLED") return "Share codes are paused right now. Please try again later.";
  }
  return "Something went wrong. Check your connection and try again.";
}

export function CodeEntry() {
  const router = useRouter();
  const config = usePublicConfig();
  const [api] = useState(() => createViewerApiClient());
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeShortCode(code);
    if (!normalized) {
      setError("A share code has 10 letters and numbers, like 7KQ4M-X9D2P.");
      return;
    }
    setBusy(true);
    setError(null);
    const resolve = (turnstileToken?: string) =>
      api.request("POST", "/api/v1/codes/resolve", {
        body: { code: normalized, ...(turnstileToken ? { turnstileToken } : {}) },
        schema: resolveCodeResponse,
      });
    try {
      let result;
      try {
        result = await resolve();
      } catch (e) {
        // Escalation after repeated failures (03 §4.4): solve the check once and try again.
        if (!(e instanceof ApiRequestError && e.code === "TURNSTILE_REQUIRED" && config?.turnstileSiteKey)) throw e;
        result = await resolve(await getTurnstileToken(config.turnstileSiteKey));
      }
      router.push(`/s/${result.linkId}`);
    } catch (e) {
      const linkId = e instanceof ApiRequestError && e.code === "PASSWORD_REQUIRED" ? (e.details as { linkId?: unknown } | undefined)?.linkId : null;
      if (typeof linkId === "string" && /^[A-Za-z0-9_-]{16}$/.test(linkId)) {
        router.push(`/s/${linkId}`);
        return;
      }
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent>
        <form className="space-y-3" onSubmit={(e) => void submit(e)}>
          <label htmlFor="share-code" className="block text-sm font-medium">
            Share code
          </label>
          <Input
            id="share-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="7KQ4M-X9D2P"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            maxLength={24}
            className="font-mono text-lg uppercase tracking-widest"
            data-testid="code-input"
          />
          <Button type="submit" disabled={busy || code.trim() === ""} data-testid="code-submit">
            Open
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
