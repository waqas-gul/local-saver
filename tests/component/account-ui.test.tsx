import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMergeIntent, storeMergeIntent } from "@/lib/client/account-storage";
import type { ApiClient } from "@/lib/client/api-client";
import { ApiRequestError } from "@/lib/client/api-error";
import { completeCallback, requestCode, startGoogle, verifyCode } from "@/lib/client/sign-in";

/**
 * Accounts in the browser (phase 4 §17.5.2 … §17.5.4, §17.14): the sign-in flows with a stubbed
 * Supabase client (Google can't run locally, T4-A1d), the login page's branches, and the runtime
 * clearing cached data when the user changes (T4-A11).
 */

const runtimeMock = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/client/auth-runtime", () => ({ useAuthRuntime: () => runtimeMock.current }));
const replace = vi.fn();
vi.mock("next/navigation", () => {
  let search = "";
  let params = new URLSearchParams();
  return {
    useRouter: () => ({ replace, push: vi.fn() }),
    usePathname: () => "/login",
    // The same object until the query changes, as Next.js's hook.
    useSearchParams: () => {
      if (window.location.search !== search) {
        search = window.location.search;
        params = new URLSearchParams(search);
      }
      return params;
    },
  };
});
const navigateTo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client/navigate", () => ({ navigateTo }));

