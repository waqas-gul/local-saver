import Link from "next/link";
import { ApiRequestError } from "@/lib/client/api-error";
import { deliverableLimits, PRO_LIMITS } from "@/lib/shared/plans";
import { BILLING_COPY } from "./copy";

/**
 * The upgrade hint (phase 4 §17.6.5): one line saying what Pro would allow, and a link to the
 * pricing page. Shown on 403 FEATURE_NOT_IN_PLAN and on a 409, 413 or 422 that carries
 * requiredPlan "pro" (the server adds it only when Pro, as this build delivers it, would allow the
 * action), and next to the composer's own limit messages on the same rule. Never on link viewers'
 * pages (DEC-024). Billing settings come with 4C, so the link is always the pricing page.
 */

const PRO = deliverableLimits(PRO_LIMITS);

/** The hint for an API error, or null when Pro wouldn't help. */
export function upgradeHint(error: unknown): string | null {
  if (!(error instanceof ApiRequestError)) return null;
  const details = (error.details ?? {}) as { requiredPlan?: unknown; feature?: unknown; allowed?: unknown };
  if (details.requiredPlan !== "pro") return null;
  if (error.code === "FEATURE_NOT_IN_PLAN") return details.feature === "burnAfterDownload" ? BILLING_COPY.hintBurn : BILLING_COPY.hintFeature;
  if (![409, 413, 422].includes(error.status)) return null;
  switch (error.code) {
    case "TEXT_TOO_LARGE":
      return BILLING_COPY.hintTextSize(PRO.maxTextBytes);
    case "TOO_MANY_FILES":
      return BILLING_COPY.hintFileCount(PRO.maxFilesPerShare);
    case "FILE_TOO_LARGE":
      return BILLING_COPY.hintFileSize(PRO.maxFileBytes);
    case "STORAGE_QUOTA_EXCEEDED":
      return BILLING_COPY.hintStorage(PRO.activeStorageBytes);
    case "EXPIRY_NOT_ALLOWED": {
      // Code options are the only ones with 10 minutes.
      const codes = Array.isArray(details.allowed) && details.allowed.includes(600);
      return codes
        ? BILLING_COPY.hintCodeExpiry(Math.max(...PRO.shortCodeExpiryOptionsSeconds))
        : BILLING_COPY.hintExpiry(Math.max(...PRO.localExpiryOptionsSeconds));
    }
    default:
      return BILLING_COPY.hintFeature;
  }
}

export function UpgradeHint({ error, text }: { error?: unknown; text?: string | null }) {
  const message = text ?? upgradeHint(error);
  if (!message) return null;
  return (
    <p className="text-xs text-muted-foreground" data-testid="upgrade-hint">
      {message}{" "}
      <Link href="/pricing" className="underline underline-offset-2">
        {BILLING_COPY.seePlans}
      </Link>
    </p>
  );
}
