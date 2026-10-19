import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiRequestError } from "@/lib/client/api-error";
import { createApiClient } from "@/lib/client/api-client";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const errorBody = (code: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message: "nope", requestId: "req-1", ...extra },
});

function client(responses: Response[], tokens = ["t1", "t2"]) {
  const fetcher = fakeFetch(responses);
  const auth = {
    getAccessToken: vi.fn(async () => tokens[0] as string),
    refreshAccessToken: vi.fn(async () => tokens[1] as string),
  };
  const api = createApiClient({ auth, getDeviceId: () => "device-1", fetch: fetcher.fn });
  return { api, auth, calls: fetcher.calls };
}

describe("createApiClient", () => {
  it("sends the bearer token, device ID and a JSON body, and parses the response", async () => {
    const { api, calls } = client([json(200, { value: 1 })]);
    const result = await api.request("POST", "/api/v1/x", { body: { a: 1 }, schema: z.object({ value: z.number() }) });
    expect(result).toEqual({ value: 1 });
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer t1");
    expect(headers.get("x-device-id")).toBe("device-1");
    expect(headers.get("content-type")).toBe("application/json");
    expect(calls[0]?.init.body).toBe('{"a":1}');
  });

  it("refreshes the session once after a 401 and retries", async () => {
    const { api, auth, calls } = client([json(401, errorBody("UNAUTHENTICATED")), json(200, { ok: true })]);
    await expect(api.request("GET", "/api/v1/x", { schema: z.object({ ok: z.boolean() }) })).resolves.toEqual({ ok: true });
    expect(auth.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(new Headers(calls[1]?.init.headers).get("authorization")).toBe("Bearer t2");
  });

  // Phase 4A: a new Auth session of the same user (an upgrade, an email change) needs the device
  // rebound to it; until the runtime has done so, the server answers DEVICE_UNKNOWN.
  it("re-registers the device once after 401 DEVICE_UNKNOWN and retries", async () => {
    const fetcher = fakeFetch([json(401, errorBody("DEVICE_UNKNOWN")), json(200, { ok: true })]);
    const recoverDevice = vi.fn(async () => true);
    const api = createApiClient({
      auth: { getAccessToken: async () => "t1", refreshAccessToken: async () => "t2" },
      getDeviceId: () => "device-1",
      recoverDevice,
      fetch: fetcher.fn,
    });
    await expect(api.request("GET", "/api/v1/x", { schema: z.object({ ok: z.boolean() }) })).resolves.toEqual({ ok: true });
    expect(recoverDevice).toHaveBeenCalledTimes(1);
    expect(fetcher.calls).toHaveLength(2);
  });

  it("doesn't retry DEVICE_UNKNOWN when the device can't be recovered, or a second time", async () => {
    const unrecovered = fakeFetch([json(401, errorBody("DEVICE_UNKNOWN"))]);
    const api = createApiClient({
      auth: { getAccessToken: async () => "t1", refreshAccessToken: async () => "t2" },
      getDeviceId: () => "device-1",
      recoverDevice: async () => false,
      fetch: unrecovered.fn,
    });
    await expect(api.request("GET", "/api/v1/x")).rejects.toMatchObject({ code: "DEVICE_UNKNOWN" });
    expect(unrecovered.calls).toHaveLength(1);

    const twice = fakeFetch([json(401, errorBody("DEVICE_UNKNOWN")), json(401, errorBody("DEVICE_UNKNOWN"))]);
    const recoverDevice = vi.fn(async () => true);
    const again = createApiClient({
      auth: { getAccessToken: async () => "t1", refreshAccessToken: async () => "t2" },
      getDeviceId: () => "device-1",
      recoverDevice,
      fetch: twice.fn,
    });
    await expect(again.request("GET", "/api/v1/x")).rejects.toMatchObject({ code: "DEVICE_UNKNOWN" });
    expect(recoverDevice).toHaveBeenCalledTimes(1);
    expect(twice.calls).toHaveLength(2);
  });

  it("tells the runtime when the session must confirm with its authenticator (P4-24), without retrying", async () => {
    const fetcher = fakeFetch([json(403, errorBody("MFA_REQUIRED"))]);
    const onMfaRequired = vi.fn();
    const onDeviceRevoked = vi.fn();
    const api = createApiClient({
      auth: { getAccessToken: async () => "t1", refreshAccessToken: async () => "t2" },
      getDeviceId: () => "device-1",
      onMfaRequired,
      onDeviceRevoked,
      fetch: fetcher.fn,
    });
    await expect(api.request("GET", "/api/v1/x")).rejects.toMatchObject({ status: 403, code: "MFA_REQUIRED" });
    expect(onMfaRequired).toHaveBeenCalledTimes(1);
    expect(onDeviceRevoked).not.toHaveBeenCalled();
    expect(fetcher.calls).toHaveLength(1);
  });

  it("gives up after a second 401", async () => {
    const { api } = client([json(401, errorBody("UNAUTHENTICATED")), json(401, errorBody("UNAUTHENTICATED"))]);
    await expect(api.request("GET", "/api/v1/x")).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  });

  it("turns error bodies into ApiRequestError with details and Retry-After", async () => {
    const { api } = client([json(429, errorBody("RATE_LIMITED", { details: { a: 1 } }), { "retry-after": "12" })]);
    const error = await api.request("GET", "/api/v1/x").catch((e) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 429, code: "RATE_LIMITED", requestId: "req-1", details: { a: 1 }, retryAfterSeconds: 12 });
  });

  it("returns undefined for 204", async () => {
    const { api } = client([new Response(null, { status: 204 })]);
    await expect(api.request("DELETE", "/api/v1/x")).resolves.toBeUndefined();
  });

  it("rejects responses that don't match the contract", async () => {
    const { api } = client([json(200, { value: "one" })]);
    await expect(api.request("GET", "/api/v1/x", { schema: z.object({ value: z.number() }) })).rejects.toThrow();
  });

  it("reports non-JSON failures with a generic code", async () => {
    const { api } = client([new Response("<html>bad gateway</html>", { status: 502 })]);
    await expect(api.request("GET", "/api/v1/x")).rejects.toMatchObject({ status: 502, code: "HTTP_502" });
  });
});
