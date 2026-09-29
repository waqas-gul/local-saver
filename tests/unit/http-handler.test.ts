import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { resetEnvCache } from "@/lib/server/env";
import { ApiError } from "@/lib/server/http/errors";
import { withApi } from "@/lib/server/http/handler";
import { readJson } from "@/lib/server/http/body";
import { isRequestId } from "@/lib/server/security/ids";

const ORIGIN = "http://localhost:3000";

function post(body: string, init: { origin?: string | null; contentType?: string } = {}) {
  const headers = new Headers();
  if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
  headers.set("content-type", init.contentType ?? "application/json");
  return new Request(`${ORIGIN}/api/v1/test`, { method: "POST", headers, body });
}

describe("withApi", () => {
  afterEach(() => resetEnvCache());

  it("returns JSON with no-store and a request ID", async () => {
    const handler = withApi(async () => ({ hello: "world" }));
    const response = await handler(new Request(`${ORIGIN}/api/v1/test`), undefined);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hello: "world" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(isRequestId(response.headers.get("x-request-id") ?? "")).toBe(true);
  });

  it("reuses a valid request ID set by the proxy", async () => {
    const id = "0f5e2f43-4a51-4b16-9f6b-3f1f2f7d9a10";
    const handler = withApi(async ({ requestId }) => ({ requestId }));
    const response = await handler(new Request(`${ORIGIN}/api/v1/test`, { headers: { "x-request-id": id } }), undefined);
    expect(response.headers.get("x-request-id")).toBe(id);
    expect(await response.json()).toEqual({ requestId: id });
  });

  it("rejects mutations without an allowed Origin (T-046)", async () => {
    const handler = withApi(async () => ({ ok: true }));
    const missing = await handler(post("{}", { origin: null }), undefined);
    const foreign = await handler(post("{}", { origin: "https://evil.example" }), undefined);
    expect(missing.status).toBe(403);
    expect(foreign.status).toBe(403);
    expect((await foreign.json()).error.code).toBe("FORBIDDEN_ORIGIN");
  });

  it("rejects mutations that are not JSON (T-046)", async () => {
    const handler = withApi(async () => ({ ok: true }));
    const response = await handler(post("a=1", { contentType: "application/x-www-form-urlencoded" }), undefined);
    expect(response.status).toBe(415);
    expect((await response.json()).error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("accepts JSON mutations from an allowed Origin", async () => {
    const handler = withApi(async () => ({ ok: true }));
    const response = await handler(post("{}", { contentType: "application/json; charset=utf-8" }), undefined);
    expect(response.status).toBe(200);
  });

  it("maps ApiError to the documented error body", async () => {
    const handler = withApi(async () => {
      throw new ApiError(404, "NOT_FOUND", "Not found");
    });
    const response = await handler(new Request(`${ORIGIN}/api/v1/test`), undefined);
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error).toMatchObject({ code: "NOT_FOUND", message: "Not found" });
    expect(isRequestId(body.error.requestId)).toBe(true);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("hides unexpected errors behind a generic 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = withApi(async () => {
      throw new Error("database password is hunter2");
    });
    const response = await handler(new Request(`${ORIGIN}/api/v1/test`), undefined);
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).toContain("INTERNAL_ERROR");
    expect(text).not.toContain("hunter2");
  });

  it("passes Response objects through and adds the standard headers", async () => {
    const handler = withApi(async () => new Response("plain", { status: 202 }));
    const response = await handler(new Request(`${ORIGIN}/api/v1/test`), undefined);
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });
});

describe("readJson", () => {
  const schema = z.object({ name: z.string().min(1) }).strict();

  it("parses and validates a body", async () => {
    await expect(readJson(post(JSON.stringify({ name: "a" })), schema)).resolves.toEqual({ name: "a" });
  });

  it("returns 400 for malformed JSON", async () => {
    await expect(readJson(post("{"), schema)).rejects.toMatchObject({ status: 400, code: "INVALID_JSON" });
  });

  it("returns 400 for schema violations without echoing input values", async () => {
    const error = await readJson(post(JSON.stringify({ name: "", secret: "hunter2" })), schema).catch((e) => e);
    expect(error).toMatchObject({ status: 400, code: "VALIDATION_FAILED" });
    expect(JSON.stringify(error.details)).not.toContain("hunter2");
  });

  it("returns 413 for bodies above the limit", async () => {
    const big = JSON.stringify({ name: "x".repeat(2000) });
    await expect(readJson(post(big), schema, { maxBytes: 1000 })).rejects.toMatchObject({
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
    });
  });
});
