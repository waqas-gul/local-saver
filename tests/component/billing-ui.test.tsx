import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PricingTable } from "@/components/billing/pricing-table";
import { UpgradeHint, upgradeHint } from "@/components/billing/upgrade-hint";
import { Composer } from "@/components/local/composer";
import { ApiRequestError } from "@/lib/client/api-error";
import { queryKeys } from "@/lib/client/queries/keys";
import { UploadsStore } from "@/lib/client/stores/session";
import { UiStoreProvider } from "@/lib/client/stores/ui-store";
import type { EntitlementsResponse } from "@/lib/shared/api/schemas";
import { FREE_LIMITS, PRO_LIMITS } from "@/lib/shared/plans";

/**
 * Plan UI (phase 4 §17.6.5, P4-11): the pricing table comes from the plan constants as this build
 * delivers them; upgrade hints appear only where Pro would allow what was refused; the composer
 * offers the caller's plan's limits.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/" }));

const KB = 1024;
const MB = 1024 * KB;
const DAY = 86_400;

describe("PricingTable", () => {
  const cell = (row: string, column: 1 | 2) => within(screen.getByTestId(`pricing-row-${row}`)).getAllByRole("cell")[column - 1]?.textContent;

  it("compares Free and Pro from lib/shared/plans.ts", () => {
    render(<PricingTable />);
    expect([cell("maxTextBytes", 1), cell("maxTextBytes", 2)]).toEqual(["100 KB", "1.0 MB"]);
    expect([cell("maxFilesPerShare", 1), cell("maxFilesPerShare", 2)]).toEqual(["20", "100"]);
    expect([cell("activeStorageBytes", 1), cell("activeStorageBytes", 2)]).toEqual(["2.0 GB", "100 GB"]);
    expect([cell("dailyUploadBytes", 1), cell("dailyUploadBytes", 2)]).toEqual(["2.0 GB", "200 GB"]);
    expect([cell("expiry", 1), cell("expiry", 2)]).toEqual(["7 days", "90 days"]);
    expect([cell("linkExpiry", 1), cell("linkExpiry", 2)]).toEqual(["7 days", "90 days"]);
    expect([cell("codeExpiry", 1), cell("codeExpiry", 2)]).toEqual(["24 hours", "7 days"]);
    expect([cell("linkDownloads", 1), cell("linkDownloads", 2)]).toEqual(["500", "10,000"]);
    expect([cell("devices", 1), cell("devices", 2)]).toEqual(["10", "10"]);
    expect([cell("burnAfterDownload", 1), cell("burnAfterDownload", 2)]).toEqual(["Not included", "Included"]);
    // Phase 4D (P4-15): extend is built, so the page lists it.
    expect([cell("extendExpiry", 1), cell("extendExpiry", 2)]).toEqual(["Not included", "Included"]);
    // Phase 4D (P4-16): so are link passwords.
    expect([cell("linkPasswords", 1), cell("linkPasswords", 2)]).toEqual(["Not included", "Included"]);
    // Phase 4D (P4-17): private rooms, their custom names and invite links.
    expect([cell("privateRooms", 1), cell("privateRooms", 2)]).toEqual(["Not included", "Included"]);
    expect([cell("customRoomNames", 1), cell("customRoomNames", 2)]).toEqual(["Not included", "Included"]);
    expect([cell("multiUseInvites", 1), cell("multiUseInvites", 2)]).toEqual(["Not included", "Included"]);
    // Phase 4D (P4-19): read-only room links.
    expect([cell("roomLinks", 1), cell("roomLinks", 2)]).toEqual(["Not included", "Included"]);
    // Phase 4D (P4-20): transfer history.
    expect([cell("transferHistory", 1), cell("transferHistory", 2)]).toEqual(["Not included", "Included"]);
  });

  // Phase 4D (P4-14) lifts DV4-17: Pro's 5 GiB is delivered by multipart upload.
  it("shows what is enforced: 100 MB files for Free, 5 GB for Pro (multipart, P4-14)", () => {
    render(<PricingTable />);
    expect([cell("maxFileBytes", 1), cell("maxFileBytes", 2)]).toEqual(["100 MB", "5.0 GB"]);
    expect(PRO_LIMITS.maxFileBytes).toBe(5 * 1024 * MB);
  });

  it("names no feature that isn't built yet, and no price until the owner sets one (Q-006)", () => {
    render(<PricingTable />);
    const text = screen.getByTestId("pricing-table").textContent ?? "";
    // "Extend" left this list with P4-15, "Password" with P4-16, rooms and invite links with P4-17, room links with
    // P4-19 and history with P4-20, which built them (above). Team's features (Phase 5) aren't built.
    for (const unbuilt of ["adminControls", "brandedPages", "Admin", "Branded"]) expect(text).not.toContain(unbuilt);
    expect(screen.getByTestId("pro-price").textContent).toBe("[OWNER: price]");
  });
});

describe("upgradeHint (§17.6.5)", () => {
  const refusal = (status: number, code: string, details?: unknown) => new ApiRequestError(status, code, "refused", "req-1", details);

  it("speaks only when the server said Pro would allow it", () => {
    expect(upgradeHint(refusal(413, "TEXT_TOO_LARGE", { maxBytes: 100 * KB, requiredPlan: "pro" }))).toBe("Pro allows texts up to 1.0 MB.");
    expect(upgradeHint(refusal(413, "TEXT_TOO_LARGE", { maxBytes: MB }))).toBeNull();
    expect(upgradeHint(refusal(413, "TOO_MANY_FILES", { maxFiles: 20, requiredPlan: "pro" }))).toBe("Pro allows up to 100 files in one share.");
    expect(upgradeHint(refusal(409, "STORAGE_QUOTA_EXCEEDED", { usedBytes: 1, quotaBytes: 2, requiredPlan: "pro" }))).toBe("Pro includes 100 GB of storage.");
    expect(upgradeHint(refusal(403, "FEATURE_NOT_IN_PLAN", { feature: "burnAfterDownload", requiredPlan: "pro" }))).toBe("Burn after download comes with Pro.");
    expect(upgradeHint(refusal(403, "FEATURE_NOT_IN_PLAN", { feature: "executablesInRemoteLinks" }))).toBeNull();
  });

  it("tells share and link expiry from code expiry", () => {
    expect(upgradeHint(refusal(422, "EXPIRY_NOT_ALLOWED", { allowed: [3600, DAY, 7 * DAY], requiredPlan: "pro" }))).toBe("Pro lets shares and links last up to 90 days.");
    expect(upgradeHint(refusal(422, "EXPIRY_NOT_ALLOWED", { allowed: [600, 3600, DAY], requiredPlan: "pro" }))).toBe("Pro lets codes last up to 7 days.");
  });

  it("never for rate limits, other statuses or non-API errors", () => {
    expect(upgradeHint(refusal(429, "DAILY_UPLOAD_LIMIT", { requiredPlan: "pro" }))).toBeNull();
    expect(upgradeHint(refusal(400, "VALIDATION_FAILED", { requiredPlan: "pro" }))).toBeNull();
    expect(upgradeHint(new Error("network"))).toBeNull();
    expect(upgradeHint(null)).toBeNull();
  });

  it("links to the pricing page", () => {
    render(<UpgradeHint text="Pro allows more." />);
    const link = within(screen.getByTestId("upgrade-hint")).getByRole("link", { name: "See plans" });
    expect(link.getAttribute("href")).toBe("/pricing");
  });
});

describe("Composer: the caller's plan's limits (E3, E2 hints)", () => {
  const pro: EntitlementsResponse = {
    plan: "pro",
    source: "override",
    limits: {
      maxFileBytes: 100 * MB,
      maxFilesPerShare: PRO_LIMITS.maxFilesPerShare,
      maxTextBytes: PRO_LIMITS.maxTextBytes,
      activeStorageBytes: PRO_LIMITS.activeStorageBytes,
      dailyUploadBytes: PRO_LIMITS.dailyUploadBytes,
      expiryOptionsSeconds: [...PRO_LIMITS.localExpiryOptionsSeconds],
      linkExpiryOptionsSeconds: [...PRO_LIMITS.linkExpiryOptionsSeconds],
      shortCodeExpiryOptionsSeconds: [...PRO_LIMITS.shortCodeExpiryOptionsSeconds],
      maxSignedInDevices: 10,
      maxRooms: 20,
      maxRoomMembers: 50,
      historyRetentionDays: 365,
    },
    features: { burnAfterDownload: true },
  };

  function renderComposer(entitlements: EntitlementsResponse | null) {
    const client = new QueryClient();
    if (entitlements) client.setQueryData(queryKeys.entitlements(), entitlements);
    return render(
      <QueryClientProvider client={client}>
        <UiStoreProvider>
          <UploadsStore.Provider>
            <Composer />
          </UploadsStore.Provider>
        </UiStoreProvider>
      </QueryClientProvider>,
    );
  }
  const type = (content: string) => fireEvent.change(screen.getByTestId("composer-text"), { target: { value: content } });

  it("Free (or before the server answers): 100 KB, with the upgrade hint up to Pro's 1 MB", () => {
    renderComposer(null);
    type("x".repeat(FREE_LIMITS.maxTextBytes));
    expect(screen.queryByText(/Text can be up to/)).toBeNull();
    type("x".repeat(FREE_LIMITS.maxTextBytes + 1));
    expect(screen.getByText("Text can be up to 100 KB.")).toBeTruthy();
    expect(screen.getByTestId("upgrade-hint").textContent).toContain("Pro allows texts up to 1.0 MB.");
    expect((screen.getByTestId("composer-submit") as HTMLButtonElement).disabled).toBe(true);
    type("x".repeat(MB + 1));
    expect(screen.getByText("Text can be up to 100 KB.")).toBeTruthy();
    expect(screen.queryByTestId("upgrade-hint")).toBeNull();
  });

  it("Pro: up to 1 MB, and no hint", () => {
    renderComposer(pro);
    type("x".repeat(FREE_LIMITS.maxTextBytes + 1));
    expect(screen.queryByText(/Text can be up to/)).toBeNull();
    expect((screen.getByTestId("composer-submit") as HTMLButtonElement).disabled).toBe(false);
    type("x".repeat(MB + 1));
    expect(screen.getByText("Text can be up to 1.0 MB.")).toBeTruthy();
    expect(screen.queryByTestId("upgrade-hint")).toBeNull();
  });

  it("files: Free refuses a 21st file in the picker with the hint; Pro takes it", () => {
    const pick = () => {
      // Radix tabs switch on mouse down (left button), not on click.
      fireEvent.mouseDown(screen.getByRole("tab", { name: "Files" }), { button: 0, ctrlKey: false });
      const files = Array.from({ length: 21 }, (_, i) => new File(["x"], `f${i}.txt`, { type: "text/plain" }));
      fireEvent.change(screen.getByTestId("composer-files"), { target: { files } });
    };
    const first = renderComposer(null);
    pick();
    expect(screen.getByText("You can share up to 20 files at once.")).toBeTruthy();
    expect(screen.getByTestId("upgrade-hint").textContent).toContain("Pro allows up to 100 files in one share.");
    first.unmount();

    renderComposer(pro);
    pick();
    expect(screen.queryByText(/You can share up to/)).toBeNull();
    expect(screen.getByText("Choose files (up to 100, 100 MB each)")).toBeTruthy();
  });
});
