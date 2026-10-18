import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeEntry } from "@/components/share/code-entry";
import { PASSWORD_COPY } from "@/components/share/copy";
import { PasswordField } from "@/components/share/password-field";
import { PasswordPrompt } from "@/components/share/password-prompt";
import { ShareLinkDialog } from "@/components/share/share-link-dialog";
import { SharedView } from "@/components/share/shared-view";
import type { ApiClient } from "@/lib/client/api-client";
import { ApiRequestError } from "@/lib/client/api-error";
import { ConfigProvider } from "@/lib/client/config";
import { queryKeys } from "@/lib/client/queries/keys";
import type { EntitlementsResponse, LinkSummaryDto, ShareDto } from "@/lib/shared/api/schemas";

/**
 * Link passwords in the UI (phase 4 §17.8.3, §17.14, P4-16). The creator's options appear only when the plan
 * has linkPasswords, except removal, which is always offered (D4-12). The viewer's prompt sends the password
 * once and never keeps it: cleared on submit, never in the query cache. A code for a password link leads to
 * the share page, which asks for the password; Turnstile runs only when the server asks for it.
 */

const runtimeMock = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/client/runtime", () => ({ useRuntime: () => runtimeMock.current }));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/" }));
const turnstile = vi.hoisted(() => ({ getTurnstileToken: vi.fn(async () => "pass-solved-token") }));
vi.mock("@/lib/client/turnstile", () => turnstile);

const LINK_ID = "AAAAAAAAAAAAAAAA";
const PASSWORD = "copper lantern 42";

afterEach(() => {
  runtimeMock.current = null;
  vi.restoreAllMocks();
  push.mockReset();
  turnstile.getTurnstileToken.mockClear();
  window.history.replaceState(null, "", "/");
});

const share: ShareDto = {
  id: "33333333-3333-4333-8333-333333333333",
  kind: "text",
  scope: "link_only",
  status: "active",
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 23 * 3600_000).toISOString(),
  isMine: true,
  fromLabel: "Blue Fox",
  text: { content: "hello", version: 1 },
  files: [],
  fileCount: 0,
  totalBytes: 0,
};

const limits = {
  maxFileBytes: 1,
  maxFilesPerShare: 1,
  maxTextBytes: 1,
  activeStorageBytes: 1,
  dailyUploadBytes: 1,
  expiryOptionsSeconds: [3600],
  linkExpiryOptionsSeconds: [3600],
  shortCodeExpiryOptionsSeconds: [600],
  maxSignedInDevices: 10,
  maxRooms: 0,
  maxRoomMembers: 0,
  historyRetentionDays: 30,
};
const PRO: EntitlementsResponse = { plan: "pro", features: { burnAfterDownload: true, linkPasswords: true }, limits };
const FREE: EntitlementsResponse = { plan: "free", features: { burnAfterDownload: false, linkPasswords: false }, limits };

function summary(overrides: Partial<LinkSummaryDto> = {}): LinkSummaryDto {
  return {
    id: LINK_ID,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    state: "active",
    shortCodeExpiresAt: null,
    unlockCount: 0,
    followsShareExpiry: true,
    hasPassword: false,
    ...overrides,
  };
}

type Call = { method: string; path: string; body: unknown };

function fakeApi(handler: (call: Call) => unknown) {
  const calls: Call[] = [];
  const api: ApiClient = {
    request: vi.fn(async (method: string, path: string, opts?: { body?: unknown }) => {
      const call = { method, path, body: opts?.body };
      calls.push(call);
      const result = handler(call);
      if (result instanceof Error) throw result;
      return result;
    }) as ApiClient["request"],
  };
  return { api, calls };
}

