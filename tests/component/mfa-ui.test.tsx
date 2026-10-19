import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_COPY } from "@/components/account/copy";
import type { MeResponse } from "@/lib/shared/api/schemas";

/**
 * MFA in the browser (phase 4 §17.5.9, P4-24): the account page's authenticator section (enrol with a QR code drawn
 * here, confirm with a code, remove after a fresh code) and the authenticator step the app shows before it loads for a
 * session that must confirm. Every MFA call goes to Supabase Auth (stubbed here); the app's API never sees a secret.
 */

const runtimeMock = vi.hoisted(() => ({ current: null as unknown, restartApp: vi.fn(), signOut: vi.fn(async () => {}) }));
vi.mock("@/lib/client/runtime", () => ({
  useRuntime: () => runtimeMock.current,
  restartApp: runtimeMock.restartApp,
  signOut: runtimeMock.signOut,
}));

const COPY = ACCOUNT_COPY.mfa;
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const URI = `otpauth://totp/Local%20Saver:m@example.com?secret=${SECRET}&issuer=Local%20Saver`;

afterEach(() => {
  cleanup();
  runtimeMock.current = null;
  runtimeMock.restartApp.mockClear();
  runtimeMock.signOut.mockClear();
});

const me = (enrolled: boolean): MeResponse => ({
  user: { id: "11111111-1111-4111-8111-111111111111", anonymous: false, email: "m•••@example.com", displayName: null },
  methods: ["email"],
  mfa: { enrolled, aal: enrolled ? "aal2" : "aal1" },
  plan: "free",
  deletion: null,
});

type Factor = { id: string; factor_type: string; status: string };

function fakeSupabase(factors: Factor[] = []) {
  const calls: string[] = [];
  const mfa = {
    listFactors: vi.fn(async () => {
      calls.push("listFactors");
      return { data: { all: factors, totp: factors.filter((f) => f.status === "verified"), phone: [] }, error: null };
    }),
    enroll: vi.fn(async (_params: unknown) => {
      calls.push("enroll");
      return { data: { id: "new-factor", type: "totp", totp: { qr_code: "data:image/svg+xml;x", secret: SECRET, uri: URI } }, error: null as unknown };
    }),
    challengeAndVerify: vi.fn(async (params: { factorId: string; code: string }) => {
      calls.push(`verify:${params.factorId}`);
      return { data: {}, error: null as unknown };
    }),
    unenroll: vi.fn(async (params: { factorId: string }) => {
      calls.push(`unenroll:${params.factorId}`);
      return { data: {}, error: null as unknown };
    }),
  };
  return { supabase: { auth: { mfa } }, mfa, calls };
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
  return { invalidate };
}

async function renderPanel(enrolled: boolean, factors: Factor[] = []) {
  const fake = fakeSupabase(factors);
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const { MfaPanel } = await import("@/components/account/mfa-panel");
  const { invalidate } = withQuery(<MfaPanel runtime={{ supabase: fake.supabase, api: { request: vi.fn() } } as never} me={me(enrolled)} />);
  return { ...fake, invalidate, fetchSpy };
}

