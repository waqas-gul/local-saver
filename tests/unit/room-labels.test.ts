import { describe, expect, it } from "vitest";
import { generateRoomLabel, ROOM_NAME_MAX_LENGTH, roomLabelFrom } from "@/lib/server/rooms/labels";

/** Room names (phase 4 §17.8.4, E18): generated ones like device labels; custom ones cleaned to 1–60 characters. */

describe("room names", () => {
  it("generates two words, never empty", () => {
    expect(generateRoomLabel(() => 0)).toBe("Amber Bay");
    expect(generateRoomLabel(() => 0.999999)).toBe("Warm Willow");
    for (let i = 0; i < 50; i++) expect(generateRoomLabel()).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });

  it("cleans a custom name: NFC, no invisible or bidi characters, single spaces, at most 60 characters", () => {
    expect(roomLabelFrom("  Café   ​club‮ ")).toBe("Café club");
    expect(roomLabelFrom("x".repeat(200))).toHaveLength(ROOM_NAME_MAX_LENGTH);
  });

  it("refuses a name with nothing left after cleaning (400), without echoing it", () => {
    for (const name of ["", "   ", "​‎", "‮"]) {
      expect(() => roomLabelFrom(name)).toThrowError(expect.objectContaining({ status: 400, code: "VALIDATION_FAILED", details: [{ path: "name", code: "too_small" }] }));
    }
  });
});
