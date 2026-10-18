import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/local/app-shell";
import { Composer } from "@/components/local/composer";
import { ShareCard, type ShareActions } from "@/components/local/share-card";
import { ShareList } from "@/components/local/share-list";
import { ROOM_COPY } from "@/components/room/copy";
import { CreateRoomDialog } from "@/components/room/create-room-dialog";
import { InviteAccept } from "@/components/room/invite-accept";
import { InviteDialog } from "@/components/room/invite-dialog";
import { MemberList } from "@/components/room/member-list";
import { RoomSettingsDialog } from "@/components/room/room-settings";
import type { ApiClient } from "@/lib/client/api-client";
import { ApiRequestError } from "@/lib/client/api-error";
import { SessionStore, UploadsStore } from "@/lib/client/stores/session";
import { UiStoreProvider } from "@/lib/client/stores/ui-store";
import type { EntitlementsResponse, RoomDto, RoomMemberDto, ShareDto } from "@/lib/shared/api/schemas";

/**
 * Private rooms UI (phase 4 §17.14, P4-17): the composer's room destination, room shares on cards and lists, creating a
 * room, invite links (the URL with its secret shown once, in component state only), members, the owner's settings,
 * and the join page (the fragment read once and stripped; nothing is joined before the person confirms).
 */

const runtimeMock = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/client/runtime", () => ({ useRuntime: () => runtimeMock.current }));
const push = vi.fn();
const pathname = vi.hoisted(() => ({ current: "/rooms" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => pathname.current }));

const HOUR = 3600;
const DAY = 86_400;
const ROOM_ID = "33333333-3333-4333-8333-333333333333";
const SECRET = "s".repeat(43);

