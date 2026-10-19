import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { decodeQR } from "qr/decode.js";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROOM_COPY } from "@/components/room/copy";
import { RoomLinkDialog } from "@/components/room/room-link-dialog";
import { RoomSettingsDialog } from "@/components/room/room-settings";
import { SharedView } from "@/components/share/shared-view";
import type { ApiClient } from "@/lib/client/api-client";
import type { EntitlementsResponse, LinkSummaryDto, RoomDto } from "@/lib/shared/api/schemas";

/**
 * Read-only room links (phase 4 §17.8.5, §17.14; P4-19). The owner's dialog: the DEFINED warning (03 §4.6), the plan's
 * expiries, an optional password, the new URL (and its QR code) once and only in the dialog, the links listed without
 * secrets and turned off; a downgraded owner sees the Pro hint but can still manage existing links (D4-16). The share
 * page for a room link: the room's shares, nothing about the room itself; files the link may not hand out marked;
 * burn actions and reports name their share; older shares by cursor.
 */

const runtimeMock = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/client/runtime", () => ({ useRuntime: () => runtimeMock.current }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/rooms" }));

const HOUR = 3600;
const DAY = 86_400;
const ROOM_ID = "33333333-3333-4333-8333-333333333333";
const LINK_ID = "RoomLinkRoomLink";
const SECRET = "R0om_-".repeat(7) + "x";
const URL_WITH_SECRET = `http://127.0.0.1:3102/s/${LINK_ID}#k=${SECRET}`;

