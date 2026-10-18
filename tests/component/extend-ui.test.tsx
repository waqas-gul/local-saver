import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXTEND_COPY } from "@/components/local/copy";
import { ExtendDialog } from "@/components/local/extend-dialog";
import { ShareCard, type ShareActions } from "@/components/local/share-card";
import { ShareList } from "@/components/local/share-list";
import type { ApiClient } from "@/lib/client/api-client";
import { ApiRequestError } from "@/lib/client/api-error";
import { queryKeys } from "@/lib/client/queries/keys";
import type { EntitlementsResponse, ShareDto } from "@/lib/shared/api/schemas";

/**
 * Extend (phase 4 §17.8.2, §17.14, P4-15): the creator's Extend action on the share card, shown only when the
 * share may be extended and the plan has extendExpiry; the dialog offers the plan's options later than the
 * share's expiry and sends only the chosen option; a copy in progress (202) and refusals say so.
 */

const runtimeMock = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/client/runtime", () => ({ useRuntime: () => runtimeMock.current }));

const HOUR = 3600;
const DAY = 86_400;

afterEach(() => {
  runtimeMock.current = null;
});

const share: ShareDto = {
  id: "22222222-2222-4222-8222-222222222222",
  kind: "text",
  scope: "network",
  status: "active",
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 23 * HOUR * 1000).toISOString(),
  isMine: true,
  fromLabel: "Blue Fox",
  text: { content: "hello", version: 1 },
  files: [],
  fileCount: 0,
  totalBytes: 0,
  expiry: { extendable: true, extensionPending: false, extensionFailed: false },
};

const actions: ShareActions = { download: async () => {}, remove: async () => {}, saveText: async () => "ok", reload: () => {} };

const PRO: EntitlementsResponse = {
  plan: "pro",
  features: { burnAfterDownload: true, extendExpiry: true },
  limits: {
    maxFileBytes: 5 * 1024 ** 3,
    maxFilesPerShare: 100,
    maxTextBytes: 1024 ** 2,
    activeStorageBytes: 100 * 1024 ** 3,
    dailyUploadBytes: 200 * 1024 ** 3,
    expiryOptionsSeconds: [HOUR, DAY, 7 * DAY, 30 * DAY, 90 * DAY],
    linkExpiryOptionsSeconds: [HOUR, DAY],
    shortCodeExpiryOptionsSeconds: [600],
    maxSignedInDevices: 10,
    maxRooms: 20,
    maxRoomMembers: 50,
    historyRetentionDays: 365,
  },
};
const FREE: EntitlementsResponse = {
  ...PRO,
  plan: "free",
  features: { burnAfterDownload: false, extendExpiry: false },
  limits: { ...PRO.limits!, expiryOptionsSeconds: [HOUR, DAY, 7 * DAY] },
};

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

function show(api: ApiClient, element: ReactNode) {
  runtimeMock.current = { api, supabase: {} };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(client, "invalidateQueries");
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  return { invalidated: () => spy.mock.calls.map((call) => call[0]?.queryKey) };
}

describe("the share card (P4-15)", () => {
  it("offers Extend to the creator when the share may be extended, and to no one else", () => {
    const onExtend = vi.fn();
    const { rerender } = render(<ShareCard share={share} actions={actions} onExtend={onExtend} />);
    fireEvent.click(screen.getByRole("button", { name: EXTEND_COPY.button }));
    expect(onExtend).toHaveBeenCalledTimes(1);
    for (const other of [
      { ...share, isMine: false, expiry: undefined },
      { ...share, expiry: { extendable: false, extensionPending: false, extensionFailed: false } },
    ]) {
      rerender(<ShareCard share={other} actions={actions} onExtend={onExtend} />);
      expect(screen.queryByRole("button", { name: EXTEND_COPY.button })).toBeNull();
    }
    // No handler (the plan doesn't have it): no button.
    rerender(<ShareCard share={share} actions={actions} />);
    expect(screen.queryByRole("button", { name: EXTEND_COPY.button })).toBeNull();
  });

  it("says when the files are being copied, and when the last extension failed", () => {
    const { rerender } = render(
      <ShareCard share={{ ...share, expiry: { extendable: false, extensionPending: true, extensionFailed: false } }} actions={actions} onExtend={() => {}} />,
    );
    expect(screen.getByTestId("extension-pending").textContent).toBe(EXTEND_COPY.pendingBadge);
    rerender(<ShareCard share={{ ...share, expiry: { extendable: true, extensionPending: false, extensionFailed: true } }} actions={actions} onExtend={() => {}} />);
    expect(screen.getByTestId("extension-failed").textContent).toBe(EXTEND_COPY.failed);
    expect(screen.queryByTestId("extension-pending")).toBeNull();
  });
});

