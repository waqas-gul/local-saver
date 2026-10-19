import { describe, expect, it } from "vitest";
import { collapse } from "../../scripts/load-egress-ranges.cjs";

/**
 * The loader merges adjacent and overlapping ranges before storing them (review L5): the
 * coarse-prefix lookup then returns a few rows instead of thousands of Apple /64s.
 */
describe("collapse", () => {
  it("merges adjacent and overlapping ranges into the fewest aligned CIDRs", () => {
    expect(collapse(["192.0.2.0/27", "192.0.2.32/27"])).toEqual(["192.0.2.0/26"]);
    expect(collapse(["192.0.2.0/25", "192.0.2.64/26"])).toEqual(["192.0.2.0/25"]);
    expect(collapse(["192.0.2.0/32", "192.0.2.1/32", "192.0.2.2/32"])).toEqual(["192.0.2.0/31", "192.0.2.2/32"]);
    expect(collapse(["2001:db8:1::/64", "2001:db8:1:1::/64"])).toEqual(["2001:db8:1::/63"]);
  });

  it("keeps unaligned neighbours as separate blocks and families apart", () => {
    expect(collapse(["192.0.2.1/32", "192.0.2.2/32"])).toEqual(["192.0.2.1/32", "192.0.2.2/32"]);
    expect(collapse(["2001:db8::/127", "192.0.2.0/31"])).toEqual(["192.0.2.0/31", "2001:db8::/127"]);
  });

  it("covers exactly the same addresses", () => {
    const input = ["198.51.100.0/30", "198.51.100.4/31", "198.51.100.6/32", "198.51.100.9/32", "198.51.100.8/32"];
    expect(collapse(input)).toEqual(["198.51.100.0/30", "198.51.100.4/31", "198.51.100.6/32", "198.51.100.8/31"]);
    expect(collapse(["0.0.0.0/1", "128.0.0.0/1"])).toEqual(["0.0.0.0/0"]);
  });
});
