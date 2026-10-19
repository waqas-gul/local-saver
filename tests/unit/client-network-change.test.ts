import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { applyNetworkChange } from "@/lib/client/network";
import { queryKeys } from "@/lib/client/queries/keys";

/** DEC-034 rule 3, T-003, RISK-027: leaving a network removes its data from the cache. */

function seeded() {
  const qc = new QueryClient();
  qc.setQueryData(queryKeys.localFeed(["space-a"]), { shares: [{ id: "s1" }] });
  qc.setQueryData(queryKeys.share("s1"), { id: "s1" });
  qc.setQueryData(queryKeys.preview("f1"), { url: "https://storage.example/f1" });
  qc.setQueryData(queryKeys.myShares(), { shares: [{ id: "mine" }] });
  return qc;
}

const ok = (spaceIds: string[]) => ({ status: "ok" as const, reason: null, spaceIds, devicesHere: 1 });

describe("applyNetworkChange", () => {
  it("removes every network-scoped query when the space IDs change", () => {
    const qc = seeded();
    expect(applyNetworkChange(qc, ok(["space-a"]), ok(["space-b"]))).toBe(true);
    expect(qc.getQueryData(queryKeys.localFeed(["space-a"]))).toBeUndefined();
    expect(qc.getQueryData(queryKeys.share("s1"))).toBeUndefined();
    expect(qc.getQueryData(queryKeys.preview("f1"))).toBeUndefined();
    expect(qc.getQueryCache().findAll({ queryKey: ["local"] })).toHaveLength(0);
  });

  it("removes them when the network stops being ok", () => {
    const qc = seeded();
    const off = { status: "too_large" as const, reason: "devices_24h_over_cap", spaceIds: [], devicesHere: 0 };
    expect(applyNetworkChange(qc, ok(["space-a"]), off)).toBe(true);
    expect(qc.getQueryData(queryKeys.localFeed(["space-a"]))).toBeUndefined();
  });

  it("keeps My uploads, which belong to the user rather than the network", () => {
    const qc = seeded();
    applyNetworkChange(qc, ok(["space-a"]), ok(["space-b"]));
    expect(qc.getQueryData(queryKeys.myShares())).toEqual({ shares: [{ id: "mine" }] });
  });

  it("changes nothing when the network is the same, or on the first observe", () => {
    const qc = seeded();
    expect(applyNetworkChange(qc, ok(["space-a"]), ok(["space-a"]))).toBe(false);
    expect(applyNetworkChange(qc, undefined, ok(["space-a"]))).toBe(false);
    expect(qc.getQueryData(queryKeys.share("s1"))).toEqual({ id: "s1" });
  });
});