describe("the extend dialog (P4-15)", () => {
  it("offers the plan's options that end later than the share, and sends only the chosen one", async () => {
    const { api, calls } = fakeApi((call) => (call.path.endsWith("/me/entitlements") ? PRO : { share: { ...share, expiresAt: new Date().toISOString() } }));
    const onOpenChange = vi.fn();
    const { invalidated } = show(api, <ExtendDialog share={share} open onOpenChange={onOpenChange} />);
    const group = await screen.findByRole("radiogroup", { name: EXTEND_COPY.optionsLabel });
    // 23 hours left: 1 hour would shorten it.
    expect(within(group).getAllByRole("radio").map((r) => (r as HTMLInputElement).value)).toEqual([String(DAY), String(7 * DAY), String(30 * DAY), String(90 * DAY)]);
    fireEvent.click(within(group).getByLabelText(new RegExp(EXTEND_COPY.option(30 * DAY))));
    fireEvent.click(screen.getByRole("button", { name: EXTEND_COPY.confirm }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: `/api/v1/shares/${share.id}/extend`, body: { expiresIn: 30 * DAY } }]);
    expect(invalidated()).toEqual(expect.arrayContaining([queryKeys.share(share.id), queryKeys.myShares(), queryKeys.local()]));
  });

  it("a copy in progress (202) says so and refreshes the share instead of closing", async () => {
    const { api } = fakeApi((call) => (call.path.endsWith("/me/entitlements") ? PRO : { extension: { status: "pending" } }));
    const onOpenChange = vi.fn();
    const { invalidated } = show(api, <ExtendDialog share={share} open onOpenChange={onOpenChange} />);
    await screen.findByRole("radiogroup", { name: EXTEND_COPY.optionsLabel });
    fireEvent.click(screen.getByRole("button", { name: EXTEND_COPY.confirm }));
    expect((await screen.findByTestId("extend-pending")).textContent).toBe(EXTEND_COPY.pending);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(invalidated()).toEqual(expect.arrayContaining([queryKeys.share(share.id), queryKeys.myShares()]));
  });

  it("explains refusals: already extending, not later, and the Pro hint", async () => {
    let refusal: Error = new ApiRequestError(409, "EXTENSION_PENDING", "busy");
    const { api } = fakeApi((call) => (call.path.endsWith("/me/entitlements") ? PRO : refusal));
    show(api, <ExtendDialog share={share} open onOpenChange={() => {}} />);
    await screen.findByRole("radiogroup", { name: EXTEND_COPY.optionsLabel });
    const confirm = () => fireEvent.click(screen.getByRole("button", { name: EXTEND_COPY.confirm }));
    confirm();
    expect(await screen.findByText(EXTEND_COPY.errorPending)).toBeTruthy();
    refusal = new ApiRequestError(422, "EXPIRY_NOT_ALLOWED", "later", "r", { reason: "not_later" });
    confirm();
    expect(await screen.findByText(EXTEND_COPY.errorNotLater)).toBeTruthy();
    refusal = new ApiRequestError(403, "FEATURE_NOT_IN_PLAN", "pro", "r", { feature: "extendExpiry", requiredPlan: "pro" });
    confirm();
    expect(await screen.findByText(EXTEND_COPY.errorPlan)).toBeTruthy();
    expect(await screen.findByText("This comes with Pro.")).toBeTruthy();
  });
});

describe("the share list's gate (§17.6.5)", () => {
  it("offers Extend only when the plan has it", async () => {
    for (const [entitlements, offered] of [
      [PRO, true],
      [FREE, false],
    ] as const) {
      const { api } = fakeApi(() => entitlements);
      show(api, <ShareList shares={[share]} empty="" />);
      if (offered) expect(await screen.findByRole("button", { name: EXTEND_COPY.button })).toBeTruthy();
      else {
        await waitFor(() => expect((api.request as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0));
        await act(async () => {});
        expect(screen.queryByRole("button", { name: EXTEND_COPY.button })).toBeNull();
      }
      cleanup();
    }
  });
});