function show(element: ReactNode, api?: ApiClient) {
  if (api) runtimeMock.current = { api, supabase: {} };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(client, "invalidateQueries");
  render(
    <ConfigProvider config={{ supabaseUrl: "http://x", supabasePublishableKey: "k", turnstileSiteKey: "site-key" }}>
      <QueryClientProvider client={client}>{element}</QueryClientProvider>
    </ConfigProvider>,
  );
  return { invalidated: () => spy.mock.calls.map((call) => call[0]?.queryKey) };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const errorBody = (code: string, details?: unknown) => ({ error: { code, message: "x", requestId: "r", ...(details ? { details } : {}) } });
const refusal = (status: number, code: string, retryAfterSeconds?: number) => new ApiRequestError(status, code, "refused", "req", undefined, retryAfterSeconds);

describe("the password field (creator)", () => {
  it("states the rules and warns, without refusing, about a very common password", () => {
    const { rerender } = render(<PasswordField id="pw" label={PASSWORD_COPY.fieldLabel} value="" onChange={() => {}} />);
    const input = screen.getByLabelText(PASSWORD_COPY.fieldLabel) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("new-password");
    expect(screen.getByTestId("password-rules").textContent).toBe(PASSWORD_COPY.rules);
    expect(screen.queryByTestId("password-common")).toBeNull();
    rerender(<PasswordField id="pw" label={PASSWORD_COPY.fieldLabel} value="Password1" onChange={() => {}} />);
    expect(screen.getByTestId("password-common").textContent).toBe(PASSWORD_COPY.common);
    rerender(<PasswordField id="pw" label={PASSWORD_COPY.fieldLabel} value={PASSWORD} onChange={() => {}} />);
    expect(screen.queryByTestId("password-common")).toBeNull();
  });
});

describe("the share-link dialog's password options (E11, §17.6.5)", () => {
  it("Free: no password field and no change, but a link that has a password can still lose it (D4-12)", async () => {
    const { api, calls } = fakeApi((c) =>
      c.path.endsWith("/me/entitlements") ? FREE : c.method === "GET" ? { links: [summary({ hasPassword: true })] } : { link: summary() },
    );
    show(<ShareLinkDialog share={share} open onOpenChange={() => {}} />, api);
    const row = await screen.findByTestId("link-row");
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/me/entitlements"))).toBe(true));
    await act(async () => {});
    expect(within(row).getByText(PASSWORD_COPY.badge)).toBeDefined();
    expect(screen.queryByLabelText(PASSWORD_COPY.protect)).toBeNull();
    expect(within(row).queryByRole("button", { name: PASSWORD_COPY.change })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: PASSWORD_COPY.remove }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toEqual([{ method: "PATCH", path: `/api/v1/links/${LINK_ID}`, body: { password: null } }]));
  });

  it("Pro: protects a new link, sends the password once, then forgets it and says to send it separately", async () => {
    const created = { id: LINK_ID, url: `http://x/s/${LINK_ID}#k=${"s".repeat(43)}`, createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(), shortCode: null };
    const { api, calls } = fakeApi((c) => (c.path.endsWith("/me/entitlements") ? PRO : c.method === "GET" ? { links: [] } : { link: created }));
    show(<ShareLinkDialog share={share} open onOpenChange={() => {}} />, api);
    fireEvent.click(await screen.findByLabelText(PASSWORD_COPY.protect));
    const field = screen.getByLabelText(PASSWORD_COPY.fieldLabel) as HTMLInputElement;
    const createButton = screen.getByTestId("create-link") as HTMLButtonElement;
    fireEvent.change(field, { target: { value: "short" } });
    expect(createButton.disabled).toBe(true);
    fireEvent.change(field, { target: { value: PASSWORD } });
    expect(createButton.disabled).toBe(false);
    fireEvent.click(createButton);
    expect(await screen.findByTestId("created-link-password")).toBeDefined();
    expect(screen.getByTestId("created-link-password").textContent).toBe(PASSWORD_COPY.createdHint);
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: `/api/v1/shares/${share.id}/links`, body: { password: PASSWORD } }]);
    expect(document.body.textContent).not.toContain(PASSWORD);
    fireEvent.click(screen.getByRole("button", { name: "Create another link" }));
    expect((screen.getByLabelText(PASSWORD_COPY.protect) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByLabelText(PASSWORD_COPY.fieldLabel)).toBeNull();
  });

  it("Pro: sets or changes an existing link's password in place, and refreshes the list", async () => {
    const { api, calls } = fakeApi((c) =>
      c.path.endsWith("/me/entitlements") ? PRO : c.method === "GET" ? { links: [summary()] } : { link: summary({ hasPassword: true }) },
    );
    const { invalidated } = show(<ShareLinkDialog share={share} open onOpenChange={() => {}} />, api);
    const row = await screen.findByTestId("link-row");
    fireEvent.click(await within(row).findByRole("button", { name: PASSWORD_COPY.set }));
    fireEvent.change(within(row).getByLabelText(PASSWORD_COPY.newPasswordLabel), { target: { value: PASSWORD } });
    fireEvent.click(within(row).getByRole("button", { name: PASSWORD_COPY.save }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toEqual([{ method: "PATCH", path: `/api/v1/links/${LINK_ID}`, body: { password: PASSWORD } }]));
    await waitFor(() => expect(within(row).queryByLabelText(PASSWORD_COPY.newPasswordLabel)).toBeNull());
    expect(invalidated()).toContainEqual(queryKeys.shareLinks(share.id));
  });
});

