import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/client/api-error";
import { queryKeys } from "@/lib/client/queries/keys";
import { fetchViewerContent } from "@/lib/client/queries/links";
import { createViewerApiClient } from "@/lib/client/viewer-api";

/** Link-viewer client (Phase 2): no credentials but the cookie, and ended links replace cached content (DEC-034 rule 4). */

const error = (status: number, code: string) =>
  new Response(JSON.stringify({ error: { code, message: "m", requestId: "r" } }), { status, headers: { "content-type": "application/json" } });

describe("viewer API client and content", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends no bearer token and no device ID, and keeps cookies same-origin", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ linkId: "AAAAAAAAAAAAAAAA" }), { status: 200 }));
    await createViewerApiClient(fetcher).request("POST", "/api/v1/codes/resolve", { body: { code: "x" } });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-device-id")).toBe(false);
    expect(init.credentials).toBe("same-origin");
    expect(init.cache).toBe("no-store");
  });

  it("turns 404 and 410 into an ended result instead of keeping old content", async () => {
    for (const [status, code] of [[404, "LINK_UNAVAILABLE"], [410, "LINK_EXPIRED"]] as const) {
      const api = createViewerApiClient(async () => error(status, code));
      const result = await fetchViewerContent(api, "AAAAAAAAAAAAAAAA");
      expect(result.content).toBeNull();
      expect(result.ended).toBeInstanceOf(ApiRequestError);
      expect(result.ended?.status).toBe(status);
    }
  });

  // Phase 4 (P4-16): a browser that must prove a (new) password keeps nothing of the share meanwhile.
  it("treats 409 PASSWORD_REQUIRED the same way: the cached content is replaced and polling stops", async () => {
    const api = createViewerApiClient(async () => error(409, "PASSWORD_REQUIRED"));
    const result = await fetchViewerContent(api, "AAAAAAAAAAAAAAAA");
    expect(result.content).toBeNull();
    expect(result.ended).toMatchObject({ status: 409, code: "PASSWORD_REQUIRED" });
    // Any other 409 is not an answer about access: it is rethrown.
    await expect(fetchViewerContent(createViewerApiClient(async () => error(409, "SOMETHING_ELSE")), "AAAAAAAAAAAAAAAA")).rejects.toMatchObject({ status: 409 });
  });

  it("rethrows other failures so they can be retried", async () => {
    const api = createViewerApiClient(async () => error(503, "REMOTE_LINKS_DISABLED"));
    await expect(fetchViewerContent(api, "AAAAAAAAAAAAAAAA")).rejects.toMatchObject({ status: 503 });
  });

  it("keeps link-viewer and creator link keys out of the network-scoped keys", () => {
    expect(queryKeys.linkContent("L")[0]).toBe("link");
    expect(queryKeys.shareLinks("S").slice(0, 2)).toEqual(["me", "links"]);
  });
});
