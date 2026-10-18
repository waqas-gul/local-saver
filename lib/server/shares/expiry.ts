import "server-only";
import { assertOption } from "../entitlements/enforce";
import type { Entitlements } from "../entitlements/types";
import { retentionClassFor, type RetentionClass } from "../storage/keys";

/**
 * Validated expiry for a new share (Q-030, assumed): default 24 h; one of the caller's plan's options
 * (E5): 1 h, 24 h or 7 days on Free, and 30 or 90 days on Pro. The retention class follows from the
 * expiry (30 d → d30, 90 d → d90), so the lifecycle backstop always outlives the share.
 */
export function resolveExpiry(entitlements: Entitlements, expiresIn: number | undefined): {
  seconds: number;
  retentionClass: RetentionClass;
} {
  const seconds = assertOption(entitlements, "localExpiryOptionsSeconds", expiresIn ?? entitlements.limits.localDefaultExpirySeconds);
  return { seconds, retentionClass: retentionClassFor(seconds) };
}
