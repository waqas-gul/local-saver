import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BillingFromUrl, BillingPanel, CONFIRM_TIMEOUT_MS } from "@/components/billing/billing-panel";
import type { ApiClient } from "@/lib/client/api-client";
import { ApiRequestError } from "@/lib/client/api-error";
import { SessionStore } from "@/lib/client/stores/session";
import type { EntitlementsResponse } from "@/lib/shared/api/schemas";

/**
 * Plan and billing (phase 4 §17.7.6, §17.14, P4-12): what the page offers for each plan and
 * subscription state, checkout with one Idempotency-Key per button, the portal, and the return page,
 * which shows Pro only when the server says so, whatever the URL claims (B11, T4-B5).
 */

const runtimeMock = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/client/runtime", () => ({ useRuntime: () => runtimeMock.current }));
const navigateTo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client/navigate", () => ({ navigateTo }));
const search = vi.hoisted(() => ({ current: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => search.current, useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

const REF = "5a1f3c9e-2b4d-4e6f-8a0b-1c2d3e4f5a6b";
const DEVICE = { id: "d1", label: "Laptop", platform: "Windows", createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const free: EntitlementsResponse = { plan: "free", source: "account", features: { burnAfterDownload: false }, subscription: null };
const subscribed = (subscription: NonNullable<EntitlementsResponse["subscription"]>, plan: "free" | "pro" = "pro"): EntitlementsResponse => ({
  plan,
  source: plan === "pro" ? "subscription" : "account",
  features: { burnAfterDownload: plan === "pro" },
  subscription,
});
const active = subscribed({ status: "active", currentPeriodEnd: inDays(30), cancelAtPeriodEnd: false, graceUntil: null });

type Call = { method: string; path: string; body: unknown; headers?: Record<string, string> };

function fakeApi(handler: (call: Call) => unknown) {
  const calls: Call[] = [];
  const api: ApiClient = {
    request: vi.fn(async (method: string, path: string, opts?: { body?: unknown; headers?: Record<string, string> }) => {
      const call = { method, path, body: opts?.body, headers: opts?.headers };
      calls.push(call);
      const result = handler(call);
      if (result instanceof Error) throw result;
      return result;
    }) as ApiClient["request"],
  };
  return { api, calls };
}

function Ready({ anonymous, children }: { anonymous: boolean; children: ReactNode }) {
  const store = SessionStore.useStoreApi();
  const [ready] = useState(() => {
    store.getState().ready("u1", DEVICE, anonymous);
    return true;
  });
  return ready ? children : null;
}

function show(api: ApiClient, element: ReactNode, anonymous = false) {
  runtimeMock.current = { api, supabase: {} };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionStore.Provider>
        <Ready anonymous={anonymous}>{element}</Ready>
      </SessionStore.Provider>
    </QueryClientProvider>,
  );
}

const entitlementsCalls = (calls: Call[]) => calls.filter((c) => c.path === "/api/v1/me/entitlements").length;

afterEach(() => {
  vi.useRealTimers();
  navigateTo.mockReset();
  search.current = new URLSearchParams();
});

describe("plan and billing", () => {
  it("asks an anonymous browser to sign in, and starts nothing", async () => {
    const { api, calls } = fakeApi(() => free);
    show(api, <BillingPanel checkoutRef={null} />, true);
    expect(screen.getByTestId("billing-anonymous").textContent).toContain("Pro needs an account");
    expect(screen.queryByTestId("billing-subscribe-month")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("offers a Free account checkout, one Idempotency-Key per button, and navigates to the provider", async () => {
    let attempt = 0;
    const { api, calls } = fakeApi((call) => {
      if (call.path === "/api/v1/me/entitlements") return free;
      attempt += 1;
      return attempt === 1 ? new ApiRequestError(409, "CHECKOUT_IN_PROGRESS", "busy") : { url: "https://pay.example.test/c/1" };
    });
    show(api, <BillingPanel checkoutRef={null} />);
    expect((await screen.findByTestId("billing-plan")).textContent).toBe("Free");
    expect(screen.getByTestId("billing-subscribe-year").textContent).toContain("[OWNER: price]");
    expect(screen.queryByTestId("billing-portal")).toBeNull();

    fireEvent.click(screen.getByTestId("billing-subscribe-month"));
    expect((await screen.findByTestId("billing-error")).textContent).toBe("Your checkout is still being created. Try again in a moment.");
    fireEvent.click(screen.getByTestId("billing-subscribe-month"));
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("https://pay.example.test/c/1"));
    const checkouts = calls.filter((c) => c.path === "/api/v1/billing/checkout");
    expect(checkouts.map((c) => c.body)).toEqual([{ plan: "pro", interval: "month" }, { plan: "pro", interval: "month" }]);
    const keys = checkouts.map((c) => c.headers?.["Idempotency-Key"]);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it("explains a refusal: payments not available, already subscribed, deletion pending", async () => {
    for (const [code, message] of [
      ["BILLING_NOT_CONFIGURED", "Payments aren't available yet."],
      ["ALREADY_SUBSCRIBED", "This account already has a subscription. Use Manage billing to change it."],
      ["ACCOUNT_DELETION_PENDING", "This account is being deleted. Cancel the deletion to subscribe."],
    ] as const) {
      const { api } = fakeApi((call) => (call.path === "/api/v1/me/entitlements" ? free : new ApiRequestError(503, code, "x")));
      const { unmount } = show(api, <BillingPanel checkoutRef={null} />);
      fireEvent.click(await screen.findByTestId("billing-subscribe-year"));
      expect((await screen.findByTestId("billing-error")).textContent).toBe(message);
      expect(navigateTo).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("shows a subscriber their renewal and the portal, not checkout", async () => {
    const { api, calls } = fakeApi((call) => (call.path === "/api/v1/me/entitlements" ? active : { url: "https://portal.example.test/p/1" }));
    show(api, <BillingPanel checkoutRef={null} />);
    expect((await screen.findByTestId("billing-plan")).textContent).toBe("Pro");
    expect(screen.getByTestId("billing-status").textContent).toMatch(/^Renews on /);
    expect(screen.queryByTestId("billing-subscribe-month")).toBeNull();
    fireEvent.click(screen.getByTestId("billing-portal"));
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("https://portal.example.test/p/1"));
    expect(calls.find((c) => c.path === "/api/v1/billing/portal")?.body).toEqual({});
  });

  it("describes a failed payment, a cancellation and an ended subscription", async () => {
    const cases: [EntitlementsResponse, RegExp, boolean][] = [
      [subscribed({ status: "past_due", currentPeriodEnd: inDays(20), cancelAtPeriodEnd: false, graceUntil: inDays(5) }), /^Your last payment failed/, false],
      [subscribed({ status: "canceled", currentPeriodEnd: inDays(10), cancelAtPeriodEnd: true, graceUntil: null }), /^Pro ends on /, false],
      [subscribed({ status: "expired", currentPeriodEnd: inDays(-1), cancelAtPeriodEnd: false, graceUntil: null }, "free"), /isn't active/, true],
    ];
    for (const [entitlements, status, offersCheckout] of cases) {
      const { api } = fakeApi(() => entitlements);
      const { unmount } = show(api, <BillingPanel checkoutRef={null} />);
      expect((await screen.findByTestId("billing-status")).textContent).toMatch(status);
      expect(Boolean(screen.queryByTestId("billing-subscribe-month"))).toBe(offersCheckout);
      expect(screen.getByTestId("billing-portal")).toBeTruthy();
      unmount();
    }
  });

  it("says when Pro came from support, and still offers a subscription", async () => {
    const { api } = fakeApi(() => ({ ...free, plan: "pro", source: "override" }) satisfies EntitlementsResponse);
    show(api, <BillingPanel checkoutRef={null} />);
    expect(await screen.findByText("Pro was added to your account by support.")).toBeTruthy();
    expect(screen.getByTestId("billing-subscribe-month")).toBeTruthy();
  });
});

describe("the return page after a checkout (B11, T4-B5)", () => {
  it("ignores what the URL claims: Free stays Free while it waits for the server", async () => {
    search.current = new URLSearchParams(`checkout=${REF}&success=true&plan=pro&status=active`);
    const { api } = fakeApi(() => free);
    show(api, <BillingFromUrl />);
    expect(await screen.findByTestId("billing-confirming")).toBeTruthy();
    expect(screen.getByTestId("billing-plan").textContent).toBe("Free");
    expect(screen.queryByTestId("billing-confirmed")).toBeNull();
  });

  it("polls the server and shows Pro once the provider's subscription arrived", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let answers = 0;
    const { api, calls } = fakeApi(() => (++answers < 2 ? free : active));
    show(api, <BillingPanel checkoutRef={REF} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByTestId("billing-confirming")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(screen.getByTestId("billing-confirmed")).toBeTruthy();
    expect(screen.getByTestId("billing-plan").textContent).toBe("Pro");
    const polled = entitlementsCalls(calls);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(entitlementsCalls(calls)).toBe(polled); // confirmed: polling stops
  });

  it("stops after 2 minutes with a support hint naming the checkout reference", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { api, calls } = fakeApi(() => free);
    show(api, <BillingPanel checkoutRef={REF} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByTestId("billing-confirming")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS);
    });
    const still = screen.getByTestId("billing-still-confirming");
    expect(still.textContent).toContain("still confirming");
    expect(still.textContent).toContain(REF);
    expect(screen.getByTestId("billing-plan").textContent).toBe("Free");
    const polled = entitlementsCalls(calls);
    expect(polled).toBeGreaterThan(10);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(entitlementsCalls(calls)).toBe(polled);
  });

  it("never prints a reference that isn't one of ours", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { api } = fakeApi(() => free);
    show(api, <BillingPanel checkoutRef="<img src=x onerror=alert(1)>" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS + 10);
    });
    const still = screen.getByTestId("billing-still-confirming");
    expect(still.textContent).not.toContain("img");
    expect(still.querySelector("img")).toBeNull();
  });
});
