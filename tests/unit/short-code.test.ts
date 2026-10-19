import { describe, expect, it } from "vitest";
import { formatShortCode, normalizeShortCode, SHORT_CODE_ALPHABET, SHORT_CODE_LENGTH } from "@/lib/shared/short-code";

/** Short codes (DEC-014, 03 §4.4, T-032 unit part): Crockford Base32, 10 characters (50 bits). */

describe("short codes", () => {
  it("use the 32-character Crockford alphabet without I, L, O and U", () => {
    expect(SHORT_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(SHORT_CODE_ALPHABET).size).toBe(32);
    for (const letter of ["I", "L", "O", "U"]) expect(SHORT_CODE_ALPHABET).not.toContain(letter);
    expect(SHORT_CODE_LENGTH).toBe(10);
  });

  it("display as two groups of five", () => {
    expect(formatShortCode("7KQ4MX9D2P")).toBe("7KQ4M-X9D2P");
  });

  it("normalize case, spaces and hyphens", () => {
    expect(normalizeShortCode("7kq4m-x9d2p")).toBe("7KQ4MX9D2P");
    expect(normalizeShortCode(" 7KQ4M X9D2P ")).toBe("7KQ4MX9D2P");
    expect(normalizeShortCode("7KQ4M–X9D2P")).toBe("7KQ4MX9D2P"); // en dash from a phone keyboard
    expect(normalizeShortCode("7KQ4M X9D2P")).toBe("7KQ4MX9D2P"); // non-breaking space
  });

  it("map O to 0 and I or L to 1", () => {
    expect(normalizeShortCode("OOOOO-IIIII")).toBe("0000011111");
    expect(normalizeShortCode("ooooo-lllll")).toBe("0000011111");
  });

  it("reject anything that is not exactly ten valid characters", () => {
    expect(normalizeShortCode("")).toBeNull();
    expect(normalizeShortCode("7KQ4M-X9D2")).toBeNull();
    expect(normalizeShortCode("7KQ4M-X9D2PP")).toBeNull();
    expect(normalizeShortCode("7KQ4M-X9D2U")).toBeNull(); // U is not in the alphabet
    expect(normalizeShortCode("7KQ4M/X9D2P")).toBeNull();
    expect(normalizeShortCode("7KQ4M-X9D2P‮")).toBeNull();
  });
});
