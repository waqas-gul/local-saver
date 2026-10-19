import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { decodeQR } from "qr/decode.js";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROOM_COPY } from "@/components/room/copy";
import { InviteAccept } from "@/components/room/invite-accept";
import { InviteDialog } from "@/components/room/invite-dialog";
import { PairingDialog } from "@/components/room/pairing-qr";
import type { ApiClient } from "@/lib/client/api-client";
import { ApiRequestError } from "@/lib/client/api-error";
import { SessionStore } from "@/lib/client/stores/session";
import type { EntitlementsResponse, InviteSummaryDto, RoomDto } from "@/lib/shared/api/schemas";

/**
 * QR pairing UI (phase 4 §17.8.4.1, P4-18). T4-R15's automated half: the owner's dialog draws the code's URL, secret
 * included, as a QR code that decodes to exactly that URL (a phone's camera is the manual half). The URL lives only in
 * the dialog: never as text, a link, the query cache or a store. The dialog counts down, notices when the code was
 * used or expired, and turns an unused code off when closed. The join page names the room, warns that a pairing code
 * is meant to be scanned in person, and joins only when the person taps Join.
 */

const runtimeMock = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/client/runtime", () => ({ useRuntime: () => runtimeMock.current }));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/rooms" }));

const ROOM_ID = "33333333-3333-4333-8333-333333333333";
const SECRET = "Pq7_-".repeat(8) + "xyz";
const CODE_ID = "PairPairPairPair";
const URL_WITH_SECRET = `http://127.0.0.1:3102/j/${CODE_ID}#k=${SECRET}`;

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
  memberCount: 1,
  settings: { membersCanCreateLinks: true, defaultExpirySeconds: null },
  createdAt: new Date().toISOString(),
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
  const view = render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  return { client, view };
}

/** A pairing code as the server makes it, living `seconds` from now. */
function created(seconds = 600, inviteId = CODE_ID, url = URL_WITH_SECRET) {
  return { invite: { inviteId, kind: "pairing", url, expiresAt: new Date(Date.now() + seconds * 1000).toISOString(), maxUses: 1 } };
}

function summary(inviteId = CODE_ID, kind: InviteSummaryDto["kind"] = "pairing"): InviteSummaryDto {
  const now = Date.now();
  return { inviteId, kind, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString(), useCount: 0, maxUses: 1 };
}

/** Rasterize the drawn SVG modules (jsdom has no canvas) and decode them, as a camera would read the screen. */
function decodeShown(): string {
  const svg = screen.getByTestId("share-qr");
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

describe("the owner's QR code (T4-R15, E20)", () => {
  it("makes one code when opened and draws its URL as a QR code that decodes to exactly that URL, and nowhere else", async () => {
    const { api, calls } = fakeApi((call) => (call.method === "POST" ? created() : { invites: [summary()] }));
    const { client } = show(api, <PairingDialog room={room} open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("share-qr")).toBeDefined());
    expect(decodeShown()).toBe(URL_WITH_SECRET);
    expect(screen.getByRole("img", { name: ROOM_COPY.pairQrLabel("Book club") })).toBeDefined();
    expect(screen.getByTestId("pairing-room").textContent).toBe(ROOM_COPY.pairScan("Book club"));
    expect(screen.getByTestId("pairing-warning").textContent).toBe(ROOM_COPY.pairWarning);
    expect(screen.getByTestId("pairing-countdown").textContent).toMatch(/(10:00|9:5\d)/);
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: `/api/v1/rooms/${ROOM_ID}/invites`, body: { kind: "pairing" } }]);

    // The secret is only in the drawn modules: no text, attribute, link, input, cache entry or second request.
    const dialog = screen.getByTestId("pairing-dialog");
    expect(dialog.outerHTML).not.toContain(SECRET);
    expect(dialog.outerHTML).not.toContain(CODE_ID);
    expect(dialog.querySelector("a, input, textarea, img")).toBeNull();
    expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(SECRET);
    await waitFor(() => expect(calls.some((c) => c.method === "GET")).toBe(true));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("says when someone joined with it (the code left the open list before expiring) and offers another", async () => {
    let open = [summary()];
    const codes = [CODE_ID, "PairNextNextNext"];
    let made = 0;
    const { api, calls } = fakeApi((call) => {
      if (call.method !== "POST") return { invites: open };
      const id = codes[made++]!;
      return created(600, id, URL_WITH_SECRET.replace(CODE_ID, id));
    });
    const onOpenChange = vi.fn();
    const { client } = show(api, <PairingDialog room={room} open onOpenChange={onOpenChange} />);
    await waitFor(() => expect(screen.getByTestId("share-qr")).toBeDefined());
    await waitFor(() => expect(calls.some((c) => c.method === "GET")).toBe(true));
    // The room's channel says a member joined (member.changed invalidates ['room', id] and everything under it).
    open = [];
    await act(async () => client.invalidateQueries({ queryKey: ["room", ROOM_ID] }));
    await waitFor(() => expect(screen.getByTestId("pairing-used").textContent).toBe(ROOM_COPY.pairUsed));
    expect(screen.queryByTestId("share-qr")).toBeNull();

    // Closing now turns nothing off: the code is spent.
    open = [summary("PairNextNextNext")];
    await act(async () => fireEvent.click(screen.getByTestId("pairing-new")));
    await waitFor(() => expect(decodeShown()).toBe(URL_WITH_SECRET.replace(CODE_ID, "PairNextNextNext")));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("counts down to expiry, then hides the dead code and offers a new one", async () => {
    const { api } = fakeApi((call) => (call.method === "POST" ? created(1) : { invites: [summary()] }));
    show(api, <PairingDialog room={room} open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("share-qr")).toBeDefined());
    await waitFor(() => expect(screen.getByTestId("pairing-expired").textContent).toBe(ROOM_COPY.pairExpired), { timeout: 3_000 });
    expect(screen.queryByTestId("share-qr")).toBeNull();
    expect(screen.getByTestId("pairing-new")).toBeDefined();
  });

  it("closing it while the code is unused turns the code off", async () => {
    const { api, calls } = fakeApi((call) => (call.method === "POST" ? created() : call.method === "GET" ? { invites: [summary()] } : undefined));
    const onOpenChange = vi.fn();
    show(api, <PairingDialog room={room} open onOpenChange={onOpenChange} />);
    await waitFor(() => expect(screen.getByTestId("share-qr")).toBeDefined());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: ROOM_COPY.pairClose })));
    expect(calls.some((c) => c.method === "DELETE" && c.path === `/api/v1/invites/${CODE_ID}`)).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("explains a refusal and tries again on request", async () => {
    const refusals = [
      [new ApiRequestError(429, "RATE_LIMITED", "slow down", "req", undefined, 60), ROOM_COPY.pairErrors.rateLimited],
      [new ApiRequestError(403, "UPLOADS_RESTRICTED", "no", "req"), ROOM_COPY.pairErrors.restricted],
      [new ApiRequestError(403, "ACCOUNT_DELETION_PENDING", "no", "req"), ROOM_COPY.pairErrors.deletion],
      [new ApiRequestError(500, "INTERNAL", "boom", "req"), ROOM_COPY.pairErrors.other],
    ] as const;
    for (const [error, text] of refusals) {
      let fail = true;
      const { api, calls } = fakeApi((call) => (call.method === "POST" ? (fail ? error : created()) : { invites: [summary()] }));
      show(api, <PairingDialog room={room} open onOpenChange={() => {}} />);
      await waitFor(() => expect(screen.getByTestId("pairing-error").textContent).toBe(text));
      expect(screen.queryByTestId("share-qr")).toBeNull();
      fail = false;
      await act(async () => fireEvent.click(screen.getByTestId("pairing-new")));
      await waitFor(() => expect(screen.getByTestId("share-qr")).toBeDefined());
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
      cleanup();
    }
  });
});

