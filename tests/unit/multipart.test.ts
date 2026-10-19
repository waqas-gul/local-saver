import { describe, expect, it } from "vitest";
import { checkParts, partPlan, PARTS_PER_REQUEST, PART_URL_TTL_SECONDS } from "@/lib/server/storage/multipart";
import { MULTIPART_MAX_PARTS, partRange } from "@/lib/shared/multipart";
import { SINGLE_PUT_MAX_BYTES } from "@/lib/shared/plans";

/**
 * Multipart uploads (phase 4 §17.8.1, P4-14): the server fixes the part size and count, and completes
 * only an upload whose parts it has checked itself (the lying-client defences).
 */

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

describe("the part plan (04 §8.5)", () => {
  it("uses 16 MiB parts above the single-PUT size, the last part taking the rest", () => {
    expect(partPlan(SINGLE_PUT_MAX_BYTES + 1)).toEqual({ partSize: 16 * MiB, partCount: 7 });
    expect(partRange(7, 16 * MiB, SINGLE_PUT_MAX_BYTES + 1)).toEqual({ start: 96 * MiB, end: 100 * MiB + 1, size: 4 * MiB + 1 });
    expect(partPlan(120 * MiB)).toEqual({ partSize: 16 * MiB, partCount: 8 });
  });

  it("splits Pro's 5 GiB into 320 parts of 16 MiB", () => {
    expect(partPlan(5 * GiB)).toEqual({ partSize: 16 * MiB, partCount: 320 });
    expect(partRange(320, 16 * MiB, 5 * GiB).size).toBe(16 * MiB);
  });

  it("grows the part size (in whole MiB) so a file never needs more than about 9,000 parts", () => {
    const size = 200 * GiB;
    const { partSize, partCount } = partPlan(size);
    expect(partSize % MiB).toBe(0);
    expect(partSize).toBe(Math.ceil(size / 9000 / MiB) * MiB);
    expect(partCount).toBe(Math.ceil(size / partSize));
    expect(partCount).toBeLessThanOrEqual(9000);
    expect(partCount).toBeLessThanOrEqual(MULTIPART_MAX_PARTS);
  });

  it("covers the file exactly: equal parts, then the remainder", () => {
    for (const size of [SINGLE_PUT_MAX_BYTES + 1, 160 * MiB, 160 * MiB + 1, 5 * GiB - 1]) {
      const { partSize, partCount } = partPlan(size);
      let covered = 0;
      for (let n = 1; n <= partCount; n++) {
        const range = partRange(n, partSize, size);
        expect(range.start).toBe(covered);
        if (n < partCount) expect(range.size).toBe(partSize);
        expect(range.size).toBeGreaterThan(0);
        covered = range.end;
      }
      expect(covered).toBe(size);
    }
  });

  it("refuses sizes that aren't multipart and part numbers outside the plan", () => {
    expect(() => partPlan(SINGLE_PUT_MAX_BYTES)).toThrow(RangeError);
    expect(() => partPlan(0)).toThrow(RangeError);
    expect(() => partRange(0, 16 * MiB, 120 * MiB)).toThrow(RangeError);
    expect(() => partRange(9, 16 * MiB, 120 * MiB)).toThrow(RangeError);
  });

  it("hands out at most 20 part URLs at a time, each for an hour", () => {
    expect(PARTS_PER_REQUEST).toBe(20);
    expect(PART_URL_TTL_SECONDS).toBe(3600);
  });
});

describe("checking parts before completion (the lying-client defences)", () => {
  const size = 120 * MiB; // 8 parts: 7 × 16 MiB and 8 MiB
  const plan = partPlan(size);
  const part = (partNumber: number, bytes = partRange(partNumber, plan.partSize, size).size) => ({
    partNumber,
    size: bytes,
    etag: `"etag-${partNumber}"`,
  });
  const all = () => Array.from({ length: plan.partCount }, (_, i) => part(i + 1));

  it("accepts exactly parts 1…N with the planned sizes, and completes with the storage's own list", () => {
    const result = checkParts(all().reverse(), plan, size);
    expect(result).toEqual({ ok: true, parts: all().map((p) => ({ partNumber: p.partNumber, etag: p.etag })) });
  });

  it("reports missing parts without rejecting: the client resumes (T4-M3)", () => {
    const listed = all().filter((p) => p.partNumber !== 3 && p.partNumber !== 8);
    expect(checkParts(listed, plan, size)).toEqual({ ok: false, missing: [3, 8] });
    expect(checkParts([], plan, size)).toEqual({ ok: false, missing: [1, 2, 3, 4, 5, 6, 7, 8] });
  });

  it("rejects a part number beyond the plan (T4-M4)", () => {
    expect(checkParts([...all(), part(9, plan.partSize)], plan, size)).toEqual({ ok: false, invalid: "extra_part" });
  });

  it("rejects a part of the wrong size, even with others missing (T4-M5, T4-M12)", () => {
    const short = all().map((p) => (p.partNumber === 2 ? part(2, 5 * MiB) : p));
    expect(checkParts(short, plan, size)).toEqual({ ok: false, invalid: "part_size" });
    // A 'last' part that isn't the planned remainder.
    const wrongLast = all().map((p) => (p.partNumber === 8 ? part(8, plan.partSize) : p));
    expect(checkParts(wrongLast, plan, size)).toEqual({ ok: false, invalid: "part_size" });
    // Declared 120 MiB, uploaded one 16 MiB part as part 1 and a short last part: refused, not "missing".
    expect(checkParts([part(1), part(8, 1)], plan, size)).toEqual({ ok: false, invalid: "part_size" });
  });

  it("rejects a listing that names a part twice", () => {
    expect(checkParts([...all(), part(4)], plan, size)).toEqual({ ok: false, invalid: "duplicate_part" });
  });
});