afterEach(() => {
  cleanup();
  runtimeMock.current = null;
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const room: RoomDto = {
  id: ROOM_ID,
  label: "Book club",
  role: "owner",
  memberCount: 3,
  settings: { membersCanCreateLinks: true, defaultExpirySeconds: null },
  createdAt: new Date().toISOString(),
};

function entitlements(features: Partial<EntitlementsResponse["features"]>, roomLinkExpiryOptionsSeconds = [HOUR, DAY, 7 * DAY, 30 * DAY]): EntitlementsResponse {
  return {
    plan: "pro",
    features: { burnAfterDownload: true, linkPasswords: true, roomLinks: true, ...features },
    limits: {
      maxFileBytes: 1, maxFilesPerShare: 1, maxTextBytes: 1, activeStorageBytes: 1, dailyUploadBytes: 1,
      expiryOptionsSeconds: [HOUR], linkExpiryOptionsSeconds: [HOUR], shortCodeExpiryOptionsSeconds: [600],
      maxSignedInDevices: 10, maxRooms: 20, maxRoomMembers: 50, historyRetentionDays: 365, roomLinkExpiryOptionsSeconds,
    },
  };
}

function summary(id = "ListedListedLink", extra: Partial<LinkSummaryDto> = {}): LinkSummaryDto {
  return {
    id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + DAY * 1000).toISOString(), state: "active",
    shortCodeExpiresAt: null, unlockCount: 2, followsShareExpiry: false, hasPassword: false, ...extra,
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

function show(api: ApiClient, element: ReactNode) {
  runtimeMock.current = { api, supabase: {} };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  return client;
}

function decodeShown(svg: Element): string {
  const modules = Number(svg.getAttribute("viewBox")!.split(" ")[2]);
  const dark = new Set<string>();
  for (const match of svg.querySelector("path")!.getAttribute("d")!.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) dark.add(`${match[1]},${match[2]}`);
  const scale = 4;
  const width = modules * scale;
  const data = new Uint8Array(width * width * 4);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const value = dark.has(`${Math.floor(x / scale)},${Math.floor(y / scale)}`) ? 0 : 255;
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  return decodeQR({ width, height: width, data });
}

describe("the owner's room links (E22, D4-16, D4-17)", () => {
  it("warns, offers the plan's expiries and a password, and shows a new link's URL and QR once, only in the dialog", async () => {
    const { api, calls } = fakeApi((call) => {
      if (call.path.endsWith("/entitlements")) return entitlements({});
      if (call.method === "GET") return { links: [summary()] };
      return { link: { id: LINK_ID, url: URL_WITH_SECRET, createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(), shortCode: null } };
    });
    const client = show(api, <RoomLinkDialog room={room} open onOpenChange={() => {}} />);
    expect(screen.getByTestId("room-link-warning").textContent).toBe(ROOM_COPY.roomLinkWarning);
    await waitFor(() => expect(screen.getByTestId("room-link-create")).toBeDefined());
    await waitFor(() => expect(screen.getAllByTestId("room-link-row")).toHaveLength(1));
    fireEvent.change(screen.getByLabelText(ROOM_COPY.roomLinkPassword), { target: { value: "correct horse battery" } });
    await act(async () => fireEvent.click(screen.getByTestId("room-link-create")));
    expect(calls.find((c) => c.method === "POST")).toEqual({ method: "POST", path: `/api/v1/rooms/${ROOM_ID}/links`, body: { expiresIn: DAY, password: "correct horse battery" } });
    expect((screen.getByTestId("room-link-url") as HTMLInputElement).value).toBe(URL_WITH_SECRET);
    expect(decodeShown(screen.getByTestId("share-qr"))).toBe(URL_WITH_SECRET);
    expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(SECRET);
    // The listed links carry no secret or URL; one is turned off.
    expect(screen.getByTestId("room-link-row").textContent).not.toContain(SECRET);
  });

  it("turns a link off and removes its password", async () => {
    const { api, calls } = fakeApi((call) => {
      if (call.path.endsWith("/entitlements")) return entitlements({});
      if (call.method === "GET") return { links: [summary("PasswordedLink01", { hasPassword: true })] };
      return call.method === "PATCH" ? { link: summary("PasswordedLink01") } : undefined;
    });
    show(api, <RoomLinkDialog room={room} open onOpenChange={() => {}} />);
    const row = await screen.findByTestId("room-link-row");
    await act(async () => fireEvent.click(within(row).getByRole("button", { name: ROOM_COPY.roomLinkRemovePassword })));
    expect(calls).toContainEqual({ method: "PATCH", path: "/api/v1/links/PasswordedLink01", body: { password: null } });
    await act(async () => fireEvent.click(within(row).getByRole("button", { name: ROOM_COPY.roomLinkRevoke })));
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/v1/links/PasswordedLink01")).toBe(true);
  });

  it("without roomLinks (a downgraded owner) shows the Pro hint, makes nothing, and still lists existing links", async () => {
    const { api } = fakeApi((call) => (call.path.endsWith("/entitlements") ? entitlements({ roomLinks: false }, []) : { links: [summary()] }));
    show(api, <RoomLinkDialog room={room} open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("upgrade-hint").textContent).toContain(ROOM_COPY.roomLinkNotInPlan));
    expect(screen.queryByTestId("room-link-create")).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId("room-link-row")).toHaveLength(1));
  });

  it("the room's settings open them for the owner", async () => {
    const { api } = fakeApi(() => entitlements({}));
    const onRoomLinks = vi.fn();
    show(api, <RoomSettingsDialog room={room} open onOpenChange={() => {}} onDeleted={() => {}} onRoomLinks={onRoomLinks} />);
    fireEvent.click(screen.getByTestId("open-room-links"));
    expect(onRoomLinks).toHaveBeenCalled();
  });
});