afterEach(() => {
  cleanup();
  runtimeMock.current = null;
  push.mockReset();
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

const share: ShareDto = {
  id: "22222222-2222-4222-8222-222222222222",
  kind: "text",
  scope: "room",
  status: "active",
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 23 * HOUR * 1000).toISOString(),
  isMine: false,
  fromLabel: "Blue Fox",
  text: { content: "hello room", version: 1 },
  files: [],
  fileCount: 0,
  totalBytes: 0,
  room: { id: ROOM_ID, label: "Book club" },
};

const actions: ShareActions = { download: async () => {}, remove: async () => {}, saveText: async () => "ok", reload: () => {} };

function entitlements(features: Partial<EntitlementsResponse["features"]>): EntitlementsResponse {
  return {
    plan: "pro",
    features: { burnAfterDownload: false, privateRooms: true, customRoomNames: true, multiUseInvites: true, ...features },
    limits: {
      maxFileBytes: 100 * 1024 ** 2,
      maxFilesPerShare: 20,
      maxTextBytes: 100 * 1024,
      activeStorageBytes: 2 * 1024 ** 3,
      dailyUploadBytes: 2 * 1024 ** 3,
      expiryOptionsSeconds: [HOUR, DAY, 7 * DAY],
      linkExpiryOptionsSeconds: [HOUR, DAY],
      shortCodeExpiryOptionsSeconds: [600],
      maxSignedInDevices: 10,
      maxRooms: 20,
      maxRoomMembers: 50,
      historyRetentionDays: 365,
    },
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

function show(api: ApiClient | null, element: ReactNode) {
  runtimeMock.current = api ? { api, supabase: {} } : null;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  return client;
}

/** The session the app's bootstrap would have made. */
function Ready({ children }: { children: ReactNode }) {
  const store = SessionStore.useStoreApi();
  useState(() => store.getState().ready("44444444-4444-4444-8444-444444444444", { id: "55555555-5555-4555-8555-555555555555", label: "Blue Fox", platform: "" }));
  return <>{children}</>;
}

describe("the composer in a room (E23)", () => {
  it("posts to that room only, says who sees it, and preselects the room's default expiry", async () => {
    const { api, calls } = fakeApi((call) => (call.path === "/api/v1/texts" ? { share } : entitlements({})));
    show(
      api,
      <UiStoreProvider>
        <UploadsStore.Provider>
          <Composer room={{ id: ROOM_ID, label: "Book club", defaultExpirySeconds: HOUR }} />
        </UploadsStore.Provider>
      </UiStoreProvider>,
    );
    expect(screen.queryByTestId("composer-destination")).toBeNull();
    expect(screen.getByTestId("audience-line").textContent).toBe(ROOM_COPY.audience("Book club"));
    expect(screen.getByTestId("composer-submit").textContent).toBe(ROOM_COPY.shareToRoom);
    fireEvent.change(screen.getByTestId("composer-text"), { target: { value: "for the room" } });
    await act(async () => fireEvent.click(screen.getByTestId("composer-submit")));
    expect(calls.find((c) => c.path === "/api/v1/texts")?.body).toEqual({ destination: { room: ROOM_ID }, content: "for the room", expiresIn: HOUR });
  });
});

describe("room shares on cards and lists (§17.11.1)", () => {
  it("names the room outside it, not on its own page", () => {
    const { rerender } = render(<ShareCard share={share} actions={actions} />);
    expect(screen.getByTestId("room-badge").textContent).toBe(ROOM_COPY.roomBadge("Book club"));
    rerender(<ShareCard share={share} actions={actions} showRoom={false} />);
    expect(screen.queryByTestId("room-badge")).toBeNull();
  });

  it("lets the room's owner delete anyone's share, and a member only their own", () => {
    const { api } = fakeApi(() => entitlements({}));
    show(api, <ShareList shares={[share]} empty="none" room={room} />);
    expect(screen.getByRole("button", { name: /delete/i })).toBeDefined();
    cleanup();
    show(api, <ShareList shares={[share]} empty="none" room={{ ...room, role: "member" }} />);
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });

  it("offers a member a link to their own share only while the room allows it; the owner always", () => {
    const mine = { ...share, isMine: true };
    const { api } = fakeApi(() => entitlements({}));
    show(api, <ShareList shares={[mine]} empty="none" room={{ ...room, role: "member", settings: { ...room.settings, membersCanCreateLinks: false } }} />);
    expect(screen.queryByRole("button", { name: /share link/i })).toBeNull();
    cleanup();
    show(api, <ShareList shares={[mine]} empty="none" room={{ ...room, settings: { ...room.settings, membersCanCreateLinks: false } }} />);
    expect(screen.getByRole("button", { name: /share link/i })).toBeDefined();
  });
});

describe("creating a room (E17, E18)", () => {
  it("sends the name only when the plan has custom names, then opens the room", async () => {
    const { api, calls } = fakeApi(() => ({ room }));
    show(api, <CreateRoomDialog customNames open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByTestId("room-name"), { target: { value: "  Book club  " } });
    await act(async () => fireEvent.click(screen.getByTestId("create-room-submit")));
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v1/rooms", body: { name: "Book club" } });
    expect(push).toHaveBeenCalledWith(`/rooms/${ROOM_ID}`);
    cleanup();
    const free = fakeApi(() => ({ room }));
    show(free.api, <CreateRoomDialog customNames={false} open onOpenChange={() => {}} />);
    expect(screen.queryByTestId("room-name")).toBeNull();
    expect(screen.getByText(ROOM_COPY.nameNotInPlan)).toBeDefined();
    await act(async () => fireEvent.click(screen.getByTestId("create-room-submit")));
    expect(free.calls[0]?.body).toEqual({});
  });

  it("explains the room cap", async () => {
    const { api } = fakeApi(() => new ApiRequestError(409, "ROOM_LIMIT", "limit", "req", { maxRooms: 20 }));
    show(api, <CreateRoomDialog customNames open onOpenChange={() => {}} />);
    await act(async () => fireEvent.click(screen.getByTestId("create-room-submit")));
    expect(screen.getByText(ROOM_COPY.createErrors.limit(20))).toBeDefined();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("invite links (§17.8.4.1, E21)", () => {
  const url = `http://localhost/j/AAAAAAAAAAAAAAAA#k=${SECRET}`;

  it("shows a new link's URL once, in the dialog only: never in the query cache, and gone when the dialog closes", async () => {
    const { api, calls } = fakeApi((call) => {
      if (call.path.endsWith("/entitlements")) return entitlements({});
      if (call.method === "GET") return { invites: [] };
      return { invite: { inviteId: "AAAAAAAAAAAAAAAA", kind: "invite_link", url, expiresAt: new Date().toISOString(), maxUses: null } };
    });
    const onOpenChange = vi.fn();
    const client = show(api, <InviteDialog room={room} open onOpenChange={onOpenChange} />);
    expect(screen.getByTestId("invite-warning").textContent).toBe(ROOM_COPY.inviteWarning);
    await waitFor(() => expect(screen.getByTestId("invite-create")).toBeDefined());
    await act(async () => fireEvent.click(screen.getByTestId("invite-create")));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ kind: "invite_link", expiresIn: DAY });
    expect((screen.getByTestId("invite-url") as HTMLInputElement).value).toBe(url);
    expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(SECRET);
    fireEvent.click(screen.getByRole("button", { name: ROOM_COPY.cancel }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("lists the open links without secrets and turns one off", async () => {
    const { api, calls } = fakeApi((call) => {
      if (call.path.endsWith("/entitlements")) return entitlements({});
      if (call.method === "GET") {
        return { invites: [{ inviteId: "BBBBBBBBBBBBBBBB", kind: "invite_link", createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(), useCount: 2, maxUses: 5 }] };
      }
      return undefined;
    });
    show(api, <InviteDialog room={room} open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("open-invite").textContent).toContain(ROOM_COPY.inviteUsed(2, 5)));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: ROOM_COPY.inviteRevoke })));
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/v1/invites/BBBBBBBBBBBBBBBB")).toBe(true);
  });

  it("says invite links come with Pro when the plan doesn't have them (a downgraded owner, D4-16)", async () => {
    const { api } = fakeApi(() => entitlements({ multiUseInvites: false }));
    show(api, <InviteDialog room={room} open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("upgrade-hint").textContent).toContain(ROOM_COPY.inviteNotInPlan));
    expect(screen.queryByTestId("invite-create")).toBeNull();
  });
});

describe("members (D4-15)", () => {
  const members: RoomMemberDto[] = [
    { memberId: "66666666-6666-4666-8666-666666666661", role: "owner", label: "Sam", joinedAt: new Date().toISOString(), isYou: true },
    { memberId: "66666666-6666-4666-8666-666666666662", role: "member", label: "Quiet Otter", joinedAt: new Date().toISOString(), isYou: false },
  ];

  it("shows labels and roles; the owner removes members after confirming", async () => {
    const { api, calls } = fakeApi((call) => (call.method === "GET" ? { members } : undefined));
    show(api, <MemberList room={room} />);
    await waitFor(() => expect(screen.getAllByTestId("member-row")).toHaveLength(2));
    expect(screen.getAllByTestId("member-row")[0]?.textContent).toContain(`Sam (${ROOM_COPY.you})`);
    expect(screen.getAllByRole("button", { name: /remove/i })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: `${ROOM_COPY.remove} Quiet Otter` }));
    await act(async () => fireEvent.click(screen.getByTestId("confirm-remove")));
    expect(calls.some((c) => c.method === "DELETE" && c.path === `/api/v1/rooms/${ROOM_ID}/members/${members[1]!.memberId}`)).toBe(true);
  });

  it("offers a member no removal", async () => {
    const { api } = fakeApi(() => ({ members }));
    show(api, <MemberList room={{ ...room, role: "member" }} />);
    await waitFor(() => expect(screen.getAllByTestId("member-row")).toHaveLength(2));
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });
});

describe("the owner's settings", () => {
  it("sends only what changed; names follow the plan; deleting asks first", async () => {
    const { api, calls } = fakeApi((call) => (call.path.endsWith("/entitlements") ? entitlements({ customRoomNames: false }) : { room }));
    const onDeleted = vi.fn();
    show(api, <RoomSettingsDialog room={room} open onOpenChange={() => {}} onDeleted={onDeleted} />);
    await waitFor(() => expect((screen.getByTestId("room-rename") as HTMLInputElement).disabled).toBe(true));
    fireEvent.click(screen.getByTestId("room-links-setting"));
    await act(async () => fireEvent.click(screen.getByTestId("room-settings-save")));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ membersCanCreateLinks: false });
    fireEvent.click(screen.getByTestId("delete-room"));
    expect(screen.getByText(ROOM_COPY.deleteDescription)).toBeDefined();
    await act(async () => fireEvent.click(screen.getByTestId("confirm-delete-room")));
    expect(calls.some((c) => c.method === "DELETE" && c.path === `/api/v1/rooms/${ROOM_ID}`)).toBe(true);
    expect(onDeleted).toHaveBeenCalled();
  });
});

