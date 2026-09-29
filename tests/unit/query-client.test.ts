import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/lib/client/api-error";
import { getQueryClient, makeQueryClient, shouldRetry } from "@/lib/client/query-client";

describe("shouldRetry (DEC-034 rule 8)", () => {
  it.each([400, 401, 403, 404, 409, 410, 413, 415, 422, 429])("never retries HTTP %i automatically", (status) => {
    expect(shouldRetry(0, new ApiRequestError(status, "X", "x"))).toBe(false);
  });

  it("retries server and network errors up to three times", () => {
    expect(shouldRetry(0, new ApiRequestError(503, "X", "x"))).toBe(true);
    expect(shouldRetry(2, new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldRetry(3, new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("query client", () => {
  it("uses the agreed defaults", () => {
    const client = makeQueryClient();
    const defaults = client.getDefaultOptions();
    expect(defaults.queries?.staleTime).toBe(30_000);
    expect(defaults.queries?.retry).toBe(shouldRetry);
    expect(defaults.mutations?.retry).toBe(false);
  });

  it("creates a new client for every server render (no window)", () => {
    expect(getQueryClient()).not.toBe(getQueryClient());
  });
});
