import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The runtime across users (phase 4 §17.5.2, T4-A11): when another user signs in in this browser,
 * cached data of the previous one is dropped and the device is registered again; a token refresh
 * (same session) changes nothing. P4-22: a browser whose account was deleted starts again without it. P4-24: an account
 * session that must confirm with its authenticator gets the mfa phase; one that Supabase Auth ended is signed out.
 */

type Session = { access_token: string; user: { id: string; is_anonymous: boolean } };
const state = vi.hoisted(() => ({
  session: null as Session | null,
  listener: null as null | ((event: string, session: Session | null) => void),
  /** P4-22: Supabase Auth refuses the refresh token (the session is gone) and drops the session, as auth-js does. */
  refreshFails: null as null | "drops_session" | "keeps_session",
  /** The session a new anonymous sign-in gets. */
  nextAnonymous: null as Session | null,
  /** What Supabase Auth's /user says about the session's user: there, deleted, its session ended (P4-24), or unreachable. */
  user: "present" as "present" | "deleted" | "session_gone" | "unreachable",
}));

function token(sessionId: string): string {
  return `e30.${Buffer.from(JSON.stringify({ session_id: sessionId })).toString("base64url")}.sig`;
}

vi.mock("@/lib/client/supabase", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/client/supabase")>();
  const fake = {
    auth: {
      getSession: async () => ({ data: { session: state.session } }),
      refreshSession: async () => {
        if (!state.refreshFails) return { data: { session: state.session } };
        if (state.refreshFails === "drops_session") state.session = null;
        return { data: { session: null }, error: { name: "AuthApiError", code: "refresh_token_not_found" } };
      },
      getUser: async () => {
        if (state.user === "deleted") return { data: { user: null }, error: { name: "AuthApiError", status: 403, code: "user_not_found" } };
        if (state.user === "session_gone") return { data: { user: null }, error: { name: "AuthApiError", status: 403, code: "session_not_found" } };
        if (state.user === "unreachable") return { data: { user: null }, error: { name: "AuthRetryableFetchError", status: 0 } };
        return { data: { user: state.session?.user ?? null }, error: null };
      },
      signInAnonymously: async () => {
        if (state.nextAnonymous) state.session = state.nextAnonymous;
        return { data: { session: state.session }, error: null };
      },
      signOut: async () => {
        state.session = null;
        // As auth-js does: subscribers hear SIGNED_OUT (the runtime calls no Auth method inside the callback).
        state.listener?.("SIGNED_OUT", null);
        return { error: null };
      },
      onAuthStateChange: (callback: (event: string, session: Session | null) => void) => {
        state.listener = callback;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
    },
  };
  return { ...original, getSupabaseBrowserClient: () => fake };
});

afterEach(() => vi.restoreAllMocks());

describe("RuntimeProvider when the user changes (T4-A11)", () => {
  it("clears the query cache and registers the device again for the new user", async () => {
    const { AppProviders } = await import("@/lib/client/providers");
    const { ConfigProvider } = await import("@/lib/client/config");
    const { getQueryClient } = await import("@/lib/client/query-client");
    const { useSession } = await import("@/lib/client/stores/session");

    const registrations: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/v1/devices") && init?.method === "POST") {
        const user = state.session!.user.id;
        registrations.push(user);
        return new Response(JSON.stringify({ device: { id: `00000000-0000-4000-8000-00000000000${registrations.length}`, label: `Device ${user}`, platform: "" } }));
      }
      return new Response("{}", { status: 404 });
    });

    const phases: string[] = [];
    function Probe() {
      const userId = useSession((s) => s.userId);
      const anonymous = useSession((s) => s.anonymous);
      const phase = useSession((s) => s.phase);
      phases.push(phase);
      return <p data-testid="probe">{`${phase}:${userId ?? "-"}:${anonymous ? "anon" : "account"}`}</p>;
    }

    state.session = { access_token: token("session-a"), user: { id: "user-a", is_anonymous: true } };
    render(
      <ConfigProvider config={{ supabaseUrl: "http://sb", supabasePublishableKey: "pk", turnstileSiteKey: null }}>
        <AppProviders>
          <Probe />
        </AppProviders>
      </ConfigProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready:user-a:anon"));
    getQueryClient().setQueryData(["me", "shares"], { shares: [{ id: "secret-of-a" }] });

    // A token refresh keeps the session: nothing happens.
    state.listener?.("TOKEN_REFRESHED", state.session);
    state.listener?.("SIGNED_IN", state.session);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(registrations).toEqual(["user-a"]);
    expect(getQueryClient().getQueryData(["me", "shares"])).toBeDefined();

    // The same user gets a new session (an upgrade or an email change issues one): the device is
    // registered again (rebound) without resetting the page or the cache.
    phases.length = 0;
    state.session = { access_token: token("session-a2"), user: { id: "user-a", is_anonymous: false } };
    state.listener?.("USER_UPDATED", state.session);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready:user-a:account"));
    expect(registrations).toEqual(["user-a", "user-a"]);
    expect(phases).not.toContain("starting");
    expect(getQueryClient().getQueryData(["me", "shares"])).toBeDefined();

    // Another user signs in in this browser.
    state.session = { access_token: token("session-b"), user: { id: "user-b", is_anonymous: false } };
    state.listener?.("SIGNED_IN", state.session);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready:user-b:account"));
    expect(registrations).toEqual(["user-a", "user-a", "user-b"]);
    expect(getQueryClient().getQueryData(["me", "shares"])).toBeUndefined();
  });
});

