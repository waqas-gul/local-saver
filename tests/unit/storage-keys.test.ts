import { describe, expect, it } from "vitest";
import { isValidObjectKey, objectKey, retentionClassFor, storedContentType } from "@/lib/server/storage/keys";

const FILE_ID = "3f0c2a4e-8b6d-4c1e-9a57-0e5d1f7b2c90";

describe("object keys (DEC-010, T-024)", () => {
  it("builds {class}/{yyyy}/{mm}/{dd}/{fileId} from the UTC date, with no filename", () => {
    const key = objectKey("d7", new Date("2026-09-17T23:30:00-02:00"), FILE_ID);
    expect(key).toBe(`d7/2026/09/18/${FILE_ID}`);
    expect(isValidObjectKey(key)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isValidObjectKey(`d7/2026/09/18/${FILE_ID}.pdf`)).toBe(false);
    expect(isValidObjectKey(`uploads/report.pdf`)).toBe(false);
    expect(isValidObjectKey(`d7/2026/09/18/../${FILE_ID}`)).toBe(false);
    expect(() => objectKey("d7", new Date(), "not-a-uuid")).toThrow();
  });

  it("picks the smallest retention class that covers the expiry", () => {
    expect(retentionClassFor(3600)).toBe("d7");
    expect(retentionClassFor(7 * 86400)).toBe("d7");
    expect(retentionClassFor(7 * 86400 + 1)).toBe("d30");
    expect(retentionClassFor(90 * 86400)).toBe("d90");
    expect(() => retentionClassFor(91 * 86400)).toThrow();
  });
});

describe("storedContentType (04 §8.4)", () => {
  it("keeps the declared type only for previewable raster images", () => {
    expect(storedContentType("image/png")).toBe("image/png");
    expect(storedContentType("IMAGE/JPEG")).toBe("image/jpeg");
    expect(storedContentType("image/svg+xml")).toBe("application/octet-stream");
    expect(storedContentType("text/html")).toBe("application/octet-stream");
    expect(storedContentType("application/pdf")).toBe("application/octet-stream");
    expect(storedContentType("")).toBe("application/octet-stream");
  });
});