const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe("the account page's authenticator section", () => {
  it("enrolling: a QR code drawn in the browser and the key; a code from the app turns it on; the app's API is never called", async () => {
    const { mfa, invalidate, fetchSpy } = await renderPanel(false);
    expect(screen.getByTestId("mfa-status").textContent).toBe(COPY.off);
    await act(async () => fireEvent.click(screen.getByTestId("mfa-setup")));
    expect(mfa.enroll).toHaveBeenCalledWith({ factorType: "totp", friendlyName: COPY.factorName, issuer: "Local Saver" });
    expect(screen.getByTestId("share-qr").getAttribute("aria-label")).toBe(COPY.qrLabel);
    expect(screen.getByTestId("mfa-key").textContent).toBe("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP");

    type("mfa-code", "123 456");
    await act(async () => fireEvent.click(screen.getByTestId("mfa-confirm")));
    expect(mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: "new-factor", code: "123456" });
    expect((await screen.findByTestId("mfa-done")).textContent).toBe(COPY.enabled);
    expect(screen.queryByTestId("mfa-key")).toBeNull();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["me", "account"] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an unfinished authenticator left from before is removed first; cancelling removes the new one", async () => {
    const { calls } = await renderPanel(false, [{ id: "stale", factor_type: "totp", status: "unverified" }]);
    await act(async () => fireEvent.click(screen.getByTestId("mfa-setup")));
    expect(calls).toEqual(["listFactors", "unenroll:stale", "enroll"]);
    await act(async () => fireEvent.click(screen.getByTestId("mfa-cancel")));
    expect(calls.at(-1)).toBe("unenroll:new-factor");
    expect(screen.getByTestId("mfa-setup")).toBeDefined();
  });

  it("a malformed code isn't sent; a wrong or expired one says so", async () => {
    const { mfa } = await renderPanel(false);
    await act(async () => fireEvent.click(screen.getByTestId("mfa-setup")));
    type("mfa-code", "12ab56");
    await act(async () => fireEvent.click(screen.getByTestId("mfa-confirm")));
    expect(mfa.challengeAndVerify).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(COPY.errors.wrongCode);

    mfa.challengeAndVerify.mockResolvedValueOnce({ data: {}, error: { code: "mfa_verification_failed" } });
    type("mfa-code", "000000");
    await act(async () => fireEvent.click(screen.getByTestId("mfa-confirm")));
    expect(screen.getByRole("alert").textContent).toBe(COPY.errors.wrongCode);
    mfa.challengeAndVerify.mockResolvedValueOnce({ data: {}, error: { code: "mfa_challenge_expired" } });
    await act(async () => fireEvent.click(screen.getByTestId("mfa-confirm")));
    expect(screen.getByRole("alert").textContent).toBe(COPY.errors.expired);
    expect(screen.queryByTestId("mfa-done")).toBeNull();
  });

  it("removing: a fresh code from the app first, then Supabase Auth removes it", async () => {
    const { calls, invalidate } = await renderPanel(true, [{ id: "f1", factor_type: "totp", status: "verified" }]);
    expect(screen.getByTestId("mfa-status").textContent).toBe(COPY.on);
    fireEvent.click(screen.getByTestId("mfa-remove"));
    type("mfa-remove-code", "654321");
    await act(async () => fireEvent.click(screen.getByTestId("mfa-remove-confirm")));
    expect(calls).toEqual(["listFactors", "verify:f1", "unenroll:f1"]);
    expect((await screen.findByTestId("mfa-removed")).textContent).toBe(COPY.removed);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["me", "account"] });
  });

  it("removing with a wrong code removes nothing", async () => {
    const { mfa, calls } = await renderPanel(true, [{ id: "f1", factor_type: "totp", status: "verified" }]);
    mfa.challengeAndVerify.mockResolvedValueOnce({ data: {}, error: { code: "mfa_verification_failed" } });
    fireEvent.click(screen.getByTestId("mfa-remove"));
    type("mfa-remove-code", "000000");
    await act(async () => fireEvent.click(screen.getByTestId("mfa-remove-confirm")));
    expect(screen.getByRole("alert").textContent).toBe(COPY.errors.wrongCode);
    expect(calls).not.toContain("unenroll:f1");
  });
});

describe("the authenticator step before the app loads", () => {
  async function renderGate(factors: Factor[] = [{ id: "f1", factor_type: "totp", status: "verified" }]) {
    const fake = fakeSupabase(factors);
    runtimeMock.current = { supabase: fake.supabase, api: { request: vi.fn() } };
    const { MfaGate } = await import("@/components/account/mfa-challenge");
    render(<MfaGate />);
    return fake;
  }

  it("a code from the app confirms this session, then the app starts again", async () => {
    const { mfa } = await renderGate();
    expect(screen.getByTestId("mfa-gate").textContent).toContain(COPY.challengeIntro);
    type("mfa-gate-code", "112233");
    await act(async () => fireEvent.click(screen.getByTestId("mfa-gate-continue")));
    expect(mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: "f1", code: "112233" });
    await waitFor(() => expect(runtimeMock.restartApp).toHaveBeenCalledTimes(1));
    expect(runtimeMock.signOut).not.toHaveBeenCalled();
  });

  it("a wrong code says so and starts nothing", async () => {
    const { mfa } = await renderGate();
    mfa.challengeAndVerify.mockResolvedValueOnce({ data: {}, error: { code: "mfa_verification_failed" } });
    type("mfa-gate-code", "000000");
    await act(async () => fireEvent.click(screen.getByTestId("mfa-gate-continue")));
    expect(screen.getByRole("alert").textContent).toBe(COPY.errors.wrongCode);
    expect(runtimeMock.restartApp).not.toHaveBeenCalled();
  });

  it("a session Supabase Auth ended can't confirm: the browser signs out; another account is a click away", async () => {
    const { mfa } = await renderGate();
    mfa.challengeAndVerify.mockResolvedValueOnce({ data: {}, error: { name: "AuthApiError", code: "session_not_found" } });
    type("mfa-gate-code", "112233");
    await act(async () => fireEvent.click(screen.getByTestId("mfa-gate-continue")));
    await waitFor(() => expect(runtimeMock.signOut).toHaveBeenCalledTimes(1));
    expect(runtimeMock.restartApp).not.toHaveBeenCalled();

    cleanup();
    await renderGate();
    await act(async () => fireEvent.click(screen.getByTestId("mfa-gate-sign-out")));
    expect(runtimeMock.signOut).toHaveBeenCalledTimes(2);
  });
});