const INTENT = { intentId: "f4000000-0000-4000-8000-000000000003", secret: "s".repeat(43), expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
const MERGED = { merged: { shares: 2, links: 1, devices: 1, memberships: 0, bytes: 10 } };
const options = { redirectTo: "http://localhost/auth/callback", turnstileSiteKey: null };

function token(sessionId: string): string {
  const body = Buffer.from(JSON.stringify({ session_id: sessionId })).toString("base64url");
  return `e30.${body}.sig`;
}

type Fake = ReturnType<typeof fakeSupabase>;

function fakeSupabase(session: { anonymous: boolean } | null = { anonymous: true }) {
  const auth = {
    getSession: vi.fn(async () => ({
      data: { session: session ? { access_token: token("s1"), user: { id: "u1", is_anonymous: session.anonymous, email: session.anonymous ? null : "a@b.co" } } : null },
    })),
    updateUser: vi.fn(async () => ({ data: {}, error: null as unknown })),
    signInWithOtp: vi.fn(async () => ({ data: {}, error: null as unknown })),
    verifyOtp: vi.fn(async () => ({ data: {}, error: null as unknown })),
    linkIdentity: vi.fn(async () => ({ data: {}, error: null as unknown })),
    signInWithOAuth: vi.fn(async () => ({ data: {}, error: null as unknown })),
    exchangeCodeForSession: vi.fn(async () => ({ data: {}, error: null as unknown })),
  };
  return { auth };
}

function fakeApi(handler: (method: string, path: string, body: unknown) => unknown = () => ({})) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const api: ApiClient = {
    request: vi.fn(async (method: string, path: string, opts?: { body?: unknown }) => {
      calls.push({ method, path, body: opts?.body });
      const result = handler(method, path, opts?.body);
      if (result instanceof Error) throw result;
      return result;
    }) as ApiClient["request"],
  };
  return { api, calls };
}

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("sign-in flows (lib/client/sign-in)", () => {
  it("an anonymous browser adds the email to itself first: the upgrade keeps its user", async () => {
    const supabase = fakeSupabase();
    const { api, calls } = fakeApi();
    const result = await requestCode(supabase as never, api, " a@b.co ", "anonymous", options);
    expect(result).toEqual({ next: "code", kind: "upgrade" });
    expect(supabase.auth.updateUser).toHaveBeenCalledWith({ email: "a@b.co" }, { emailRedirectTo: options.redirectTo });
    expect(calls).toHaveLength(0);
    await verifyCode(supabase as never, api, "a@b.co", "123 456", "upgrade");
    expect(supabase.auth.verifyOtp).toHaveBeenCalledWith({ email: "a@b.co", token: "123456", type: "email_change" });
  });

  it("an email that has an account leads to the merge offer; accepting makes the intent before signing in", async () => {
    const supabase = fakeSupabase();
    supabase.auth.updateUser.mockResolvedValueOnce({ data: {}, error: { code: "email_exists" } });
    const { api, calls } = fakeApi((method, path) => (path === "/api/v1/account/merge-intents" ? INTENT : MERGED));
    expect(await requestCode(supabase as never, api, "a@b.co", "anonymous", options)).toEqual({ next: "merge_offer" });

    const accepted = await requestCode(supabase as never, api, "a@b.co", "anonymous", { ...options, mergeConfirmed: true });
    expect(accepted).toEqual({ next: "code", kind: "merge" });
    expect(calls[0]?.path).toBe("/api/v1/account/merge-intents");
    expect(readMergeIntent()?.intentId).toBe(INTENT.intentId);
    expect(supabase.auth.signInWithOtp).toHaveBeenCalledWith({ email: "a@b.co", options: { shouldCreateUser: false, emailRedirectTo: options.redirectTo } });

    const { merge } = await verifyCode(supabase as never, api, "a@b.co", "123456", "merge");
    expect(supabase.auth.verifyOtp).toHaveBeenCalledWith({ email: "a@b.co", token: "123456", type: "email" });
    expect(calls[1]).toEqual({ method: "POST", path: "/api/v1/account/merge-anonymous", body: { intentId: INTENT.intentId, secret: INTENT.secret } });
    expect(merge).toEqual({ kind: "merged", merged: MERGED.merged });
    expect(readMergeIntent()).toBeNull();
  });

  it("a merge refused at the device cap is kept for the next start; an unusable one is dropped", async () => {
    storeMergeIntent(INTENT);
    const capped = fakeApi(() => new ApiRequestError(409, "DEVICE_LIMIT", "limit"));
    expect((await verifyCode(fakeSupabase() as never, capped.api, "a@b.co", "123456", "merge")).merge).toEqual({ kind: "device_limit" });
    expect(readMergeIntent()).not.toBeNull();
    const gone = fakeApi(() => new ApiRequestError(404, "MERGE_UNAVAILABLE", "gone"));
    expect((await verifyCode(fakeSupabase() as never, gone.api, "a@b.co", "123456", "merge")).merge).toEqual({ kind: "gone", code: "MERGE_UNAVAILABLE" });
    expect(readMergeIntent()).toBeNull();
  });

  it("a merge into an account with an authenticator waits for it (P4-24): MFA_REQUIRED keeps the intent for after the step-up", async () => {
    storeMergeIntent(INTENT);
    const guarded = fakeApi(() => new ApiRequestError(403, "MFA_REQUIRED", "mfa"));
    expect((await verifyCode(fakeSupabase() as never, guarded.api, "a@b.co", "123456", "merge")).merge).toEqual({ kind: "retry" });
    expect(readMergeIntent()?.intentId).toBe(INTENT.intentId);
  });

  it("a browser with no session signs in (or up) by code", async () => {
    const supabase = fakeSupabase(null);
    const { api } = fakeApi();
    expect(await requestCode(supabase as never, api, "a@b.co", "fresh", options)).toEqual({ next: "code", kind: "signin" });
    expect(supabase.auth.signInWithOtp).toHaveBeenCalledWith({ email: "a@b.co", options: { shouldCreateUser: true, emailRedirectTo: options.redirectTo } });
    expect(supabase.auth.updateUser).not.toHaveBeenCalled();
  });

  it("refuses a malformed email or code before calling Supabase", async () => {
    const supabase = fakeSupabase();
    await expect(requestCode(supabase as never, fakeApi().api, "not-an-email", "anonymous", options)).rejects.toMatchObject({ kind: "invalid_email" });
    await expect(verifyCode(supabase as never, fakeApi().api, "a@b.co", "12ab56", "signin")).rejects.toMatchObject({ kind: "wrong_code" });
    expect(supabase.auth.updateUser).not.toHaveBeenCalled();
    expect(supabase.auth.verifyOtp).not.toHaveBeenCalled();
  });

  it("Google: linked to an anonymous browser (upgrade), signed in after the merge offer, or directly (T4-A1d)", async () => {
    const supabase = fakeSupabase();
    const { api, calls } = fakeApi(() => INTENT);
    await startGoogle(supabase as never, api, "anonymous", { redirectTo: options.redirectTo });
    expect(supabase.auth.linkIdentity).toHaveBeenCalledWith({ provider: "google", options: { redirectTo: options.redirectTo } });
    await startGoogle(supabase as never, api, "anonymous", { redirectTo: options.redirectTo, merge: true });
    expect(calls.map((c) => c.path)).toEqual(["/api/v1/account/merge-intents"]);
    expect(supabase.auth.signInWithOAuth).toHaveBeenCalledWith({ provider: "google", options: { redirectTo: options.redirectTo } });
    await startGoogle(supabase as never, api, "fresh", { redirectTo: options.redirectTo });
    expect(supabase.auth.signInWithOAuth).toHaveBeenCalledTimes(2);
  });

  it("the callback exchanges the code in this browser, offers the merge for a taken Google account, and fails safely", async () => {
    const supabase = fakeSupabase({ anonymous: false });
    storeMergeIntent(INTENT);
    const { api, calls } = fakeApi(() => MERGED);
    expect(await completeCallback(supabase as never, api, new URLSearchParams("code=abc"))).toEqual({ kind: "signed_in", merge: { kind: "merged", merged: MERGED.merged } });
    expect(supabase.auth.exchangeCodeForSession).toHaveBeenCalledWith("abc");
    expect(calls).toHaveLength(1);
    expect(await completeCallback(supabase as never, api, new URLSearchParams("error=server_error&error_code=identity_already_exists"))).toEqual({ kind: "google_merge_offer" });
    expect(await completeCallback(supabase as never, api, new URLSearchParams("error=access_denied"))).toEqual({ kind: "failed" });
    expect(await completeCallback(supabase as never, api, new URLSearchParams(""))).toEqual({ kind: "failed" });
    supabase.auth.exchangeCodeForSession.mockResolvedValueOnce({ data: {}, error: { code: "bad_code_verifier" } });
    expect(await completeCallback(supabase as never, api, new URLSearchParams("code=other-browser"))).toEqual({ kind: "failed" });
  });
});

