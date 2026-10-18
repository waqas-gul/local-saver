import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_COPY } from "@/components/account/copy";
import { DeleteAccountSection, DeletionBanner, formatDeletionDate } from "@/components/account/delete-account";
import type { ApiClient } from "@/lib/client/api-client";
import { ApiRequestError } from "@/lib/client/api-error";
import { SessionStore } from "@/lib/client/stores/session";
import type { MeResponse } from "@/lib/shared/api/schemas";

/**
 * Account deletion in the browser (phase 4 §17.5.7, P4-22): the settings section's dialog (what happens, the typed
 * confirmation, DELETE /me), the re-authentication step when the server wants a recent sign-in (a code to the account's
 * own address, then the request again), the server's refusals, and the banner with "Cancel deletion".
 */

const runtimeMock = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/client/runtime", () => ({ useRuntime: () => runtimeMock.current }));

const COPY = ACCOUNT_COPY.deletion;
const SCHEDULED = new Date(Date.now() + 7 * 86_400_000).toISOString();

afterEach(() => {
  cleanup();
  runtimeMock.current = null;
});

const me = (deletion: MeResponse["deletion"] = null): MeResponse => ({
  user: { id: "11111111-1111-4111-8111-111111111111", anonymous: false, email: "m•••@example.com", displayName: null },
  methods: ["email"],
  mfa: { enrolled: false, aal: "aal1" },
  plan: "free",
  deletion,
});

function fakeSupabase() {
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { email: "me@example.com" } } })),
      signInWithOtp: vi.fn(async () => ({ data: {}, error: null as unknown })),
      verifyOtp: vi.fn(async () => ({ data: {}, error: null as unknown })),
    },
  };
}

/** The API: GET /me answers the current state; `onDelete` and `onCancel` answer the two writes in order. */
function fakeApi(options: { pending?: string | null; onDelete?: (() => unknown)[]; onCancel?: () => unknown } = {}) {
  let pending: string | null = options.pending ?? null;
  const deletes = [...(options.onDelete ?? [() => ({ scheduledFor: SCHEDULED })])];
  const calls: { method: string; path: string; body: unknown }[] = [];
  const api: ApiClient = {
    request: vi.fn(async (method: string, path: string, opts?: { body?: unknown }) => {
      calls.push({ method, path, body: opts?.body });
      if (method === "GET" && path === "/api/v1/me") return me(pending ? { scheduledFor: pending } : null);
      if (method === "DELETE" && path === "/api/v1/me") {
        const result = (deletes.shift() ?? (() => new Error("unexpected")))();
        if (result instanceof Error) throw result;
        pending = (result as { scheduledFor: string }).scheduledFor;
        return result;
      }
      if (method === "POST" && path === "/api/v1/me/deletion/cancel") {
        const result = options.onCancel?.();
        if (result instanceof Error) throw result;
        pending = null;
        return undefined;
      }
      throw new Error(`unexpected ${method} ${path}`);
    }) as ApiClient["request"],
  };
  return { api, calls };
}

function AsAccount({ children }: { children: ReactNode }) {
  const store = SessionStore.useStoreApi();
  useState(() => store.getState().ready("11111111-1111-4111-8111-111111111111", { id: "d1", label: "Blue Fox", platform: "web" }, false));
  return children;
}

function renderWith(api: ApiClient, supabase = fakeSupabase(), children: ReactNode) {
  runtimeMock.current = { api, supabase };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SessionStore.Provider>
        <AsAccount>{children}</AsAccount>
      </SessionStore.Provider>
    </QueryClientProvider>,
  );
  return client;
}

/** The page has its account (GET /me answered) before anyone clicks. */
async function loaded(client: QueryClient) {
  await waitFor(() => expect(client.getQueryState(["me", "account"])?.status).toBe("success"));
}

function openAndConfirm() {
  fireEvent.click(screen.getByTestId("delete-account-open"));
  const submit = screen.getByTestId("delete-submit") as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByTestId("delete-confirm"), { target: { value: "delete" } });
  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByTestId("delete-confirm"), { target: { value: COPY.confirmWord } });
  expect(submit.disabled).toBe(false);
  fireEvent.click(submit);
}

