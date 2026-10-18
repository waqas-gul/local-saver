import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HISTORY_COPY } from "@/components/history/copy";
import { filtersFrom, historyHref, HistoryView, type HistoryFilters } from "@/components/history/history-view";
import type { ApiClient } from "@/lib/client/api-client";
import { ApiRequestError } from "@/lib/client/api-error";
import type { EntitlementsResponse, HistoryDownloadDto, HistoryShareDto } from "@/lib/shared/api/schemas";

/**
 * Transfer history (phase 4 §17.14, P4-20): shares in every state with where they were and how they ended, filters in
 * the URL, older pages by the server's cursor; downloads by actor kind and link kind, a link's ID only when it is the
 * caller's; a plan without history gets the Pro hint (E24).
 */

const runtimeMock = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/client/runtime", () => ({ useRuntime: () => runtimeMock.current }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

const SHARE_A = "11111111-1111-4111-8111-111111111111";
const SHARE_B = "22222222-2222-4222-8222-222222222222";
const ROOM = "33333333-3333-4333-8333-333333333333";
const FILE = "44444444-4444-4444-8444-444444444444";
const ALL: HistoryFilters = { view: "shares", status: null, kind: null, shareId: null };

afterEach(() => {
  cleanup();
  runtimeMock.current = null;
  vi.restoreAllMocks();
});

const entitlements = (transferHistory: boolean): EntitlementsResponse => ({
  plan: transferHistory ? "pro" : "free",
  features: { burnAfterDownload: transferHistory, transferHistory },
  limits: {
    maxFileBytes: 1, maxFilesPerShare: 1, maxTextBytes: 1, activeStorageBytes: 1, dailyUploadBytes: 1,
    expiryOptionsSeconds: [3600], linkExpiryOptionsSeconds: [3600], shortCodeExpiryOptionsSeconds: [600],
    maxSignedInDevices: 10, maxRooms: 20, maxRoomMembers: 50, historyRetentionDays: transferHistory ? 365 : 30,
  },
});

function share(id: string, extra: Partial<HistoryShareDto> = {}): HistoryShareDto {
  const now = new Date().toISOString();
  return {
    id, kind: "files", title: "report.pdf", scope: "network", status: "active", createdAt: now, expiresAt: now, endedAt: null, endReason: null,
    burnAfterDownload: false, fileCount: 2, totalBytes: 2048, ...extra,
  };
}

function download(id: string, extra: Partial<HistoryDownloadDto> = {}): HistoryDownloadDto {
  return {
    id, at: new Date().toISOString(), share: { id: SHARE_A, title: "report.pdf" }, file: { id: FILE, name: "report.pdf" }, event: "url_issued",
    actorKind: "network_device", link: null, browser: "Firefox", ...extra,
  };
}

