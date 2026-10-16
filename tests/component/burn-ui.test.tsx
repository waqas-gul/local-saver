import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BURN } from "@/components/burn/copy";
import { Composer } from "@/components/local/composer";
import { ShareCard, type ShareActions } from "@/components/local/share-card";
import { SharedView } from "@/components/share/shared-view";
import { ApiRequestError } from "@/lib/client/api-error";
import { queryKeys } from "@/lib/client/queries/keys";
import { UploadsStore } from "@/lib/client/stores/session";
import { createUploadsStore } from "@/lib/client/stores/uploads";
import { UiStoreProvider } from "@/lib/client/stores/ui-store";
import { uploadFiles } from "@/lib/client/uploader";
import type { ShareDto } from "@/lib/shared/api/schemas";

/**
 * Burn-after-download UI (phase 3 §17.9, AC-3.8 component part): the toggle only when entitled,
 * a confirmation before every claim, Reveal, the claimant's state, "already downloaded", and no
 * burn text in the query cache.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/" }));

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const LATER = new Date(Date.now() + 15 * 60_000).toISOString();

const burnText: ShareDto = {
  id: "22222222-2222-4222-8222-222222222222",
  kind: "text",
  scope: "network",
  status: "active",
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 23 * 3600_000).toISOString(),
  isMine: false,
  fromLabel: "Blue Fox",
  text: null,
  files: [],
  fileCount: 0,
  totalBytes: 0,
  burn: { claimed: false, byYou: false, availableUntil: null, textHidden: true, revealsLeft: null },
};

const burnFile: ShareDto = {
  ...burnText,
  id: "33333333-3333-4333-8333-333333333333",
  kind: "files",
  files: [{ id: "44444444-4444-4444-8444-444444444444", name: "secret.pdf", sizeBytes: 10, type: "application/pdf", status: "verified", previewable: false, riskFlags: [] }],
  fileCount: 1,
  totalBytes: 10,
  burn: { claimed: false, byYou: false, availableUntil: null, textHidden: false, revealsLeft: null },
};

function actions(overrides: Partial<ShareActions> = {}): ShareActions {
  return {
    download: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    saveText: vi.fn(async () => "ok" as const),
    reload: vi.fn(),
    reveal: vi.fn(async () => ({ content: "meet at noon", left: 2, availableUntil: LATER })),
    confirmReceived: vi.fn(async () => {}),
    ...overrides,
  };
}

function withQuery(children: ReactNode, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("Composer: burn after download only when entitled (Q-008)", () => {
  function renderComposer(burnAfterDownload: boolean | null) {
    const client = new QueryClient();
    if (burnAfterDownload !== null) client.setQueryData(queryKeys.entitlements(), { plan: "free", features: { burnAfterDownload } });
    return render(
      withQuery(
        <UiStoreProvider>
          <UploadsStore.Provider>
            <Composer />
          </UploadsStore.Provider>
        </UiStoreProvider>,
        client,
      ),
    );
  }

  it("shows no toggle until the server says burn is available", () => {
    renderComposer(null);
    expect(screen.queryByTestId("composer-burn")).toBeNull();
  });

  it("shows no toggle when the plan doesn't include it", () => {
    renderComposer(false);
    expect(screen.queryByTestId("composer-burn")).toBeNull();
  });

  it("offers the toggle when entitled, and states who gets it (defined wording for this network)", () => {
    renderComposer(true);
    const toggle = screen.getByTestId("composer-burn") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.queryByTestId("burn-line")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByTestId("burn-line").textContent).toBe("The first person on this network to open it gets it");
    // The audience line stays: who can see it, then who gets it.
    expect(screen.getByTestId("audience-line").textContent).toBe("Visible to everyone on this network");
  });
});

describe("uploader: the burn flag goes to the server at creation", () => {
  it("sends burnAfterDownload only when asked", async () => {
    const bodies: unknown[] = [];
    const api = {
      request: vi.fn(async (_method: string, _path: string, options?: { body?: unknown }) => {
        bodies.push(options?.body);
        throw new ApiRequestError(400, "STOP", "stop");
      }),
    };
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    for (const burn of [true, false]) {
      await uploadFiles({ api, files: [file], expiresIn: 3600, burnAfterDownload: burn, uploads: createUploadsStore(), onFinished: () => {} });
    }
    expect(bodies[0]).toMatchObject({ burnAfterDownload: true });
    expect(bodies[1]).not.toHaveProperty("burnAfterDownload");
  });
});

describe("ShareCard: burn text", () => {
  it("hides the text behind Reveal; Reveal asks first with the defined wording, then shows it", async () => {
    const a = actions();
    render(<ShareCard share={burnText} actions={a} />);
    expect(screen.getByTestId("burn-badge")).toBeDefined();
    expect(screen.queryByTestId("share-text")).toBeNull();

    fireEvent.click(screen.getByTestId("burn-reveal"));
    expect(a.reveal).not.toHaveBeenCalled();
    const dialog = await screen.findByTestId("burn-confirm");
    expect(dialog.textContent).toContain("This will be deleted after you open it.");
    expect(dialog.textContent).toContain(BURN.graceWarning);
    expect(screen.getByTestId("burn-confirm-button").textContent).toBe("Reveal");

    await act(async () => fireEvent.click(screen.getByTestId("burn-confirm-button")));
    expect(a.reveal).toHaveBeenCalledTimes(1);
    expect((await screen.findByTestId("share-text")).textContent).toBe("meet at noon");
    expect(screen.getByTestId("reveals-left").textContent).toBe("2 views left");
  });

  it("cancelling the confirmation claims nothing", async () => {
    const a = actions();
    render(<ShareCard share={burnText} actions={a} />);
    fireEvent.click(screen.getByTestId("burn-reveal"));
    await screen.findByTestId("burn-confirm");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(a.reveal).not.toHaveBeenCalled();
  });

  it("keeps a revealed text out of the query cache", async () => {
    const client = new QueryClient();
    render(withQuery(<ShareCard share={burnText} actions={actions()} />, client));
    fireEvent.click(screen.getByTestId("burn-reveal"));
    await act(async () => fireEvent.click(await screen.findByTestId("burn-confirm-button")));
    await screen.findByTestId("share-text");
    expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data))).not.toContain("meet at noon");
  });

  it("the creator sees their text, can't edit a burn text, and sees when it was opened", () => {
    const mine: ShareDto = {
      ...burnText,
      isMine: true,
      status: "claimed",
      text: { content: "my secret", version: 1 },
      burn: { claimed: true, byYou: false, availableUntil: LATER, textHidden: false, revealsLeft: null },
    };
    render(<ShareCard share={mine} actions={actions()} />);
    expect(screen.getByTestId("share-text").textContent).toBe("my secret");
    expect(screen.queryByRole("button", { name: /edit/i })).toBeNull();
    expect(screen.queryByTestId("burn-reveal")).toBeNull();
    expect(screen.getByTestId("burn-opened")).toBeDefined();
  });
});

describe("ShareCard: burn files", () => {
  it("asks before the claiming download, then downloads with confirm", async () => {
    const a = actions();
    render(<ShareCard share={burnFile} actions={a} />);
    fireEvent.click(screen.getByRole("button", { name: "Download secret.pdf" }));
    expect(a.download).not.toHaveBeenCalled();
    expect((await screen.findByTestId("burn-confirm")).textContent).toContain("This will be deleted after you open it.");
    await act(async () => fireEvent.click(screen.getByTestId("burn-confirm-button")));
    expect(a.download).toHaveBeenCalledWith(burnFile.files[0], { confirm: true });
  });

  it("the claimant sees what is left and \"I've got it\", and retries without asking again", async () => {
    const a = actions();
    const claimed: ShareDto = {
      ...burnFile,
      status: "claimed",
      files: [{ ...burnFile.files[0]!, downloadsLeft: 2 }],
      burn: { claimed: true, byYou: true, availableUntil: LATER, textHidden: false, revealsLeft: null },
    };
    render(<ShareCard share={claimed} actions={a} />);
    expect(screen.getByTestId("downloads-left").textContent).toBe("2 downloads left");
    expect(screen.getByTestId("burn-claimant").textContent).toContain("Yours until");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Download secret.pdf" })));
    expect(screen.queryByTestId("burn-confirm")).toBeNull();
    expect(a.download).toHaveBeenCalledWith(claimed.files[0], { confirm: true });
    await act(async () => fireEvent.click(screen.getByTestId("burn-got-it")));
    expect(a.confirmReceived).toHaveBeenCalledTimes(1);
  });

  it("disables Download once every download is used", () => {
    const used: ShareDto = {
      ...burnFile,
      status: "claimed",
      files: [{ ...burnFile.files[0]!, downloadsLeft: 0 }],
      burn: { claimed: true, byYou: true, availableUntil: LATER, textHidden: false, revealsLeft: null },
    };
    render(<ShareCard share={used} actions={actions()} />);
    expect((screen.getByRole("button", { name: "Download secret.pdf" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says someone else got there first when the claim loses", async () => {
    const a = actions({
      download: vi.fn(async () => {
        throw new ApiRequestError(410, "ALREADY_DOWNLOADED", "x", "r", { byYou: false });
      }),
    });
    render(<ShareCard share={burnFile} actions={a} />);
    fireEvent.click(screen.getByRole("button", { name: "Download secret.pdf" }));
    await act(async () => fireEvent.click(await screen.findByTestId("burn-confirm-button")));
    expect(await screen.findByText(BURN.downloadedByOther)).toBeDefined();
  });

  it("a share that isn't burn downloads exactly as in Phase 1 (no confirmation, no flag)", async () => {
    const a = actions();
    const plain: ShareDto = { ...burnFile, burn: undefined };
    render(<ShareCard share={plain} actions={a} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Download secret.pdf" })));
    expect(screen.queryByTestId("burn-confirm")).toBeNull();
    expect(a.download).toHaveBeenCalledWith(plain.files[0]);
    expect(screen.queryByTestId("burn-badge")).toBeNull();
  });
});

describe("SharedView: burn after download on the share page", () => {
  function json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }
  const content = {
    link: { id: "AAAAAAAAAAAAAAAA", expiresAt: LATER },
    access: { expiresAt: LATER },
    share: {
      kind: "text",
      expiresAt: LATER,
      text: null,
      files: [],
      burn: { claimed: false, byYou: false, availableUntil: null, textHidden: true, revealsLeft: null },
    },
  };

  it("Reveal asks first, then claims with confirm and shows the text", async () => {
    window.history.replaceState(null, "", "/s/AAAAAAAAAAAAAAAA");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/reveal")) return json(200, { text: { content: "for your eyes" }, burn: { availableUntil: LATER, left: 2 } });
      return json(200, content);
    });
    render(withQuery(<SharedView linkId="AAAAAAAAAAAAAAAA" />));
    fireEvent.click(await screen.findByTestId("burn-reveal"));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/reveal"))).toBe(false);
    await act(async () => fireEvent.click(await screen.findByTestId("burn-confirm-button")));
    expect((await screen.findByTestId("shared-text")).textContent).toBe("for your eyes");
    const reveal = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/reveal"))!;
    expect(JSON.parse(String(reveal[1]?.body))).toEqual({ confirm: true });
  });

  it("explains that someone else already downloaded it, and that the claimant already has", async () => {
    for (const byYou of [false, true]) {
      window.history.replaceState(null, "", "/s/AAAAAAAAAAAAAAAA");
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        json(410, { error: { code: "ALREADY_DOWNLOADED", message: "x", requestId: "r", details: { byYou } } }),
      );
      const { unmount } = render(withQuery(<SharedView linkId="AAAAAAAAAAAAAAAA" />));
      await waitFor(() => expect(screen.getByTestId("viewer-state").getAttribute("data-state")).toBe(byYou ? "downloadedByYou" : "downloaded"));
      unmount();
      vi.restoreAllMocks();
    }
  });
});
