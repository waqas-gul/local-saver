import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { IntegrationNotConfiguredError } from "@/lib/server/config/integrations";
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

  // P4-21: a merge or an account deletion took the caller's user away while its write ran.
  it("answers a write whose own user went away mid-request as the next request would (401 DEVICE_UNKNOWN); other FK errors stay 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fkError = (constraint: string, table: string) =>
      Object.assign(new Error(`insert or update violates foreign key constraint "${constraint}"`), {
        code: "23503",
        constraint,
        detail: `Key (x)=(00000000-0000-4000-8000-000000000000) is not present in table "${table}".`,
      });
    const gone = await withApi(async () => {
      throw fkError("room_members_user_id_fkey", "users");
    })(post("{}"), undefined);
    expect(gone.status).toBe(401);
    expect((await gone.json()).error.code).toBe("DEVICE_UNKNOWN");
    const other = await withApi(async () => {
      throw fkError("downloads_share_id_fkey", "shares");
    })(post("{}"), undefined);
    expect(other.status).toBe(500);
  });

  it("accepts a body-less DELETE from an allowed Origin without a content type (DV1-13)", async () => {
    const handler = withApi(async () => new Response(null, { status: 204 }));
    const ok = await handler(new Request(`${ORIGIN}/api/v1/test`, { method: "DELETE", headers: { origin: ORIGIN } }), undefined);
    expect(ok.status).toBe(204);
    const foreign = await handler(
      new Request(`${ORIGIN}/api/v1/test`, { method: "DELETE", headers: { origin: "https://evil.example" } }),
      undefined,
    );
    expect(foreign.status).toBe(403);
    const withForm = await handler(
      new Request(`${ORIGIN}/api/v1/test`, {
        method: "DELETE",
        headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: "a=1",
      }),
      undefined,
    );
    expect(withForm.status).toBe(415);
  });

  it("sends headers attached to an ApiError, such as Retry-After", async () => {
    const handler = withApi(async () => {
      throw new ApiError(429, "RATE_LIMITED", "Too many requests", undefined, { "Retry-After": "17" });
    });
    const response = await handler(new Request(`${ORIGIN}/api/v1/test`), undefined);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
  });

  it("answers 503 when an integration is not configured, naming no secrets", async () => {
    const handler = withApi(async () => {
      throw new IntegrationNotConfiguredError("R2", ["R2_BUCKET"]);
    });
    const response = await handler(new Request(`${ORIGIN}/api/v1/test`), undefined);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("SERVICE_NOT_CONFIGURED");
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

  it("stops reading a streamed body without Content-Length once it passes the limit", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 1000) controller.close();
        else controller.enqueue(new Uint8Array(1024));
      },
    });
    const request = new Request(`${ORIGIN}/api/v1/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    await expect(readJson(request, schema, { maxBytes: 4096 })).rejects.toMatchObject({ status: 413 });
    expect(pulled).toBeLessThan(20);
  });

  it("returns 413 for bodies above the limit", async () => {
    const big = JSON.stringify({ name: "x".repeat(2000) });
    await expect(readJson(post(big), schema, { maxBytes: 1000 })).rejects.toMatchObject({
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
    });
  });
});