describe("the password prompt (viewer)", () => {
  it("sends the password once, clears the field at once, and reports success", async () => {
    let release!: () => void;
    const { api, calls } = fakeApi(() => new Promise<void>((resolve) => (release = resolve)));
    const onVerified = vi.fn();
    show(<PasswordPrompt api={api} linkId={LINK_ID} onVerified={onVerified} onEnded={() => {}} />);
    const input = screen.getByLabelText(PASSWORD_COPY.label) as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: PASSWORD_COPY.submit }));
    // Cleared on submit, before the answer arrives.
    expect(input.value).toBe("");
    await act(async () => release());
    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([{ method: "POST", path: `/api/v1/links/${LINK_ID}/password`, body: { password: PASSWORD } }]);
  });

  it("explains a wrong password, a lock (with the wait) and too many attempts, never repeating the password", async () => {
    const answers = [refusal(403, "PASSWORD_INCORRECT"), refusal(423, "LINK_LOCKED", 840), refusal(429, "RATE_LIMITED", 60)];
    const { api } = fakeApi(() => answers.shift());
    show(<PasswordPrompt api={api} linkId={LINK_ID} onVerified={() => {}} onEnded={() => {}} />);
    const input = screen.getByLabelText(PASSWORD_COPY.label);
    for (const expected of [PASSWORD_COPY.incorrect, PASSWORD_COPY.locked(14), PASSWORD_COPY.limited]) {
      fireEvent.change(input, { target: { value: PASSWORD } });
      fireEvent.click(screen.getByRole("button", { name: PASSWORD_COPY.submit }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(expected));
      expect(document.body.textContent).not.toContain(PASSWORD);
    }
  });

  it("after a lock, runs the check only when asked and retries with its token", async () => {
    const answers: unknown[] = [refusal(403, "TURNSTILE_REQUIRED"), undefined];
    const { api, calls } = fakeApi(() => answers.shift());
    const onVerified = vi.fn();
    show(<PasswordPrompt api={api} linkId={LINK_ID} onVerified={onVerified} onEnded={() => {}} />);
    fireEvent.change(screen.getByLabelText(PASSWORD_COPY.label), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: PASSWORD_COPY.submit }));
    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    expect(turnstile.getTurnstileToken).toHaveBeenCalledWith("site-key");
    expect(calls.map((c) => c.body)).toEqual([{ password: PASSWORD }, { password: PASSWORD, turnstileToken: "pass-solved-token" }]);
  });

  it("hands an ended or unavailable link back to the page", async () => {
    const ended = refusal(410, "LINK_EXPIRED");
    const { api } = fakeApi(() => ended);
    const onEnded = vi.fn();
    show(<PasswordPrompt api={api} linkId={LINK_ID} onVerified={() => {}} onEnded={onEnded} />);
    fireEvent.change(screen.getByLabelText(PASSWORD_COPY.label), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: PASSWORD_COPY.submit }));
    await waitFor(() => expect(onEnded).toHaveBeenCalledWith(ended));
  });
});

describe("the share page and the code page with a password link (C4-8)", () => {
  const SECRET = "s".repeat(43);
  const content = {
    link: { id: LINK_ID, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    access: { expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    share: { kind: "text", expiresAt: new Date(Date.now() + 3600_000).toISOString(), text: { content: "behind a password" }, files: [] },
  };

  it("the unlock's 409 drops the secret and asks for the password; the right one shows the content", async () => {
    window.history.replaceState(null, "", `/s/${LINK_ID}#k=${SECRET}`);
    let verified = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/unlock")) return json(409, errorBody("PASSWORD_REQUIRED", { linkId: LINK_ID }));
      if (url.endsWith("/password")) {
        verified = true;
        return new Response(null, { status: 204 });
      }
      return verified ? json(200, content) : json(409, errorBody("PASSWORD_REQUIRED", { linkId: LINK_ID }));
    });
    show(<SharedView linkId={LINK_ID} />);
    expect(await screen.findByText(PASSWORD_COPY.promptTitle)).toBeDefined();
    expect(window.location.hash).toBe("");
    fireEvent.change(screen.getByLabelText(PASSWORD_COPY.label), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: PASSWORD_COPY.submit }));
    expect(await screen.findByText("behind a password")).toBeDefined();
    const sent = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/password"))!;
    expect(JSON.parse(String(sent[1]?.body))).toEqual({ password: PASSWORD });
    expect(screen.queryByLabelText(PASSWORD_COPY.label)).toBeNull();
  });

  it("without a secret, a grant that hasn't proved the password gets the prompt, not the content", async () => {
    window.history.replaceState(null, "", `/s/${LINK_ID}`);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(409, errorBody("PASSWORD_REQUIRED", { linkId: LINK_ID })));
    show(<SharedView linkId={LINK_ID} />);
    expect(await screen.findByText(PASSWORD_COPY.promptTitle)).toBeDefined();
    expect(screen.queryByTestId("shared-content")).toBeNull();
  });

  it("a code for a password link opens the share page, which asks for the password", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(409, errorBody("PASSWORD_REQUIRED", { linkId: LINK_ID })));
    render(<CodeEntry />);
    fireEvent.change(screen.getByTestId("code-input"), { target: { value: "7KQ4M-X9D2P" } });
    await act(async () => fireEvent.click(screen.getByTestId("code-submit")));
    expect(push).toHaveBeenCalledWith(`/s/${LINK_ID}`);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
