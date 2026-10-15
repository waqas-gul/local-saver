import "server-only";
import { isAllowedExpiry, type Entitlements } from "../entitlements/plans";
import { ApiError } from "../http/errors";
import { retentionClassFor, type RetentionClass } from "../storage/keys";

/** Validated expiry for a new local share (Q-030, assumed): default 24 h; 1 h, 24 h or 7 days. */
export function resolveExpiry(entitlements: Entitlements, expiresIn: number | undefined): {
  seconds: number;
  retentionClass: RetentionClass;
} {
  const seconds = expiresIn ?? entitlements.limits.localDefaultExpirySeconds;
  if (!isAllowedExpiry(entitlements, seconds)) {
    throw new ApiError(422, "EXPIRY_NOT_ALLOWED", "This expiry is not available", {
      allowed: entitlements.limits.localExpiryOptionsSeconds,
    });
  }
  return { seconds, retentionClass: retentionClassFor(seconds) };
}