describe("joining by invite (/j/{inviteId})", () => {
  function join(api: ApiClient) {
    return show(
      api,
      <SessionStore.Provider>
        <Ready>
          <InviteAccept inviteId="AAAAAAAAAAAAAAAA" />
        </Ready>
      </SessionStore.Provider>,
    );
  }

  it("reads the secret once and strips it, previews, and joins only when the person confirms", async () => {
    window.history.replaceState(null, "", `/j/AAAAAAAAAAAAAAAA#k=${SECRET}`);
    const { api, calls } = fakeApi((call) =>
      call.path.endsWith("/preview")
        ? { roomLabel: "Book club", memberCount: 3, kind: "invite_link", expiresAt: new Date().toISOString() }
        : { room: { ...room, role: "member" } },
    );
    const client = join(api);
    expect(window.location.hash).toBe("");
    await waitFor(() => expect(screen.getByTestId("invite-room").textContent).toBe(ROOM_COPY.joinPrompt("Book club")));
    expect(calls.map((c) => c.path)).toEqual(["/api/v1/invites/AAAAAAAAAAAAAAAA/preview"]);
    expect(calls[0]?.body).toEqual({ secret: SECRET });
    await act(async () => fireEvent.click(screen.getByTestId("invite-join")));
    expect(calls[1]).toMatchObject({ method: "POST", path: "/api/v1/invites/AAAAAAAAAAAAAAAA/accept", body: { secret: SECRET } });
    expect(push).toHaveBeenCalledWith(`/rooms/${ROOM_ID}`);
    expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(SECRET);
  });

  it("without the fragment it calls nothing; refusals say why", async () => {
    window.history.replaceState(null, "", "/j/AAAAAAAAAAAAAAAA");
    const empty = fakeApi(() => undefined);
    join(empty.api);
    expect(screen.getByTestId("invite-error").textContent).toBe(ROOM_COPY.joinUnavailable);
    expect(empty.calls).toEqual([]);
    cleanup();
    window.history.replaceState(null, "", `/j/AAAAAAAAAAAAAAAA#k=${SECRET}`);
    const expired = fakeApi(() => new ApiRequestError(410, "INVITE_EXPIRED", "expired", "req"));
    join(expired.api);
    await waitFor(() => expect(screen.getByTestId("invite-error").textContent).toBe(ROOM_COPY.joinExpired));
  });
});

describe("navigation", () => {
  it("has a Rooms tab, current on a room's page", () => {
    pathname.current = `/rooms/${ROOM_ID}`;
    render(
      <SessionStore.Provider>
        <AppShell>
          <p>content</p>
        </AppShell>
      </SessionStore.Provider>,
    );
    const tab = screen.getByRole("link", { name: ROOM_COPY.nav });
    expect(tab.getAttribute("href")).toBe("/rooms");
    expect(tab.className).toContain("font-medium");
    expect(screen.getByRole("link", { name: "This network" }).className).not.toContain("font-medium");
    pathname.current = "/rooms";
  });
});