describe("deleting the account", () => {
  it("says what happens, wants the typed word, then asks the server; the banner shows the date and cancels it", async () => {
    const { api, calls } = fakeApi();
    const client = renderWith(
      api,
      undefined,
      <>
        <DeletionBanner />
        <DeleteAccountSection runtime={{ api, supabase: fakeSupabase() } as never} me={me()} />
      </>,
    );
    await loaded(client);
    fireEvent.click(screen.getByTestId("delete-account-open"));
    for (const line of COPY.willHappen) expect(screen.getByText(line)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: ACCOUNT_COPY.cancel }));
    expect(screen.queryByTestId("delete-account-dialog")).toBeNull();
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);

    openAndConfirm();
    await waitFor(() => expect(screen.queryByTestId("delete-account-dialog")).toBeNull());
    // No body: the grace and the date are the server's.
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([{ method: "DELETE", path: "/api/v1/me", body: undefined }]);
    const banner = await screen.findByTestId("deletion-banner");
    expect(banner.textContent).toContain(COPY.scheduled(formatDeletionDate(SCHEDULED)));
    expect(banner.textContent).toContain(COPY.readOnly);

    fireEvent.click(screen.getByTestId("cancel-deletion"));
    await waitFor(() => expect(screen.queryByTestId("deletion-banner")).toBeNull());
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: "/api/v1/me/deletion/cancel", body: {} }]);
    expect(screen.getByTestId("deletion-cancelled").textContent).toBe(COPY.cancelled);
  });

  it("when the sign-in isn't recent: a code to the account's own address, then the request once more", async () => {
    const { api, calls } = fakeApi({
      onDelete: [() => new ApiRequestError(403, "REAUTH_REQUIRED", "again", "req"), () => ({ scheduledFor: SCHEDULED })],
    });
    const supabase = fakeSupabase();
    renderWith(api, supabase, <DeleteAccountSection runtime={{ api, supabase } as never} me={me()} />);
    openAndConfirm();
    await screen.findByTestId("delete-code");
    expect(screen.getByText(COPY.reauthIntro("me@example.com"))).toBeTruthy();
    expect(supabase.auth.signInWithOtp).toHaveBeenCalledWith({
      email: "me@example.com",
      options: expect.objectContaining({ emailRedirectTo: expect.stringMatching(/\/auth\/callback$/) }),
    });

    supabase.auth.verifyOtp.mockResolvedValueOnce({ data: {}, error: { code: "otp_expired" } });
    fireEvent.change(screen.getByTestId("delete-code"), { target: { value: "111111" } });
    fireEvent.click(screen.getByTestId("delete-verify"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(ACCOUNT_COPY.errors.wrongCode));
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);

    fireEvent.change(screen.getByTestId("delete-code"), { target: { value: "123 456" } });
    fireEvent.click(screen.getByTestId("delete-verify"));
    await waitFor(() => expect(screen.queryByTestId("delete-account-dialog")).toBeNull());
    expect(supabase.auth.verifyOtp).toHaveBeenLastCalledWith({ email: "me@example.com", token: "123456", type: "email" });
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(2);
  });

  it("shows the server's refusals; a scheduled deletion replaces the button; a due one can't be cancelled", async () => {
    const mfa = fakeApi({ onDelete: [() => new ApiRequestError(403, "MFA_REQUIRED", "mfa", "req")] });
    renderWith(mfa.api, undefined, <DeleteAccountSection runtime={{ api: mfa.api, supabase: fakeSupabase() } as never} me={me()} />);
    openAndConfirm();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(COPY.errors.mfa));
    expect(screen.getByTestId("delete-account-dialog")).toBeTruthy();
    cleanup();

    const scheduled = fakeApi({ pending: SCHEDULED });
    renderWith(scheduled.api, undefined, <DeleteAccountSection runtime={{ api: scheduled.api, supabase: fakeSupabase() } as never} me={me({ scheduledFor: SCHEDULED })} />);
    expect(screen.getByTestId("delete-account").textContent).toContain(COPY.pendingHere(formatDeletionDate(SCHEDULED)));
    expect(screen.queryByTestId("delete-account-open")).toBeNull();
    cleanup();

    const past = new Date(Date.now() - 60_000).toISOString();
    renderWith(fakeApi({ pending: past }).api, undefined, <DeletionBanner />);
    expect((await screen.findByTestId("deletion-banner")).textContent).toContain(COPY.due);
    expect(screen.queryByTestId("cancel-deletion")).toBeNull();
    cleanup();

    // The date passed while the page was open: the server refuses, and the banner says why.
    const late = fakeApi({ pending: SCHEDULED, onCancel: () => new ApiRequestError(409, "DELETION_DUE", "due", "req") });
    renderWith(late.api, undefined, <DeletionBanner />);
    fireEvent.click(await screen.findByTestId("cancel-deletion"));
    await waitFor(() => expect(screen.getByTestId("deletion-banner").textContent).toContain(COPY.errors.due));
  });
});
