import "server-only";
import { FREE_PLAN } from "./plans";
import type { Entitlements, Limits, Features, PlanId, Snapshot } from "./types";

/**
 * Entitlement snapshots (07 §2.3, phase 4 §17.16). A share's or link's snapshot is written once,
 * when it is created, and never rewritten: what the share or link already is (its retention, its
 * text size for edits, its daily URL cap, its preview size, its remote file policy) follows the
 * snapshot after an upgrade or downgrade. New actions follow the caller's current plan.
 */

export function snapshotFor(entitlements: Entitlements): Snapshot {
  return {
    v: 2,
    plan: entitlements.plan,
    source: entitlements.source,
    limits: entitlements.limits,
    features: entitlements.features,
    historyRetentionDays: entitlements.historyRetentionDays,
    resolvedAt: new Date().toISOString(),
  };
}

export type SnapshotView = { plan: PlanId; limits: Limits; features: Features; historyRetentionDays: number };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a stored snapshot, version 1 or 2. Keys a snapshot lacks (every Phase 4 key in a version 1
 * snapshot) take the Free plan's value, and so does a key of the wrong type: a damaged snapshot
 * never grants more than Free.
 */
export function readSnapshot(raw: unknown): SnapshotView {
  const stored = isObject(raw) ? raw : {};
  const limits = isObject(stored.limits) ? stored.limits : {};
  const features = isObject(stored.features) ? stored.features : {};
  const pick = <T extends Record<string, unknown>>(defaults: T, values: Record<string, unknown>): T => {
    const result: Record<string, unknown> = { ...defaults };
    for (const [key, fallback] of Object.entries(defaults)) {
      const value = values[key];
      if (value === undefined) continue;
      const sameKind = Array.isArray(fallback)
        ? Array.isArray(value) && value.every((v) => typeof v === "number")
        : fallback === null || typeof fallback === "number"
          ? value === null || typeof value === "number"
          : typeof value === typeof fallback;
      if (sameKind) result[key] = value;
    }
    return result as T;
  };
  const historyRetentionDays = typeof stored.historyRetentionDays === "number" ? stored.historyRetentionDays : FREE_PLAN.limits.historyRetentionDays;
  return {
    plan: stored.plan === "pro" ? "pro" : "free",
    limits: pick(FREE_PLAN.limits as unknown as Record<string, unknown>, limits) as unknown as Limits,
    features: pick(FREE_PLAN.features as unknown as Record<string, unknown>, features) as unknown as Features,
    historyRetentionDays,
  };
}
