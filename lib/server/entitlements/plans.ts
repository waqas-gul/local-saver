import "server-only";
import { FREE_LIMITS } from "@/lib/shared/plans";

/**
 * Plans and entitlements (07 §1–§2, DEC-018). Phase 1 has only the Free plan; the numbers
 * live in lib/shared/plans.ts so the UI can show the same limits as hints.
 */

export type Principal = { userId: string; isAnonymous: boolean };

export const FREE_PLAN = {
  plan: "free",
  limits: FREE_LIMITS,
  features: {
    burnAfterDownload: false,
    linkPasswords: false,
    privateRooms: false,
    customRoomNames: false,
    roomLinks: false,
    multiUseInvites: false,
    executablesInRemoteLinks: false,
    transferHistory: false,
    extendExpiry: false,
    adminControls: false,
    brandedPages: false,
  },
} as const;

export type Plan = typeof FREE_PLAN;

/** Effective entitlements, stored as a share's entitlement_snapshot (07 §2.3). */
export type Entitlements = Plan & { historyRetentionDays: number };

/** Resolved on the server for every request; never read from the client (07 §2.2). */
export function resolveEntitlements(_principal: Principal): Entitlements {
  return { ...FREE_PLAN, historyRetentionDays: FREE_PLAN.limits.historyRetentionDays };
}

export function isAllowedExpiry(plan: Plan, expiresInSeconds: number): boolean {
  return (plan.limits.localExpiryOptionsSeconds as readonly number[]).includes(expiresInSeconds);
}