describe("invite links next to pairing codes", () => {
  it("the invite dialog lists open invite links only, never the QR codes", async () => {
    const entitlements = { plan: "pro", features: { multiUseInvites: true }, limits: {} } as unknown as EntitlementsResponse;
    const { api } = fakeApi((call) => (call.path.endsWith("/entitlements") ? entitlements : { invites: [summary("LinkLinkLinkLink", "invite_link"), summary()] }));
    show(api, <InviteDialog room={room} open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("open-invite")).toHaveLength(1));
  });
});

describe("joining with a scanned code (/j/{inviteId})", () => {
  function Ready({ children }: { children: ReactNode }) {
    const store = SessionStore.useStoreApi();
    useState(() => store.getState().ready("44444444-4444-4444-8444-444444444444", { id: "55555555-5555-4555-8555-555555555555", label: "Blue Fox", platform: "" }));
    return <>{children}</>;
  }
  function join(api: ApiClient) {
    return show(
      api,
      <SessionStore.Provider>
        <Ready>
          <InviteAccept inviteId={CODE_ID} />
        </Ready>
      </SessionStore.Provider>,
    );
  }
  const pairingPreview = { roomLabel: "Book club", memberCount: 1, kind: "pairing", expiresAt: new Date(Date.now() + 600_000).toISOString() };

  it("names the room, says a code is for scanning in person, and joins only when the person taps Join", async () => {
    window.history.replaceState(null, "", `/j/${CODE_ID}#k=${SECRET}`);
    const { api, calls } = fakeApi((call) => (call.path.endsWith("/preview") ? pairingPreview : { room: { ...room, role: "member", memberCount: 2 } }));
    const { client } = join(api);
    expect(window.location.hash).toBe("");
    await waitFor(() => expect(screen.getByTestId("invite-room").textContent).toBe(ROOM_COPY.joinPrompt("Book club")));
    expect(screen.getByTestId("invite-pairing-hint").textContent).toBe(ROOM_COPY.joinPairingHint);
    expect(calls.map((c) => c.path)).toEqual([`/api/v1/invites/${CODE_ID}/preview`]);
    await act(async () => fireEvent.click(screen.getByTestId("invite-join")));
    expect(calls[1]).toMatchObject({ method: "POST", path: `/api/v1/invites/${CODE_ID}/accept`, body: { secret: SECRET } });
    expect(push).toHaveBeenCalledWith(`/rooms/${ROOM_ID}`);
    expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(SECRET);
  });

  it("a code used or expired between the scan and Join says so in pairing terms; an invite link's preview has no pairing hint", async () => {
    window.history.replaceState(null, "", `/j/${CODE_ID}#k=${SECRET}`);
    const { api } = fakeApi((call) => (call.path.endsWith("/preview") ? pairingPreview : new ApiRequestError(410, "INVITE_EXPIRED", "gone", "req")));
    join(api);
    await waitFor(() => expect(screen.getByTestId("invite-join")).toBeDefined());
    await act(async () => fireEvent.click(screen.getByTestId("invite-join")));
    await waitFor(() => expect(screen.getByTestId("invite-error").textContent).toBe(ROOM_COPY.joinPairingExpired));
    cleanup();

    window.history.replaceState(null, "", `/j/${CODE_ID}#k=${SECRET}`);
    const link = fakeApi(() => ({ ...pairingPreview, kind: "invite_link" }));
    join(link.api);
    await waitFor(() => expect(screen.getByTestId("invite-room")).toBeDefined());
    expect(screen.queryByTestId("invite-pairing-hint")).toBeNull();
  });
});
