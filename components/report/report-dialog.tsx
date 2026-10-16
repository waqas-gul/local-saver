"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ApiClient } from "@/lib/client/api-client";
import { ApiRequestError } from "@/lib/client/api-error";
import { usePublicConfig } from "@/lib/client/config";
import { getTurnstileToken } from "@/lib/client/turnstile";
import { createReportResponse, REPORT_CATEGORIES, type ReportCategory } from "@/lib/shared/api/schemas";
import { REPORT_CATEGORY_LABELS } from "../share/copy";

/**
 * Report a share (03 §7.6): from the share page (link viewers) or a local feed item (devices on
 * the network). The server decides whether the reporter can see what they report. Turnstile runs
 * only here, only when it is configured, and only once the reporter sends the form.
 */

export type ReportTarget = { type: "link"; linkId: string } | { type: "share"; shareId: string };

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 404 || error.status === 410) return "This share is no longer available, so it can't be reported.";
    if (error.status === 429) return "You've sent several reports recently. Please try again later.";
    if (error.code === "TURNSTILE_REQUIRED") return "We couldn't confirm you're a person. Please try again.";
    if (error.status === 400) return "Please check the form.";
  }
  return "Couldn't send the report. Check your connection and try again.";
}

export function ReportDialog({
  api,
  target,
  open,
  onOpenChange,
}: {
  api: ApiClient | null;
  target: ReportTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const config = usePublicConfig();
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [details, setDetails] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const needsDetails = category === "other" && details.trim().length < 10;
  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setCategory(null);
      setDetails("");
      setEmail("");
      setError(null);
      setSent(false);
    }
  };

  const submit = async () => {
    if (!api || !category || needsDetails) return;
    setBusy(true);
    setError(null);
    try {
      const turnstileToken = config?.turnstileSiteKey ? await getTurnstileToken(config.turnstileSiteKey) : undefined;
      await api.request("POST", "/api/v1/reports", {
        body: {
          target,
          category,
          ...(details.trim() ? { details: details.trim() } : {}),
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(turnstileToken ? { turnstileToken } : {}),
        },
        schema: createReportResponse,
      });
      setSent(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent data-testid="report-dialog">
        <DialogHeader>
          <DialogTitle>{sent ? "Thanks for reporting" : "Report this share"}</DialogTitle>
          <DialogDescription>
            {sent
              ? "Your report was recorded. We don't tell the person who shared it who reported it."
              : "Tell us what's wrong. If someone is in immediate danger, contact your local emergency services."}
          </DialogDescription>
        </DialogHeader>
        {!sent && (
          <div className="space-y-3">
            <fieldset className="space-y-1">
              <legend className="mb-1 text-sm font-medium">What&apos;s the problem?</legend>
              {REPORT_CATEGORIES.map((value) => (
                <label key={value} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="report-category" value={value} checked={category === value} onChange={() => setCategory(value)} />
                  {REPORT_CATEGORY_LABELS[value]}
                </label>
              ))}
            </fieldset>
            <div className="space-y-1">
              <label htmlFor="report-details" className="text-sm font-medium">
                Details {category === "other" ? "" : "(optional)"}
              </label>
              <Textarea id="report-details" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={2000} rows={3} />
            </div>
            <div className="space-y-1">
              <label htmlFor="report-email" className="text-sm font-medium">
                Email (optional, only if you want a reply)
              </label>
              <Input id="report-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} autoComplete="email" />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}
        <DialogFooter>
          {sent ? (
            <Button onClick={() => close(false)}>Done</Button>
          ) : (
            <Button onClick={() => void submit()} disabled={!category || needsDetails || busy} data-testid="report-submit">
              Send report
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