describe("RuntimeProvider when the account no longer exists (P4-22)", () => {
  const unauthenticated = () =>
    new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "A valid session is required", requestId: "r" } }), { status: 401 });

  async function start(sessionUser: string, sessionId: string) {
    const { AppProviders } = await import("@/lib/client/providers");
    const { ConfigProvider } = await import("@/lib/client/config");
    const { useSession } = await import("@/lib/client/stores/session");
    function Probe() {
      const phase = useSession((s) => s.phase);
      const userId = useSession((s) => s.userId);
      const notice = useSession((s) => s.notice);
      return <p data-testid="probe">{`${phase}:${userId ?? "-"}:${notice ?? "-"}`}</p>;
    }
    state.session = { access_token: token(sessionId), user: { id: sessionUser, is_anonymous: false } };
    return render(
      <ConfigProvider config={{ supabaseUrl: "http://sb", supabasePublishableKey: "pk", turnstileSiteKey: null }}>
        <AppProviders>
          <Probe />
        </AppProviders>
      </ConfigProvider>,
    );
  }

  afterEach(() => {
    state.refreshFails = null;
    state.nextAnonymous = null;
    state.user = "present";
  });

  /** Registration refuses the dead session; a new anonymous one registers. */
  function registrationsOf(anonymousUser: string): string[] {
    const registrations: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/api/v1/devices") && init?.method === "POST") {
        const user = state.session?.user.id ?? "none";
        registrations.push(user);
        if (user !== anonymousUser) return unauthenticated();
        return new Response(JSON.stringify({ device: { id: "00000000-0000-4000-8000-0000000000e1", label: "Device e", platform: "" } }));
      }
      return new Response("{}", { status: 404 });
    });
    return registrations;
  }

  it("deleted, its access token expired: Supabase drops the session after the refused refresh; the browser starts again anonymously", async () => {
    const registrations = registrationsOf("anon-e");
    state.refreshFails = "drops_session";
    state.nextAnonymous = { access_token: token("session-e"), user: { id: "anon-e", is_anonymous: true } };
    await start("deleted-d", "session-d");
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready:anon-e:This device was signed out."));
    expect(registrations[0]).toBe("deleted-d");
    expect(registrations.at(-1)).toBe("anon-e");
  });

  it("deleted, its access token still valid: Supabase keeps the session, but Auth says the user is gone; the browser starts again", async () => {
    const registrations = registrationsOf("anon-g");
    state.refreshFails = "keeps_session";
    state.user = "deleted";
    state.nextAnonymous = { access_token: token("session-g"), user: { id: "anon-g", is_anonymous: true } };
    await start("deleted-g", "session-g0");
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready:anon-g:This device was signed out."));
    expect(registrations.at(-1)).toBe("anon-g");
  });

  it("a refresh that fails while Auth can't be reached (a passing outage) is not a sign-out", async () => {
    registrationsOf("never");
    state.refreshFails = "keeps_session";
    state.user = "unreachable";
    state.nextAnonymous = { access_token: token("session-f"), user: { id: "anon-f", is_anonymous: true } };
    await start("account-f", "session-f0");
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toMatch(/^error:/));
    expect(state.session?.user.id).toBe("account-f");
  });
  it("deleted while the app is open: the next request's device recovery finds the session gone; the browser starts again", async () => {
    const { useRuntime } = await import("@/lib/client/runtime");
    let deleted = false;
    const registrations: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const user = state.session?.user.id ?? "none";
      if (url.endsWith("/api/v1/devices") && init?.method === "POST") {
        registrations.push(user);
        if (deleted && user === "account-h") return unauthenticated();
        return new Response(JSON.stringify({ device: { id: "00000000-0000-4000-8000-0000000000a1", label: "Device", platform: "" } }));
      }
      if (url.endsWith("/api/v1/me/shares")) {
        return deleted && user === "account-h"
          ? new Response(JSON.stringify({ error: { code: "DEVICE_UNKNOWN", message: "Unknown device", requestId: "r" } }), { status: 401 })
          : new Response(JSON.stringify({ shares: [] }));
      }
      return new Response("{}", { status: 404 });
    });
    let api: { request: (method: string, path: string) => Promise<unknown> } | null = null;
    function Grab() {
      api = useRuntime()?.api ?? null;
      return null;
    }
    const { AppProviders } = await import("@/lib/client/providers");
    const { ConfigProvider } = await import("@/lib/client/config");
    const { useSession } = await import("@/lib/client/stores/session");
    function Probe() {
      const phase = useSession((s) => s.phase);
      const userId = useSession((s) => s.userId);
      return <p data-testid="probe">{`${phase}:${userId ?? "-"}`}</p>;
    }
    state.session = { access_token: token("session-h"), user: { id: "account-h", is_anonymous: false } };
    render(
      <ConfigProvider config={{ supabaseUrl: "http://sb", supabasePublishableKey: "pk", turnstileSiteKey: null }}>
        <AppProviders>
          <Grab />
          <Probe />
        </AppProviders>
      </ConfigProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready:account-h"));

    // The hourly job deletes the account.
    deleted = true;
    state.refreshFails = "keeps_session";
    state.user = "deleted";
    state.nextAnonymous = { access_token: token("session-i"), user: { id: "anon-i", is_anonymous: true } };
    await expect(api!.request("GET", "/api/v1/me/shares")).rejects.toMatchObject({ code: "DEVICE_UNKNOWN" });
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready:anon-i"));
    expect(registrations.at(-1)).toBe("anon-i");
  });
});

