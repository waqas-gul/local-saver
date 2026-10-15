import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "@/components/local/composer";
import { NetworkStatusPanel } from "@/components/local/network-status";
import { UploadsStore } from "@/lib/client/stores/session";
import { UiStoreProvider } from "@/lib/client/stores/ui-store";
import { ShareCard, type ShareActions } from "@/components/local/share-card";
import type { ShareDto } from "@/lib/shared/api/schemas";

const baseShare: ShareDto = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "text",
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

function actions(overrides: Partial<ShareActions> = {}): ShareActions {
  return {
    download: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    saveText: vi.fn(async () => "ok" as const),
    reload: vi.fn(),
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("NetworkStatusPanel (network line, 03 §3.5 status copy)", () => {
  it("shows the network and how many devices are here on an ok network", () => {
    render(<NetworkStatusPanel status="ok" reason={null} devicesHere={3} />);
    expect(screen.getByTestId("network-line").textContent).toBe("This network · 3 devices here now");
    // The audience message belongs to the composer (DEC-033), not the status bar.
    expect(screen.queryByText(/Visible to everyone/)).toBeNull();
  });

  it("uses the singular for one device", () => {
    render(<NetworkStatusPanel status="ok" reason={null} devicesHere={1} />);
    expect(screen.getByTestId("network-line").textContent).toBe("This network · 1 device here now");
  });

  it("explains why local sharing is off on shared networks", () => {
    render(<NetworkStatusPanel status="too_large" reason="devices_24h_over_cap" devicesHere={0} />);
    expect(screen.getByText("Local sharing is off on this network")).toBeDefined();
    expect(screen.getByText(/mobile, VPN, relay or very large shared network/)).toBeDefined();
    expect(screen.queryByText(/Visible to everyone/)).toBeNull();
  });

  it("has distinct copy for blocked, paused and unknown networks", () => {
    const { rerender } = render(<NetworkStatusPanel status="blocked" reason="operator" devicesHere={0} />);
    expect(screen.getByText(/turned off for this network/)).toBeDefined();
    rerender(<NetworkStatusPanel status="unavailable" reason="disabled" devicesHere={0} />);
    expect(screen.getByText("Local sharing is paused")).toBeDefined();
    rerender(<NetworkStatusPanel status="unavailable" reason="no_trusted_ip" devicesHere={0} />);
    expect(screen.getByText(/can't tell which network you're on/)).toBeDefined();
    rerender(<NetworkStatusPanel status="unavailable" reason="classification_unavailable" devicesHere={0} />);
    expect(screen.getByText(/network checks are being updated/)).toBeDefined();
  });
});

describe("Composer (DEC-033 audience before posting)", () => {
  it("states the audience at the point of posting", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <UiStoreProvider>
          <UploadsStore.Provider>
            <Composer />
          </UploadsStore.Provider>
        </UiStoreProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("audience-line").textContent).toBe("Visible to everyone on this network");
    expect(screen.getByTestId("composer-submit").textContent).toBe("Share to this network");
  });
});

describe("ShareCard", () => {
  it("renders text as plain text, never HTML", () => {
    const { container } = render(
      <ShareCard share={{ ...baseShare, text: { content: '<img src=x onerror="alert(1)">', version: 1 } }} actions={actions()} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeDefined();
  });

  it("links only http(s) URLs, as untrusted content in a new tab", () => {
    render(<ShareCard share={{ ...baseShare, text: { content: "see https://example.org/x or javascript:alert(1)", version: 1 } }} actions={actions()} />);
    const link = screen.getByRole("link", { name: "https://example.org/x" });
    expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow ugc");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("lets everyone copy text", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ShareCard share={baseShare} actions={actions()} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /copy/i })));
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("offers edit and delete only to the creator (DEC-033)", () => {
    const { rerender } = render(<ShareCard share={baseShare} actions={actions()} />);
    expect(screen.queryByRole("button", { name: /edit/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
    rerender(<ShareCard share={{ ...baseShare, isMine: true }} actions={actions()} />);
    expect(screen.getByRole("button", { name: /edit/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /delete/i })).toBeDefined();
  });

  it("reports an edit conflict instead of overwriting (DEC-027)", async () => {
    const saveText = vi.fn(async () => "conflict" as const);
    render(<ShareCard share={{ ...baseShare, isMine: true }} actions={actions({ saveText })} />);
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "new text" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /save/i })));
    expect(saveText).toHaveBeenCalledWith("new text", 1);
    expect(screen.getByText(/changed on another device/)).toBeDefined();
  });

  it("asks before downloading a risky file (03 §7.4)", async () => {
    const download = vi.fn(async () => {});
    const share: ShareDto = {
      ...baseShare,
      kind: "files",
      text: null,
      fileCount: 1,
      totalBytes: 1000,
      files: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          name: "setup.exe",
          sizeBytes: 1000,
          type: "application/octet-stream",
          status: "verified",
          previewable: false,
          riskFlags: ["executable"],
        },
      ],
    };
    render(<ShareCard share={share} actions={actions({ download })} />);
    expect(screen.getByText("Program")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /download setup\.exe/i }));
    expect(download).not.toHaveBeenCalled();
    expect(await screen.findByText(/Anyone on this network could have posted this/)).toBeDefined();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /download anyway/i })));
    await waitFor(() => expect(download).toHaveBeenCalledWith(share.files[0]));
  });

  it("downloads ordinary files straight away", async () => {
    const download = vi.fn(async () => {});
    const share: ShareDto = {
      ...baseShare,
      kind: "files",
      text: null,
      fileCount: 1,
      totalBytes: 5,
      files: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          name: "notes.txt",
          sizeBytes: 5,
          type: "text/plain",
          status: "verified",
          previewable: false,
          riskFlags: [],
        },
      ],
    };
    render(<ShareCard share={share} actions={actions({ download })} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /download notes\.txt/i })));
    expect(download).toHaveBeenCalledWith(share.files[0]);
  });
});
