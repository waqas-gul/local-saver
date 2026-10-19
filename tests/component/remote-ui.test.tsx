import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ReportPage from "@/app/(legal)/report/page";
import { Composer } from "@/components/local/composer";
import { NetworkStatusPanel } from "@/components/local/network-status";
import { ShareCard, type ShareActions } from "@/components/local/share-card";
import { ReportDialog } from "@/components/report/report-dialog";
import { CodeEntry } from "@/components/share/code-entry";
import { SharedView } from "@/components/share/shared-view";
import type { ApiClient } from "@/lib/client/api-client";
import { UploadsStore } from "@/lib/client/stores/session";
import { UiStoreProvider } from "@/lib/client/stores/ui-store";
import type { ShareDto } from "@/lib/shared/api/schemas";

/** Phase 2 UI: destinations, creator vs viewer actions, reports, codes and the share page. */

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/" }));

afterEach(() => {
  vi.restoreAllMocks();
  push.mockReset();
  window.history.replaceState(null, "", "/");
});

const share: ShareDto = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "text",
  scope: "network",
  status: "active",
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 23 * 3600_000).toISOString(),
  isMine: false,
  fromLabel: "Blue Fox",
  text: { content: "hello", version: 1 },
  files: [],
  fileCount: 0,
  totalBytes: 0,
};

const actions: ShareActions = {
  download: async () => {},
  remove: async () => {},
  saveText: async () => "ok",
  reload: () => {},
};

function withQuery(children: ReactNode) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("Composer destinations (DEC-033)", () => {
  it("offers only Link only where local sharing is off, with its own audience line", () => {
    render(
      withQuery(
        <UiStoreProvider>
          <UploadsStore.Provider>
            <Composer localAvailable={false} />
          </UploadsStore.Provider>
        </UiStoreProvider>,
      ),
    );
    expect(screen.queryByTestId("composer-destination")).toBeNull();
    expect(screen.getByTestId("audience-line").textContent).toMatch(/^Not visible on any network/);
    expect(screen.getByTestId("composer-submit").textContent).toBe("Post and get a link");
  });

  it("points to the link fallback when local sharing is off", () => {
    render(<NetworkStatusPanel status="shared_egress" reason="egress_list:tor" devicesHere={0} />);
    expect(screen.getByText(/share by link, QR code or share code/)).toBeDefined();
  });
});

describe("ShareCard actions (DEC-033)", () => {
  it("offers Share link to the creator and Report to everyone else", () => {
    const { rerender } = render(<ShareCard share={share} actions={actions} onShareByLink={() => {}} onReport={() => {}} />);
    expect(screen.getByRole("button", { name: /report/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /share link/i })).toBeNull();
    rerender(<ShareCard share={{ ...share, isMine: true }} actions={actions} onShareByLink={() => {}} onReport={() => {}} />);
    expect(screen.getByRole("button", { name: /share link/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /report/i })).toBeNull();
  });

  it("marks link-only shares", () => {
    render(<ShareCard share={{ ...share, isMine: true, scope: "link_only" }} actions={actions} />);
    expect(screen.getByText("Link only")).toBeDefined();
  });
});

describe("ReportDialog (03 §7.6)", () => {
  it("needs a category, and details for 'Something else', then sends the report", async () => {
    const request = vi.fn(async () => ({ report: { id: "22222222-2222-4222-8222-222222222222" } }));
    const api = { request } as unknown as ApiClient;
    render(<ReportDialog api={api} target={{ type: "link", linkId: "AAAAAAAAAAAAAAAA" }} open onOpenChange={() => {}} />);
    const send = screen.getByTestId("report-submit") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Something else"));
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^Details/), { target: { value: "Fake login page" } });
    expect(send.disabled).toBe(false);
    await act(async () => fireEvent.click(send));
    expect(request).toHaveBeenCalledWith("POST", "/api/v1/reports", expect.objectContaining({
      body: { target: { type: "link", linkId: "AAAAAAAAAAAAAAAA" }, category: "other", details: "Fake login page" },
    }));
    expect(await screen.findByText("Thanks for reporting")).toBeDefined();
    // Owner decision 2026-10-16: reports are stored, audited and logged; nothing alerts a person
    // yet (Q-022), so the confirmation must not promise a review.
    const dialog = screen.getByTestId("report-dialog");
    expect(dialog.textContent).toContain("Your report was recorded.");
    expect(dialog.textContent).not.toMatch(/review/i);
  });

  it("the report page draft doesn't promise that a person reviews every report", () => {
    render(<ReportPage />);
    const page = document.body.textContent ?? "";
    expect(page).not.toMatch(/person reviews|we'll review|will be reviewed/i);
    expect(page).toContain("[OWNER: who reviews reports");
  });
});

describe("CodeEntry (DEC-014)", () => {
  it("checks the format before asking the server, and opens the share by link ID", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(200, { linkId: "AAAAAAAAAAAAAAAA" }));
    render(<CodeEntry />);
    fireEvent.change(screen.getByTestId("code-input"), { target: { value: "7KQ4M" } });
    await act(async () => fireEvent.click(screen.getByTestId("code-submit")));
    expect(screen.getByRole("alert").textContent).toMatch(/10 letters and numbers/);
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("code-input"), { target: { value: "7kq4m x9d2p" } });
    await act(async () => fireEvent.click(screen.getByTestId("code-submit")));
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ code: "7KQ4MX9D2P" });
    expect(push).toHaveBeenCalledWith("/s/AAAAAAAAAAAAAAAA");
  });
});

describe("SharedView: the share page (03 §4.1)", () => {
  const SECRET = "s".repeat(43);
  const content = {
    link: { id: "AAAAAAAAAAAAAAAA", expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    access: { expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    share: { kind: "text", expiresAt: new Date(Date.now() + 3600_000).toISOString(), text: { content: "from afar" }, files: [] },
  };

  it("unlocks with the fragment's secret, then removes it from the address bar", async () => {
    window.history.replaceState(null, "", `/s/AAAAAAAAAAAAAAAA#k=${SECRET}`);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(200, content));
    render(withQuery(<SharedView linkId="AAAAAAAAAAAAAAAA" />));
    expect(await screen.findByText("from afar")).toBeDefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/links/AAAAAAAAAAAAAAAA/unlock");
    expect(JSON.parse(String(init?.body))).toEqual({ secret: SECRET });
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/s/AAAAAAAAAAAAAAAA");
  });

  it("says the link isn't available when the secret is wrong, and drops the secret", async () => {
    window.history.replaceState(null, "", `/s/AAAAAAAAAAAAAAAA#k=${SECRET}`);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(404, { error: { code: "LINK_UNAVAILABLE", message: "x", requestId: "r" } }));
    render(withQuery(<SharedView linkId="AAAAAAAAAAAAAAAA" />));
    expect(await screen.findByText("This link isn't available")).toBeDefined();
    expect(window.location.hash).toBe("");
  });

  it("without a secret, uses this browser's grant, and explains an ended link", async () => {
    window.history.replaceState(null, "", "/s/AAAAAAAAAAAAAAAA");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(410, { error: { code: "LINK_EXPIRED", message: "x", requestId: "r" } }));
    render(withQuery(<SharedView linkId="AAAAAAAAAAAAAAAA" />));
    await waitFor(() => expect(screen.getByTestId("viewer-state").getAttribute("data-state")).toBe("expired"));
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/v1/links/AAAAAAAAAAAAAAAA/content");
  });
});
