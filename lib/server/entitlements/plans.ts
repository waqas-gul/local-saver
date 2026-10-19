import "server-only";
import { deliverableLimits, FREE_FEATURES, FREE_LIMITS, PRO_FEATURES, PRO_LIMITS, type PlanId } from "@/lib/shared/plans";
import type { Plan } from "./types";

export { SINGLE_PUT_MAX_BYTES } from "@/lib/shared/plans";

/**
 * Plans (07 §1–§2, DEC-018). The numbers live in lib/shared/plans.ts so the UI can show the same
 * limits as hints; resolution (resolve.ts) picks the plan for a request.
 */

export const FREE_PLAN: Plan = { plan: "free", limits: FREE_LIMITS, features: FREE_FEATURES };
export const PRO_PLAN: Plan = { plan: "pro", limits: PRO_LIMITS, features: PRO_FEATURES };

export function planFor(id: PlanId): Plan {
  return id === "pro" ? PRO_PLAN : FREE_PLAN;
}

/**
 * What this deployment can deliver of a plan: files up to 5 GiB, above 100 MiB by multipart upload
 * (DEC-026, P4-14; the 100 MiB cap of deviation DV4-17 is lifted). Resolution applies it, so
 * /me/entitlements, enforcement and snapshots agree.
 */
export function deliverable(plan: Plan): Plan {
  const limits = deliverableLimits(plan.limits);
  return limits === plan.limits ? plan : { ...plan, limits };
}

export function isAllowedExpiry(plan: Plan, expiresInSeconds: number): boolean {
  return plan.limits.localExpiryOptionsSeconds.includes(expiresInSeconds);
}
