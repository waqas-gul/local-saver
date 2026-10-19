import "server-only";
import { sql } from "kysely";
import { FREE_FEATURES } from "@/lib/shared/plans";
import { getDb } from "../db/client";
import { log } from "../log";
import { deliverable, FREE_PLAN, PRO_PLAN } from "./plans";
import type { EntitlementSource, Entitlements, EntitlementSubject, Plan, SubscriptionSummary } from "./types";

/**
 * Entitlement resolution (07 §2.2, phase 4 §17.6.2): on the server, for the request's principal,
 * never from the client, a JWT claim or a redirect parameter.
 *
 *   anonymous                 → Free (source "anonymous"); no database read, no overrides
 *   an entitling subscription → Pro (source "subscription"), else Free (source "account")
 *   overrides                 → the plan first (source "override"), then whitelisted limits and
 *                               features; permanent users only (app.entitlement_state)
 *   deliverable()             → what this deployment can deliver (files ≤ 5 GiB, multipart above 100 MiB)
 *
 * Kill switches (burn) apply after this, where the feature is used (shares/burn.ts). Asynchronous
 * and memoized per request: the principal object is created once per request (requireCaller,
 * requirePrincipal), so it keys the memo and every check in one request sees the same plan.
 */

export type OverrideRow = { key: string; value: unknown };

export type EntitlementState = {
  subscription: SubscriptionSummary | null;
  /** A subscription grants Pro right now (decided by the database's clock). */
  entitled: boolean;
  /** Unrevoked, unexpired overrides, oldest first. */
  overrides: OverrideRow[];
  deletionPending: boolean;
};

export const NO_STATE: EntitlementState = { subscription: null, entitled: false, overrides: [], deletionPending: false };

/** Limits an override may change (§17.6.2 whitelist; the table's check constraint is the backstop). */
const OVERRIDABLE_LIMITS = new Set(["activeStorageBytes", "dailyUploadBytes", "maxFileBytes", "historyRetentionDays"]);
const MAX_RETENTION_DAYS = 36_500;

type StateRow = {
  subscription: { status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; graceUntil: string | null } | null;
  entitled: boolean;
  overrides: OverrideRow[];
  deletion_pending: boolean;
};

const iso = (value: string | null) => (value === null ? null : new Date(value).toISOString());

export async function loadEntitlementState(userId: string): Promise<EntitlementState> {
  const { rows } = await sql<StateRow>`
    select subscription, entitled, overrides, deletion_pending from app.entitlement_state(${userId}::uuid)
  `.execute(getDb());
  const row = rows[0];
  if (!row) return NO_STATE;
  const sub = row.subscription;
  return {
    subscription: sub
      ? { status: sub.status, currentPeriodEnd: iso(sub.currentPeriodEnd), cancelAtPeriodEnd: sub.cancelAtPeriodEnd, graceUntil: iso(sub.graceUntil) }
      : null,
    entitled: row.entitled === true,
    overrides: Array.isArray(row.overrides) ? row.overrides : [],
    deletionPending: row.deletion_pending === true,
  };
}

function validLimit(key: string, value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && (key !== "historyRetentionDays" || value <= MAX_RETENTION_DAYS);
}

/** The plan and source after subscriptions and overrides. Pure: unit-tested with every input. */
export function computeEntitlements(subject: EntitlementSubject, state: EntitlementState): Entitlements {
  if (subject.isAnonymous) {
    return { ...FREE_PLAN, source: "anonymous", historyRetentionDays: FREE_PLAN.limits.historyRetentionDays, deletionPending: false, subscription: null };
  }
  let base: Plan = state.entitled ? PRO_PLAN : FREE_PLAN;
  let source: EntitlementSource = state.entitled ? "subscription" : "account";
  // The plan first: a later plan override wins over an earlier one.
  for (const override of state.overrides) {
    if (override.key !== "plan") continue;
    if (override.value === "pro" || override.value === "free") {
      base = override.value === "pro" ? PRO_PLAN : FREE_PLAN;
      source = "override";
    } else {
      log.warn("entitlements.override_ignored", { key: override.key });
    }
  }
  const limits = { ...base.limits };
  const features = { ...base.features };
  for (const override of state.overrides) {
    const [scope, name] = override.key.split(".", 2) as [string, string | undefined];
    if (scope === "limits" && name && OVERRIDABLE_LIMITS.has(name) && validLimit(name, override.value)) {
      (limits as Record<string, unknown>)[name] = override.value;
    } else if (scope === "features" && name && name in FREE_FEATURES && typeof override.value === "boolean") {
      (features as Record<string, unknown>)[name] = override.value;
    } else if (override.key !== "plan") {
      log.warn("entitlements.override_ignored", { key: override.key });
    }
  }
  const plan = deliverable({ plan: base.plan, limits, features });
  return {
    ...plan,
    source,
    historyRetentionDays: plan.limits.historyRetentionDays,
    deletionPending: state.deletionPending,
    subscription: state.subscription,
  };
}

const memo = new WeakMap<EntitlementSubject, Promise<Entitlements>>();

type LoadState = (userId: string) => Promise<EntitlementState>;

async function resolve(subject: EntitlementSubject, load: LoadState): Promise<Entitlements> {
  // Anonymous users can't subscribe or hold overrides: no database read for them.
  const state = subject.isAnonymous ? NO_STATE : await load(subject.userId);
  return computeEntitlements(subject, state);
}

/** `load` is the database read; tests pass their own. */
export function resolveEntitlements(subject: EntitlementSubject, load: LoadState = loadEntitlementState): Promise<Entitlements> {
  let pending = memo.get(subject);
  if (!pending) {
    pending = resolve(subject, load);
    memo.set(subject, pending);
    // A failure isn't cached: the request fails, and nothing else uses this object.
    pending.catch(() => memo.delete(subject));
  }
  return pending;
}