describe("the login page (§17.5.2)", () => {
  async function renderLogin(supabase: Fake, api: ApiClient, google = false) {
    runtimeMock.current = { supabase, api };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ external: { google } })));
    const { ConfigProvider } = await import("@/lib/client/config");
    const { LoginForm } = await import("@/components/account/login-form");
    render(
      <ConfigProvider config={{ supabaseUrl: "http://sb", supabasePublishableKey: "pk", turnstileSiteKey: null }}>
        <LoginForm />
      </ConfigProvider>,
    );
    await screen.findByTestId("login-email");
  }

  it("walks an anonymous browser through the merge offer to the code, then into the app", async () => {
    const supabase = fakeSupabase();
    supabase.auth.updateUser.mockResolvedValueOnce({ data: {}, error: { code: "email_exists" } });
    const { api } = fakeApi((method, path) => (path === "/api/v1/account/merge-intents" ? INTENT : MERGED));
    await renderLogin(supabase, api);
    expect(screen.getByText(/keeps what you've shared from this browser/)).toBeDefined();
    fireEvent.change(screen.getByTestId("login-email"), { target: { value: "a@b.co" } });
    await act(async () => fireEvent.click(screen.getByTestId("login-send")));
    expect(await screen.findByTestId("merge-offer")).toBeDefined();
    await act(async () => fireEvent.click(screen.getByTestId("merge-continue")));
    expect(await screen.findByTestId("code-sent")).toBeDefined();
    fireEvent.change(screen.getByTestId("login-code"), { target: { value: "123456" } });
    await act(async () => fireEvent.click(screen.getByTestId("login-verify")));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });

  it("shows Google only when the Supabase project offers it, and a wrong code as an error", async () => {
    const supabase = fakeSupabase(null);
    supabase.auth.verifyOtp.mockResolvedValueOnce({ data: {}, error: { code: "otp_expired" } });
    await renderLogin(supabase, fakeApi().api, true);
    expect(await screen.findByTestId("google-sign-in")).toBeDefined();
    fireEvent.change(screen.getByTestId("login-email"), { target: { value: "a@b.co" } });
    await act(async () => fireEvent.click(screen.getByTestId("login-send")));
    fireEvent.change(await screen.findByTestId("login-code"), { target: { value: "000000" } });
    await act(async () => fireEvent.click(screen.getByTestId("login-verify")));
    expect((await screen.findByTestId("login-error")).textContent).toMatch(/isn't right or has expired/);
  });

  it("tells a signed-in account it is signed in, without offering to sign in again", async () => {
    runtimeMock.current = { supabase: fakeSupabase({ anonymous: false }), api: fakeApi().api };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const { ConfigProvider } = await import("@/lib/client/config");
    const { LoginForm } = await import("@/components/account/login-form");
    render(
      <ConfigProvider config={{ supabaseUrl: "http://sb", supabasePublishableKey: "pk", turnstileSiteKey: null }}>
        <LoginForm />
      </ConfigProvider>,
    );
    expect((await screen.findByTestId("login-signed-in")).textContent).toContain("a@b.co");
    expect(screen.queryByTestId("login-email")).toBeNull();
  });
});

describe("the email's link and resending (P4-23)", () => {
  const VERIFY = "http://sb/auth/v1/verify?token=pkce_abc&type=magiclink&redirect_to=http://localhost/auth/callback";
  const CONFIG = { supabaseUrl: "http://sb", supabasePublishableKey: "pk", turnstileSiteKey: null };

  beforeEach(() => navigateTo.mockClear());
  afterEach(() => window.history.replaceState(null, "", "/"));

  async function renderCallback(hash: string) {
    window.history.replaceState(null, "", `/auth/callback${hash}`);
    const supabase = fakeSupabase(null);
    runtimeMock.current = { supabase, api: fakeApi().api };
    const { ConfigProvider } = await import("@/lib/client/config");
    const { AuthCallback } = await import("@/components/account/auth-callback");
    render(
      <ConfigProvider config={CONFIG}>
        <AuthCallback />
      </ConfigProvider>,
    );
    return supabase;
  }

  it("the link opens the callback with Supabase's link in the fragment: nothing is used until the person continues", async () => {
    // A mail scanner opens links but doesn't press buttons, so the token (and the code with it) survives it.
    const supabase = await renderCallback(`#confirm=${encodeURIComponent(VERIFY)}`);
    const button = await screen.findByTestId("callback-continue");
    expect(supabase.auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(supabase.auth.getSession).not.toHaveBeenCalled();
    expect(navigateTo).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(navigateTo).toHaveBeenCalledWith(VERIFY);
  });

  it.each([
    "https://evil.example/auth/v1/verify?token=x&type=magiclink",
    "http://sb/auth/v1/authorize?provider=google&token=x",
    "http://sb/auth/v1/verify?type=magiclink",
    "http://sb.evil.example/auth/v1/verify?token=x",
    "javascript:alert(1)//http://sb/auth/v1/verify",
    "/auth/v1/verify?token=x",
    "",
  ])("follows only Supabase's own verify endpoint, never another address: %j is refused", async (target) => {
    await renderCallback(`#confirm=${encodeURIComponent(target)}`);
    expect(await screen.findByTestId("callback-failed")).toBeDefined();
    expect(screen.queryByTestId("callback-continue")).toBeNull();
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("holds \"Send a new code\" for 60 seconds after each code, as Supabase does (max_frequency)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const supabase = fakeSupabase(null);
      runtimeMock.current = { supabase, api: fakeApi().api };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
      const { ConfigProvider } = await import("@/lib/client/config");
      const { LoginForm } = await import("@/components/account/login-form");
      render(
        <ConfigProvider config={CONFIG}>
          <LoginForm />
        </ConfigProvider>,
      );
      fireEvent.change(await screen.findByTestId("login-email"), { target: { value: "a@b.co" } });
      await act(async () => fireEvent.click(screen.getByTestId("login-send")));
      const resend = (await screen.findByTestId("login-resend")) as HTMLButtonElement;
      expect(resend.disabled).toBe(true);
      expect(resend.textContent).toBe("Send a new code in 60 s");

      await act(async () => vi.advanceTimersByTime(59_000));
      expect(resend.disabled).toBe(true);
      expect(resend.textContent).toBe("Send a new code in 1 s");
      await act(async () => vi.advanceTimersByTime(1_000));
      expect(resend.disabled).toBe(false);
      expect(resend.textContent).toBe("Send a new code");

      await act(async () => fireEvent.click(resend));
      expect(supabase.auth.signInWithOtp).toHaveBeenCalledTimes(2);
      expect(resend.disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