describe("the share page for a room link (T4-R12)", () => {
  const now = Date.now();
  const iso = (ms: number) => new Date(now + ms).toISOString();
  const TEXT_ID = "44444444-4444-4444-8444-444444444444";
  const FILES_ID = "55555555-5555-4555-8555-555555555555";
  const BURN_ID = "66666666-6666-4666-8666-666666666666";
  const OLD_ID = "77777777-7777-4777-8777-777777777777";
  const content = {
    link: { id: LINK_ID, expiresAt: iso(DAY * 1000) },
    access: { expiresAt: iso(HOUR * 1000) },
    room: {
      shares: [
        { id: TEXT_ID, kind: "text", createdAt: iso(-1000), expiresAt: iso(DAY * 1000), text: { content: "hello from the room" }, files: [] },
        {
          id: FILES_ID, kind: "files", createdAt: iso(-2000), expiresAt: iso(DAY * 1000), text: null,
          files: [
            { id: "88888888-8888-4888-8888-888888888888", name: "notes.pdf", sizeBytes: 10, type: "application/pdf", previewable: false, riskFlags: [] },
            { id: "99999999-9999-4999-8999-999999999999", name: "setup.exe", sizeBytes: 10, type: "application/x-msdownload", previewable: false, riskFlags: ["executable"], blocked: true },
          ],
        },
        {
          id: BURN_ID, kind: "text", createdAt: iso(-3000), expiresAt: iso(DAY * 1000), text: null, files: [],
          burn: { claimed: false, byYou: false, availableUntil: null, textHidden: true, revealsLeft: null },
        },
      ],
      nextCursor: "next-page",
    },
  };
  const older = {
    ...content,
    room: { shares: [{ id: OLD_ID, kind: "text", createdAt: iso(-9000), expiresAt: iso(DAY * 1000), text: { content: "an older note" }, files: [] }], nextCursor: null },
  };

  function json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  function route(handler: (url: string, body: unknown) => Response) {
    const calls: { url: string; body: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      return handler(url, body);
    });
    return calls;
  }

  function open() {
    window.history.replaceState(null, "", `/s/${LINK_ID}#k=${SECRET}`);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SharedView linkId={LINK_ID} /></QueryClientProvider>);
  }

  it("lists the room's shares: texts, files (a blocked one can't be downloaded), burn shares hidden until revealed", async () => {
    route(() => json(200, content));
    open();
    const viewer = await screen.findByTestId("room-viewer");
    expect(screen.getAllByTestId("room-share")).toHaveLength(3);
    expect(within(viewer).getByText("hello from the room")).toBeDefined();
    expect(within(viewer).getByRole("button", { name: "Download notes.pdf" })).toHaveProperty("disabled", false);
    expect(within(viewer).getByRole("button", { name: "Download setup.exe" })).toHaveProperty("disabled", true);
    expect(within(viewer).getByTestId("file-blocked").textContent).toBe(ROOM_COPY.roomLinkFileBlocked);
    expect(within(viewer).getByTestId("burn-reveal")).toBeDefined();
    expect(viewer.textContent).not.toContain("Book club");
    expect(window.location.hash).toBe("");
  });

  it("names the share when it reveals a burn text or reports one, and loads older shares by cursor", async () => {
    const calls = route((url) => {
      if (url.endsWith("/reveal")) return json(200, { text: { content: "the secret note" }, burn: { availableUntil: iso(60_000), left: 2 } });
      if (url.includes("cursor=next-page")) return json(200, older);
      if (url.endsWith("/reports")) return json(201, { report: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } });
      return json(200, content);
    });
    open();
    await screen.findByTestId("room-viewer");
    const burnCard = screen.getAllByTestId("room-share")[2]!;
    await act(async () => fireEvent.click(within(burnCard).getByTestId("burn-reveal")));
    // The burn confirmation, then the reveal with the share named.
    await act(async () => fireEvent.click(await screen.findByTestId("burn-confirm-button")));
    await waitFor(() => expect(within(burnCard).getByText("the secret note")).toBeDefined());
    expect(calls.find((c) => c.url.endsWith("/reveal"))?.body).toEqual({ confirm: true, shareId: BURN_ID });

    await act(async () => fireEvent.click(screen.getByTestId("room-older")));
    await waitFor(() => expect(screen.getByText("an older note")).toBeDefined());
    expect(calls.some((c) => c.url === `/api/v1/links/${LINK_ID}/content?cursor=next-page`)).toBe(true);
    expect(screen.queryByTestId("room-older")).toBeNull();

    const textCard = screen.getAllByTestId("room-share")[0]!;
    fireEvent.click(within(textCard).getByRole("button", { name: "Report" }));
    const dialog = await screen.findByTestId("report-dialog");
    fireEvent.click(within(dialog).getByLabelText("Spam"));
    await act(async () => fireEvent.click(within(dialog).getByTestId("report-submit")));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith("/reports"))?.body).toMatchObject({ target: { type: "link", linkId: LINK_ID, shareId: TEXT_ID }, category: "spam" }));
  });
});
