"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BootState } from "@/components/local/boot-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ApiRequestError } from "@/lib/client/api-error";
import { navigateTo } from "@/lib/client/navigate";
import { entitlementsQuery } from "@/lib/client/queries/entitlements";
import { useRuntime } from "@/lib/client/runtime";
import { useSession } from "@/lib/client/stores/session";
import { checkoutResponse, portalResponse, type EntitlementsResponse } from "@/lib/shared/api/schemas";
import { PRICING } from "@/lib/shared/plans";
import { BILLING_COPY } from "./copy";

/**
 * Plan and billing (phase 4 §17.7.6, §17.14, P4-12): the current plan, hosted checkout for a Free
 * account and the provider's portal for a subscriber. Everything shown comes from GET /me/entitlements,
 * which the server resolves from the provider-confirmed subscription.
 *
 * After checkout the provider sends the browser back with ?checkout=<ref>. That parameter only puts
 * this page into its "confirming" view: it polls /me/entitlements for up to 2 minutes and changes
 * nothing itself (B11). No parameter, local state or redirect can show Pro the server didn't resolve.
 */

const POLL_MS = 2_500;
export const CONFIRM_TIMEOUT_MS = 120_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Subscription = NonNullable<EntitlementsResponse["subscription"]>;
type Interval = "month" | "year";

const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "";

/** A subscription that still grants Pro, by the same rules as the server (07 §6.3). */
function entitles(sub: Subscription | null | undefined, now: number): boolean {
  if (!sub) return false;
  if (sub.status === "active" || sub.status === "trialing") return true;
  if (sub.status === "past_due") return sub.graceUntil !== null && Date.parse(sub.graceUntil) > now;
  if (sub.status === "canceled") return sub.currentPeriodEnd !== null && Date.parse(sub.currentPeriodEnd) > now;
  return false;
}

function statusLine(sub: Subscription): string {
  if (sub.status === "past_due") return BILLING_COPY.pastDue(formatDate(sub.graceUntil));
  if (sub.status === "canceled" || sub.cancelAtPeriodEnd) return BILLING_COPY.endsOn(formatDate(sub.currentPeriodEnd));
  if (sub.status === "active" || sub.status === "trialing") return BILLING_COPY.renewsOn(formatDate(sub.currentPeriodEnd));
  return BILLING_COPY.pausedOrEnded;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return BILLING_COPY.errors.generic;
  switch (error.code) {
    case "BILLING_NOT_CONFIGURED":
      return BILLING_COPY.errors.notConfigured;
    case "ALREADY_SUBSCRIBED":
      return BILLING_COPY.errors.alreadySubscribed;
    case "ACCOUNT_DELETION_PENDING":
      return BILLING_COPY.errors.deletionPending;
    case "CHECKOUT_IN_PROGRESS":
      return BILLING_COPY.errors.inProgress;
    case "BILLING_PROVIDER_ERROR":
      return BILLING_COPY.errors.provider;
    case "RATE_LIMITED":
      return BILLING_COPY.errors.rateLimited;
    default:
      return BILLING_COPY.errors.generic;
  }
}

function price(interval: Interval): string {
  const value = interval === "month" ? PRICING.pro.monthly : PRICING.pro.yearly;
  if (!value) return BILLING_COPY.pricePlaceholder;
  return interval === "month" ? BILLING_COPY.perMonth(value) : BILLING_COPY.perYear(value);
}