type Call = { method: string; path: string };
function fakeApi(handler: (call: Call) => unknown) {
  const calls: Call[] = [];
  const api: ApiClient = {
    request: vi.fn(async (method: string, path: string) => {
      const call = { method, path };
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
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

describe("share history (T4-H1)", () => {
  it("shows every state with where it was and how it ended, pages by cursor, and hands filters and downloads to the URL", async () => {
    const ended = new Date(Date.now() - 3_600_000).toISOString();
    const { api, calls } = fakeApi(({ path }) => {
      if (path.endsWith("/entitlements")) return entitlements(true);
      if (path.includes("cursor=next")) return { items: [share(SHARE_B, { kind: "text", title: null, status: "expired", endReason: "expired", endedAt: ended })], nextCursor: null };
      return {
        items: [
          share(SHARE_A),
          share("55555555-5555-4555-8555-555555555555", { scope: "room", room: { id: ROOM, label: "Book club" }, status: "deleted", endReason: "deleted_by_creator", endedAt: ended }),
          share("66666666-6666-4666-8666-666666666666", { scope: "link_only", status: "consumed", endReason: "consumed", endedAt: ended, burnAfterDownload: true }),
        ],
        nextCursor: "next",
      };
    });
    const onFilters = vi.fn();
    show(api, <HistoryView filters={ALL} onFilters={onFilters} />);
    await waitFor(() => expect(screen.getAllByTestId("history-share")).toHaveLength(3));
    await waitFor(() => expect(screen.getByTestId("history").textContent).toContain(HISTORY_COPY.intro(365)));
    const rows = screen.getAllByTestId("history-share");
    expect(rows[0]?.textContent).toContain("report.pdf");
    expect(rows[0]?.textContent).toContain(`${HISTORY_COPY.scope.network} · ${HISTORY_COPY.files(2)}`);
    expect(rows[0]?.textContent).toContain("Available until");
    expect(rows[1]?.textContent).toContain(HISTORY_COPY.scope.room("Book club"));
    expect(within(rows[1] as HTMLElement).getByTestId("history-share-state").textContent).toMatch(/^Deleted by you /);
    expect(rows[2]?.textContent).toContain(HISTORY_COPY.scope.link_only);
    expect(within(rows[2] as HTMLElement).getByTestId("history-share-state").textContent).toMatch(/^Downloaded and gone /);
    expect(calls.filter((c) => c.path.startsWith("/api/v1/history/shares")).map((c) => c.path)).toEqual(["/api/v1/history/shares"]);

    await act(async () => fireEvent.click(screen.getByTestId("history-older")));
    await waitFor(() => expect(screen.getAllByTestId("history-share")).toHaveLength(4));
    expect(calls.some((c) => c.path === "/api/v1/history/shares?cursor=next")).toBe(true);
    const last = screen.getAllByTestId("history-share")[3] as HTMLElement;
    expect(last.textContent).toContain(HISTORY_COPY.untitledText);
    expect(within(last).getByTestId("history-share-state").textContent).toMatch(/^Expired /);
    expect(screen.queryByTestId("history-older")).toBeNull();

    fireEvent.click(screen.getByTestId("history-status-ended"));
    expect(onFilters).toHaveBeenLastCalledWith({ ...ALL, status: "ended" });
    fireEvent.click(screen.getByTestId("history-kind-text"));
    expect(onFilters).toHaveBeenLastCalledWith({ ...ALL, kind: "text" });
    fireEvent.click(within(rows[0] as HTMLElement).getByTestId("history-share-downloads"));
    expect(onFilters).toHaveBeenLastCalledWith({ view: "downloads", status: null, kind: null, shareId: SHARE_A });
  });

  it("asks the server for the URL's filters only", async () => {
    const { api, calls } = fakeApi(({ path }) => (path.endsWith("/entitlements") ? entitlements(true) : { items: [], nextCursor: null }));
    show(api, <HistoryView filters={{ ...ALL, status: "ended", kind: "files" }} onFilters={() => {}} />);
    await screen.findByText(HISTORY_COPY.emptyShares);
    expect(calls.map((c) => c.path)).toContain("/api/v1/history/shares?status=ended&kind=files");
    expect(screen.getByTestId("history-status-ended").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("download history (T4-H2)", () => {
  it("says what happened by actor kind and link kind, names only the caller's own link, and narrows to one share", async () => {
    const { api, calls } = fakeApi(({ path }) => {
      if (path.endsWith("/entitlements")) return entitlements(true);
      return {
        items: [
          download("5", { actorKind: "creator", browser: null }),
          download("4", { event: "preview_issued" }),
          download("3", { actorKind: "link_viewer", link: { kind: "share", id: "OwnLinkOwnLink01" } }),
          download("2", { actorKind: "link_viewer", link: { kind: "room", id: null } }),
          download("1", { event: "text_revealed", file: null, share: { id: SHARE_B, title: null }, actorKind: "room_member" }),
        ],
        nextCursor: null,
      };
    });
    const onFilters = vi.fn();
    show(api, <HistoryView filters={{ view: "downloads", status: null, kind: null, shareId: SHARE_A }} onFilters={onFilters} />);
    await waitFor(() => expect(screen.getAllByTestId("history-download")).toHaveLength(5));
    expect(calls.map((c) => c.path)).toContain(`/api/v1/history/downloads?shareId=${SHARE_A}`);
    const who = screen.getAllByTestId("history-download-who").map((n) => n.textContent?.split(" · ").slice(0, -1).join(" · "));
    expect(who).toEqual([
      HISTORY_COPY.actor.creator,
      `${HISTORY_COPY.actor.network_device} · Firefox`,
      `${HISTORY_COPY.viaShareLink} · Firefox`,
      `${HISTORY_COPY.viaRoomLink} · Firefox`,
      `${HISTORY_COPY.actor.room_member} · Firefox`,
    ]);
    const rows = screen.getAllByTestId("history-download");
    expect(rows[1]?.textContent).toContain(HISTORY_COPY.event.preview_issued);
    expect(rows[2]?.textContent).toContain(HISTORY_COPY.yourLink("OwnLinkOwnLink01"));
    expect(rows[3]?.textContent).not.toContain("Your link");
    expect(rows[4]?.textContent).toContain(`${HISTORY_COPY.event.text_revealed} · ${HISTORY_COPY.untitledText}`);

    expect(screen.getByText(HISTORY_COPY.oneShare)).toBeDefined();
    fireEvent.click(screen.getByTestId("history-all-downloads"));
    expect(onFilters).toHaveBeenLastCalledWith({ view: "downloads", status: null, kind: null, shareId: null });
    fireEvent.click(screen.getByTestId("history-tab-shares"));
    expect(onFilters).toHaveBeenLastCalledWith(ALL);
  });
});

describe("without history in the plan (E24)", () => {
  it("shows the Pro hint where Pro would help, and a plain line where it wouldn't", async () => {
    const refused = (details: unknown) => new ApiRequestError(403, "FEATURE_NOT_IN_PLAN", "Transfer history isn't available on your plan", "req", details);
    let details: unknown = { feature: "transferHistory", requiredPlan: "pro" };
    const { api } = fakeApi(({ path }) => (path.endsWith("/entitlements") ? entitlements(false) : refused(details)));
    show(api, <HistoryView filters={ALL} onFilters={() => {}} />);
    const hint = await screen.findByTestId("upgrade-hint");
    expect(hint.textContent).toContain(HISTORY_COPY.notInPlan);
    expect(within(hint).getByRole("link").getAttribute("href")).toBe("/pricing");
    expect(screen.queryByTestId("history-share")).toBeNull();
    expect(screen.getByTestId("history").textContent).toContain(HISTORY_COPY.introNoPlan);
    cleanup();

    details = { feature: "transferHistory" };
    show(api, <HistoryView filters={ALL} onFilters={() => {}} />);
    await screen.findByText(HISTORY_COPY.unavailable);
    expect(screen.queryByTestId("upgrade-hint")).toBeNull();
  });
});

describe("the URL", () => {
  it("keeps only known values, and only the shown view's filters", () => {
    expect(filtersFrom(new URLSearchParams("status=ended&kind=text"))).toEqual({ view: "shares", status: "ended", kind: "text", shareId: null });
    expect(filtersFrom(new URLSearchParams("status=open&kind=image&view=other&shareId=nope"))).toEqual(ALL);
    expect(filtersFrom(new URLSearchParams(`view=downloads&shareId=${SHARE_A}`))).toEqual({ ...ALL, view: "downloads", shareId: SHARE_A });
    expect(historyHref(ALL)).toBe("/history");
    expect(historyHref({ ...ALL, status: "active", kind: "files", shareId: SHARE_A })).toBe("/history?status=active&kind=files");
    expect(historyHref({ view: "downloads", status: "ended", kind: null, shareId: SHARE_A })).toBe(`/history?view=downloads&shareId=${SHARE_A}`);
  });
});
