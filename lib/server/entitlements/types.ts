import type { Features, Limits, PlanId } from "@/lib/shared/plans";

/**
 * Entitlement types (07 §2.1 as built, phase 4 §17.6.1). The limit and feature shapes live in
 * lib/shared/plans.ts, so the UI and the pricing page read the same keys; every key name of
 * Phases 1–3 is kept, because stored snapshots use them (C4-4).
 */

export type { FeatureName, Features, Limits, PlanId } from "@/lib/shared/plans";

export type Plan = { plan: PlanId; limits: Limits; features: Features };

/** Where the plan came from: anonymous and plain accounts are Free; Pro by subscription or override. */
export type EntitlementSource = "anonymous" | "account" | "subscription" | "override";

/** Who entitlements are resolved for: the request's principal. Never anything from the client. */
export type EntitlementSubject = { userId: string; isAnonymous: boolean };

/** The subscription shown in GET /me/entitlements (written by billing, 4C). */
export type SubscriptionSummary = {
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  graceUntil: string | null;
};

/** Effective entitlements of one request (memoized on the principal, resolve.ts). */
export type Entitlements = Plan & {
  source: EntitlementSource;
  /** Kept at the top level as well: the database reads it from stored snapshots. */
  historyRetentionDays: number;
  /** The account asked to be deleted and is in its grace: read-only (E30, D4-6). */
  deletionPending: boolean;
  subscription: SubscriptionSummary | null;
};

/**
 * What a share or link stores as its entitlement_snapshot (07 §2.3, §17.16): written once, at
 * creation; what the share or link already is follows it after any plan change. Version 1 (Phases
 * 1–3) had no `v` and fewer keys: readSnapshot fills them from the Free plan.
 */
export type Snapshot = Plan & {
  v: 2;
  source: EntitlementSource;
  historyRetentionDays: number;
  resolvedAt: string;
};