function Billing({ checkoutRef }: { checkoutRef: string | null }) {
  const runtime = useRuntime();
  const anonymous = useSession((s) => s.anonymous);
  const confirming = checkoutRef !== null;
  const [timedOut, setTimedOut] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One key per button for this page view: a double click starts one checkout, not two.
  const keys = useRef<Record<Interval, string> | null>(null);

  const entitlements = useQuery({
    ...entitlementsQuery(runtime?.api ?? null),
    enabled: Boolean(runtime) && !anonymous,
    refetchInterval: (query) => {
      const data = query.state.data as EntitlementsResponse | undefined;
      return confirming && !timedOut && !entitles(data?.subscription, Date.now()) ? POLL_MS : false;
    },
  });

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setTimedOut(true), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [confirming]);

  if (anonymous) {
    return (
      <Card>
        <CardContent className="space-y-3" data-testid="billing-anonymous">
          <p className="text-sm">{BILLING_COPY.anonymousBilling}</p>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/login">{BILLING_COPY.signIn}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/pricing">{BILLING_COPY.seePricing}</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }
  if (!runtime || !entitlements.data) {
    return entitlements.error ? (
      <p className="text-sm text-destructive">{BILLING_COPY.errors.generic}</p>
    ) : (
      <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
    );
  }

  const data = entitlements.data;
  const sub = data.subscription ?? null;
  // As of the answer: the server resolved it then (render stays pure).
  const subscribed = entitles(sub, entitlements.dataUpdatedAt);

  const checkout = async (interval: Interval) => {
    keys.current ??= { month: crypto.randomUUID(), year: crypto.randomUUID() };
    setBusy(interval);
    setError(null);
    try {
      const { url } = await runtime.api.request("POST", "/api/v1/billing/checkout", {
        body: { plan: "pro", interval },
        headers: { "Idempotency-Key": keys.current[interval] },
        schema: checkoutResponse,
      });
      navigateTo(url);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  };

  const portal = async () => {
    setBusy("portal");
    setError(null);
    try {
      const { url } = await runtime.api.request("POST", "/api/v1/billing/portal", { body: {}, schema: portalResponse });
      navigateTo(url);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      {confirming && (
        <Card>
          <CardContent className="space-y-1" role="status">
            {subscribed ? (
              <p className="text-sm font-medium" data-testid="billing-confirmed">
                {BILLING_COPY.confirmed}
              </p>
            ) : timedOut ? (
              <p className="text-sm" data-testid="billing-still-confirming">
                {BILLING_COPY.stillConfirming}
                {UUID.test(checkoutRef) && <span className="mt-1 block font-mono text-xs text-muted-foreground">{checkoutRef}</span>}
              </p>
            ) : (
              <>
                <p className="text-sm font-medium" data-testid="billing-confirming">
                  {BILLING_COPY.confirming}
                </p>
                <p className="text-xs text-muted-foreground">{BILLING_COPY.confirmingHint}</p>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-4" data-testid="billing-panel">
          <section className="space-y-1">
            <h2 className="text-sm font-medium">{BILLING_COPY.currentPlan}</h2>
            <p className="text-lg font-medium" data-testid="billing-plan">
              {BILLING_COPY.planNames[data.plan] ?? data.plan}
            </p>
            {sub && (
              <p className="text-sm text-muted-foreground" data-testid="billing-status">
                {statusLine(sub)}
              </p>
            )}
            {data.source === "override" && <p className="text-sm text-muted-foreground">{BILLING_COPY.sourceOverride}</p>}
          </section>

          {!subscribed && (
            <section className="flex flex-col gap-2 sm:flex-row">
              {(["month", "year"] as const).map((interval) => (
                <Button
                  key={interval}
                  onClick={() => void checkout(interval)}
                  disabled={busy !== null}
                  data-testid={`billing-subscribe-${interval}`}
                  className="h-auto flex-col items-start py-2 sm:flex-1"
                >
                  <span>{interval === "month" ? BILLING_COPY.subscribeMonthly : BILLING_COPY.subscribeYearly}</span>
                  <span className="text-xs font-normal opacity-80">{price(interval)}</span>
                </Button>
              ))}
            </section>
          )}

          {sub && (
            <section className="space-y-2">
              <p className="text-xs text-muted-foreground">{BILLING_COPY.manageHint}</p>
              <Button variant="outline" onClick={() => void portal()} disabled={busy !== null} data-testid="billing-portal">
                {BILLING_COPY.manageBilling}
              </Button>
            </section>
          )}

          {error && (
            <p className="text-sm text-destructive" role="alert" data-testid="billing-error">
              {error}
            </p>
          )}
          <Link href="/pricing" className="block text-sm underline underline-offset-2">
            {BILLING_COPY.seePricing}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

export function BillingPanel({ checkoutRef }: { checkoutRef: string | null }) {
  return (
    <BootState>
      <Billing checkoutRef={checkoutRef} />
    </BootState>
  );
}

/** The page's panel, told only whether the provider sent the browser back from a checkout. */
export function BillingFromUrl() {
  const params = useSearchParams();
  return <BillingPanel checkoutRef={params.get("checkout")} />;
}
