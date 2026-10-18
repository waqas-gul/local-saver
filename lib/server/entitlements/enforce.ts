import "server-only";
import { ApiError } from "../http/errors";
import { deliverable, PRO_PLAN } from "./plans";
import type { Entitlements, FeatureName, Limits, Plan } from "./types";

/**
 * Enforcement helpers (phase 4 §17.6.1, 07 §4). The checks stay in the services; these only build
 * the 07 §4 error contract the same way everywhere. An error carries `requiredPlan: "pro"` exactly
 * when Pro, as this deployment can deliver it, would allow the action, so the UI's upgrade hint
 * never promises what an upgrade wouldn't give (§17.6.5).
 */

const PRO_NOW = deliverable(PRO_PLAN);

function hint(entitlements: Plan, proAllows: (pro: Plan) => boolean): { requiredPlan?: "pro" } {
  return entitlements.plan !== "pro" && proAllows(PRO_NOW) ? { requiredPlan: "pro" } : {};
}

/** 403 FEATURE_NOT_IN_PLAN { feature, requiredPlan? } unless the plan has the feature. */
export function assertFeature(entitlements: Plan, feature: FeatureName, message: string): void {
  if (entitlements.features[feature]) return;
  throw new ApiError(403, "FEATURE_NOT_IN_PLAN", message, { feature, ...hint(entitlements, (pro) => pro.features[feature]) });
}

/** E2: 413 TOO_MANY_FILES { maxFiles, requiredPlan? }. */
export function assertFileCount(entitlements: Plan, count: number): void {
  const max = entitlements.limits.maxFilesPerShare;
  if (count <= max) return;
  throw new ApiError(413, "TOO_MANY_FILES", "Too many files in one share", {
    maxFiles: max,
    ...hint(entitlements, (pro) => count <= pro.limits.maxFilesPerShare),
  });
}

/** E1: 413 FILE_TOO_LARGE { maxFileBytes, requiredPlan? }. */
export function assertFileSizes(entitlements: Plan, sizes: readonly number[]): void {
  const max = entitlements.limits.maxFileBytes;
  const largest = Math.max(...sizes);
  if (largest <= max) return;
  throw new ApiError(413, "FILE_TOO_LARGE", "A file is larger than the limit", {
    maxFileBytes: max,
    ...hint(entitlements, (pro) => largest <= pro.limits.maxFileBytes),
  });
}

/**
 * E3 and E4: 413 TEXT_TOO_LARGE { maxBytes, requiredPlan? }. A new text is checked against the
 * caller's plan; an edit against the share's snapshot (`snapshot: true`), which an upgrade doesn't
 * change, so it never carries requiredPlan.
 */
export function assertTextSize(entitlements: Plan, content: string, options: { snapshot?: boolean } = {}): number {
  const bytes = Buffer.byteLength(content, "utf8");
  const max = entitlements.limits.maxTextBytes;
  if (bytes <= max) return bytes;
  throw new ApiError(413, "TEXT_TOO_LARGE", "This text is too long", {
    maxBytes: max,
    ...(options.snapshot ? {} : hint(entitlements, (pro) => bytes <= pro.limits.maxTextBytes)),
  });
}

type OptionKind = "localExpiryOptionsSeconds" | "linkExpiryOptionsSeconds" | "shortCodeExpiryOptionsSeconds" | "roomLinkExpiryOptionsSeconds";
const OPTION_NAMES: Record<OptionKind, string> = {
  localExpiryOptionsSeconds: "expiry",
  linkExpiryOptionsSeconds: "link expiry",
  shortCodeExpiryOptionsSeconds: "code expiry",
  roomLinkExpiryOptionsSeconds: "room link expiry",
};

/** E5, E13, E14, E22: 422 EXPIRY_NOT_ALLOWED { allowed, requiredPlan? } unless `seconds` is one of the plan's options. */
export function assertOption(entitlements: Plan, kind: OptionKind, seconds: number): number {
  const allowed: Limits[OptionKind] = entitlements.limits[kind];
  if (allowed.includes(seconds)) return seconds;
  throw new ApiError(422, "EXPIRY_NOT_ALLOWED", `This ${OPTION_NAMES[kind]} is not available`, {
    allowed,
    ...hint(entitlements, (pro) => pro.limits[kind].includes(seconds)),
  });
}

/** E7: 409 STORAGE_QUOTA_EXCEEDED { usedBytes, quotaBytes, requiredPlan? }. */
export function quotaExceeded(entitlements: Plan, usedBytes: number, requestedBytes: number): ApiError {
  return new ApiError(409, "STORAGE_QUOTA_EXCEEDED", "Not enough storage left", {
    usedBytes,
    quotaBytes: entitlements.limits.activeStorageBytes,
    ...hint(entitlements, (pro) => usedBytes + requestedBytes <= pro.limits.activeStorageBytes),
  });
}

/** E30 (D4-6, recommended): an account in its deletion grace is read-only. */
export function assertNotDeletionPending(entitlements: Entitlements): void {
  if (entitlements.deletionPending) {
    throw new ApiError(403, "ACCOUNT_DELETION_PENDING", "This account is being deleted. Cancel the deletion to share again.");
  }
}