describe("RuntimeProvider with an authenticator (P4-24)", () => {
  const mfaRequired = () =>
    new Response(JSON.stringify({ error: { code: "MFA_REQUIRED", message: "Confirm with your authenticator app first", requestId: "r" } }), { status: 403 });

  afterEach(() => {
    state.nextAnonymous = null;
    state.user = "present";
  });

  async function start(user: string, sessionId: string) {
    const { AppProviders } = await import("@/lib/client/providers");
    const { ConfigProvider } = await import("@/lib/client/config");
    const { useSession } = await import("@/lib/client/stores/session");
    const { useRuntime } = await import("@/lib/client/runtime");
    const grabbed: { api: { request: (method: string, path: string) => Promise<unknown> } | null } = { api: null };
    function Probe() {
      grabbed.api = useRuntime()?.api ?? null;
      const phase = useSession((s) => s.phase);
      const userId = useSession((s) => s.userId);
      const notice = useSession((s) => s.notice);
      return <p data-testid="probe">{`${phase}:${userId ?? "-"}:${notice ?? "-"}`}</p>;
    }
    state.session = { access_token: token(sessionId), user: { id: user, is_anonymous: false } };
    render(
      <ConfigProvider config={{ supabaseUrl: "http://sb", supabasePublishableKey: "pk", turnstileSiteKey: null }}>
        <AppProviders>
          <Probe />
        </AppProviders>
      </ConfigProvider>,
    );
    return grabbed;
  }

  /** Registration answers MFA_REQUIRED while `refuse()` says so; anything else registers. */
  function registrations(refuse: (user: string) => boolean): string[] {
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const user = state.session?.user.id ?? "none";
      if (url.endsWith("/api/v1/devices") && init?.method === "POST") {
        seen.push(user);
        if (refuse(user)) return mfaRequired();
        return new Response(JSON.stringify({ device: { id: "00000000-0000-4000-8000-0000000000b1", label: "Device", platform: "" } }));
      }
      if (url.endsWith("/api/v1/me/shares")) return refuse(user) ? mfaRequired() : new Response(JSON.stringify({ shares: [] }));
      return new Response("{}", { status: 404 });
    });
    return seen;
  }

  it("an account session at aal1 with an authenticator: the app shows the authenticator step, not the app; confirmed, it starts", async () => {
    let confirmed = false;
    const seen = registrations(() => !confirmed);
    await start("account-m", "session-m");
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("mfa:account-m:-"));
    expect(state.session?.user.id).toBe("account-m");

    // The authenticator step confirms (Supabase Auth: the same session, now aal2), then starts the app again.
    confirmed = true;
    const { restartApp } = await import("@/lib/client/runtime");
    restartApp();
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready:account-m:-"));
    expect(seen).toEqual(["account-m", "account-m"]);
  });

  it("a session Supabase Auth ended when the account added an authenticator: it can't confirm, so the browser starts again without it", async () => {
    const seen = registrations((user) => user === "account-n");
    state.user = "session_gone";
    state.nextAnonymous = { access_token: token("session-o"), user: { id: "anon-o", is_anonymous: true } };
    await start("account-n", "session-n");
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready:anon-o:This device was signed out."));
    expect(seen[0]).toBe("account-n");
    expect(seen.at(-1)).toBe("anon-o");
    expect(seen).not.toContain("none");
  });

  it("while the app is open, a request answers MFA_REQUIRED (an authenticator was added elsewhere): the app goes to the authenticator step", async () => {
    let added = false;
    registrations(() => added);
    const grabbed = await start("account-p", "session-p");
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready:account-p:-"));
    added = true;
    await expect(grabbed.api!.request("GET", "/api/v1/me/shares")).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("mfa:account-p:-"));
  });
});
