"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiRequestError } from "@/lib/client/api-error";
import { entitlementsQuery } from "@/lib/client/queries/entitlements";
import { queryKeys } from "@/lib/client/queries/keys";
import { useRuntime } from "@/lib/client/runtime";
import { extendShareResponse, type ShareDto } from "@/lib/shared/api/schemas";
import { UpgradeHint } from "../billing/upgrade-hint";
import { EXTEND_COPY } from "./copy";

/**
 * Extend a share (phase 4 §17.8.2, P4-15): the creator picks one of the plan's expiry options
 * (GET /me/entitlements), counted from now; only those that end later than the share are offered. Only the
 * option is sent: the server checks the plan, the share and the option again. Extended in place, the dialog
 * closes and the share is refetched; when its files must be copied to keep them longer (202), it says so,
 * and the card shows the pending state until the copy is done (Realtime invalidates, as for any change).
 */

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === "EXTENSION_PENDING") return EXTEND_COPY.errorPending;
    if (error.code === "EXPIRY_NOT_ALLOWED") {
      return (error.details as { reason?: string } | undefined)?.reason === "not_later" ? EXTEND_COPY.errorNotLater : EXTEND_COPY.errorPlan;
    }
    if (error.code === "FEATURE_NOT_IN_PLAN") return EXTEND_COPY.errorPlan;
    if (error.code === "EXTEND_NOT_ALLOWED") return EXTEND_COPY.errorNotAllowed;
    if (error.code === "UPLOADS_RESTRICTED") return EXTEND_COPY.errorRestricted;
    if (error.status === 404) return EXTEND_COPY.errorGone;
    if (error.status === 429) return EXTEND_COPY.errorRate;
  }
  return EXTEND_COPY.errorGeneric;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function ExtendDialog({ share, open, onOpenChange }: { share: ShareDto; open: boolean; onOpenChange: (open: boolean) => void }) {
  const runtime = useRuntime();
  const api = runtime?.api ?? null;
  const queryClient = useQueryClient();
  const entitlements = useQuery(entitlementsQuery(api));
  // When the dialog opened: which options still end later than the share (a minute's margin).
  const [openedAt] = useState(() => Date.now());
  const options = (entitlements.data?.limits?.expiryOptionsSeconds ?? []).filter((s) => openedAt + s * 1000 > Date.parse(share.expiresAt) + 60_000);
  const [choice, setChoice] = useState<number | null>(null);
  const chosen = choice !== null && options.includes(choice) ? choice : (options[0] ?? null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<unknown>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.share(share.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.myShares() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.local() });
  };

  const submit = async () => {
    if (!api || chosen === null) return;
    setBusy(true);
    setError(null);
    setRefusal(null);
    try {
      const result = await api.request("POST", `/api/v1/shares/${share.id}/extend`, { body: { expiresIn: chosen }, schema: extendShareResponse });
      refresh();
      if ("extension" in result) setPending(true);
      else onOpenChange(false);
    } catch (e) {
      setError(errorText(e));
      setRefusal(e);
      // The share changed meanwhile (an extension started elsewhere, or it ended): show its current state.
      if (e instanceof ApiRequestError && (e.status === 404 || e.code === "EXTENSION_PENDING")) refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="extend-dialog">
        <DialogHeader>
          <DialogTitle>{EXTEND_COPY.title}</DialogTitle>
          <DialogDescription>{EXTEND_COPY.description}</DialogDescription>
        </DialogHeader>
        {pending ? (
          <p className="text-sm" data-testid="extend-pending">
            {EXTEND_COPY.pending}
          </p>
        ) : options.length > 0 ? (
          <div role="radiogroup" aria-label={EXTEND_COPY.optionsLabel} className="space-y-2">
            {options.map((seconds) => (
              <label key={seconds} className="flex items-center gap-2 text-sm">
                <input type="radio" name="extend-expiry" value={String(seconds)} checked={chosen === seconds} onChange={() => setChoice(seconds)} />
                {EXTEND_COPY.option(seconds)}
                <span className="text-xs text-muted-foreground">{EXTEND_COPY.until(formatTime(openedAt + seconds * 1000))}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{entitlements.data ? EXTEND_COPY.noOptions : "Loading…"}</p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <UpgradeHint error={refusal} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {pending ? EXTEND_COPY.close : EXTEND_COPY.cancel}
          </Button>
          {!pending && (
            <Button onClick={() => void submit()} disabled={busy || chosen === null || !api} data-testid="extend-confirm">
              {EXTEND_COPY.confirm}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
