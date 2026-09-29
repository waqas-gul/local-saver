import { act, render, screen } from "@testing-library/react";
import { useQueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { AppProviders } from "@/lib/client/providers";
import { getQueryClient } from "@/lib/client/query-client";
import { useUiStore } from "@/lib/client/stores/ui-store";

function DialogProbe({ label }: { label: string }) {
  const activeDialog = useUiStore((s) => s.activeDialog);
  const openDialog = useUiStore((s) => s.openDialog);
  return (
    <button type="button" onClick={() => openDialog(label)}>
      {label}:{activeDialog ?? "none"}
    </button>
  );
}

function QueryProbe() {
  const client = useQueryClient();
  return <span>{client ? "query-client-ready" : "missing"}</span>;
}

describe("AppProviders", () => {
  it("provides the TanStack Query client and the Zustand UI store", () => {
    render(
      <AppProviders>
        <QueryProbe />
        <DialogProbe label="a" />
      </AppProviders>,
    );
    expect(screen.getByText("query-client-ready")).toBeDefined();
    act(() => screen.getByRole("button").click());
    expect(screen.getByRole("button").textContent).toBe("a:a");
  });

  it("gives each provider tree its own store (no shared module-level state)", () => {
    render(
      <>
        <AppProviders>
          <DialogProbe label="first" />
        </AppProviders>
        <AppProviders>
          <DialogProbe label="second" />
        </AppProviders>
      </>,
    );
    act(() => screen.getByText("first:none").click());
    expect(screen.getByText("first:first")).toBeDefined();
    expect(screen.getByText("second:none")).toBeDefined();
  });

  it("throws a clear error when the store is used outside the provider", () => {
    const original = console.error;
    console.error = () => {};
    try {
      expect(() => render(<DialogProbe label="x" />)).toThrow(/AppProviders/);
    } finally {
      console.error = original;
    }
  });

  it("reuses one query client in the browser", () => {
    expect(getQueryClient()).toBe(getQueryClient());
  });
});
