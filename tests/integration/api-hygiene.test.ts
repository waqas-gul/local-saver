import { afterAll, describe, expect, it } from "vitest";
import { api, closeAdminDb, Device, newNetwork, signInAnonymously } from "./support/api";

/** API hygiene (09 §4.9) and "no network input" (T-010). */

afterAll(closeAdminDb);

describe("CSRF and content type (T-046)", () => {
  it("rejects mutations without an allowed Origin", async () => {
    const d = await Device.create(newNetwork().ip());
    const body = { destination: "network", content: "x" };
    const none = await d.call("POST", "/api/v1/texts", body, { origin: null });
    expect(none.status).toBe(403);
    expect(none.body.error.code).toBe("FORBIDDEN_ORIGIN");
    const evil = await d.call("POST", "/api/v1/texts", body, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
  });

  it("rejects non-JSON mutation bodies", async () => {
    const d = await Device.create(newNetwork().ip());
    const response = await api("POST", "/api/v1/texts", {
      token: d.token,
      deviceId: d.deviceId,
      ip: d.ip,
      rawBody: "destination=network&content=x",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(response.status).toBe(415);
  });

  it("accepts a body-less DELETE from the app origin but not from elsewhere (DV1-13)", async () => {
    const d = await Device.create(newNetwork().ip());
    const share = await d.postText();
    expect((await d.call("DELETE", `/api/v1/shares/${share.id}`, undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect((await d.call("DELETE", `/api/v1/shares/${share.id}`)).status).toBe(204);
  });
});

describe("caching (T-047)", () => {
  it("marks every API response no-store, including errors", async () => {
    const d = await Device.create(newNetwork().ip());
    for (const response of [
      await d.call("GET", "/api/v1/local/shares"),
      await d.call("GET", "/api/v1/me/shares"),
      await d.call("POST", "/api/v1/network/observe", {}),
      await d.call("GET", `/api/v1/shares/${crypto.randomUUID()}`),
      await api("GET", "/api/v1/local/shares"),
    ]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("authentication and device binding", () => {
  it("requires a valid Supabase session", async () => {
    expect((await api("GET", "/api/v1/local/shares")).status).toBe(401);
    const bad = await api("GET", "/api/v1/local/shares", { token: "not-a-jwt" });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("requires X-Device-Id belonging to the caller", async () => {
    const d = await Device.create(newNetwork().ip());
    const other = await Device.create(newNetwork().ip());
    const missing = await api("GET", "/api/v1/local/shares", { token: d.token, ip: d.ip });
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe("DEVICE_REQUIRED");
    const foreign = await api("GET", "/api/v1/local/shares", { token: d.token, deviceId: other.deviceId, ip: d.ip });
    expect(foreign.status).toBe(401);
    expect(foreign.body.error.code).toBe("DEVICE_UNKNOWN");
  });

  it("registers a device once and returns it again for the same X-Device-Id", async () => {
    const session = await signInAnonymously();
    const first = await api("POST", "/api/v1/devices", { token: session.accessToken, body: {} });
    expect(first.status).toBe(200);
    expect(first.body.device.label).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    const again = await api("POST", "/api/v1/devices", { token: session.accessToken, deviceId: first.body.device.id, body: {} });
    expect(again.body.device.id).toBe(first.body.device.id);
  });

  it("lets a device rename itself, not another user's device", async () => {
    const d = await Device.create(newNetwork().ip());
    const other = await Device.create(newNetwork().ip());
    const renamed = await d.call("PATCH", `/api/v1/devices/${d.deviceId}`, { label: "  Kitchen‮ Laptop  " });
    expect(renamed.status).toBe(200);
    expect(renamed.body.device.label).toBe("Kitchen Laptop");
    expect((await d.call("PATCH", `/api/v1/devices/${other.deviceId}`, { label: "mine now" })).status).toBe(404);
    expect((await d.call("PATCH", `/api/v1/devices/${d.deviceId}`, { label: "" })).status).toBe(400);
  });
});

describe("no network input (T-010)", () => {
  it("rejects body fields naming a network or space", async () => {
    const a = await Device.create(newNetwork().ip());
    const [spaceId] = (await a.observe()).spaceIds;
    const x = await Device.create(newNetwork().ip());
    for (const field of ["spaceId", "networkSpaceId", "networkKey"]) {
      const response = await x.call("POST", "/api/v1/texts", { destination: "network", content: "x", [field]: spaceId });
      expect(response.status, field).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_FAILED");
    }
    const observe = await x.call("POST", "/api/v1/network/observe", { spaceId });
    expect(observe.status).toBe(400);
  });

  it("ignores query parameters naming another network's space", async () => {
    const a = await Device.create(newNetwork().ip());
    const share = await a.postText();
    const [spaceId] = (await a.observe()).spaceIds;
    const x = await Device.create(newNetwork().ip());
    for (const query of [`spaceId=${spaceId}`, `networkSpaceId=${spaceId}`, `space=${spaceId}`]) {
      const feed = await x.call("GET", `/api/v1/local/shares?${query}`);
      expect(feed.status).toBe(200);
      expect((feed.body.shares as { id: string }[]).map((s) => s.id)).not.toContain(share.id);
    }
  });

  it("ignores headers that try to pick a client IP", async () => {
    const home = newNetwork();
    const a = await Device.create(home.ip());
    const share = await a.postText();
    const x = await Device.create(newNetwork().ip());
    const spoofed = await x.call("GET", "/api/v1/local/shares", undefined, {
      headers: { "x-forwarded-for": home.ip(), "x-real-ip": home.ip(), "cf-connecting-ip": home.ip() },
    });
    expect((spoofed.body.shares as { id: string }[]).map((s) => s.id)).not.toContain(share.id);
  });
});

describe("rate limits (T-049)", () => {
  it("answers 429 with Retry-After once observe exceeds 30 per minute", async () => {
    const d = await Device.create(newNetwork().ip(), { observe: false });
    // Fixed one-minute windows: start early in a minute so all 31 calls share one window.
    const second = new Date().getUTCSeconds();
    if (second > 40) await new Promise((resolve) => setTimeout(resolve, (61 - second) * 1000));
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 31; i++) {
      const response = await d.call("POST", "/api/v1/network/observe", {});
      statuses.push(response.status);
      if (response.status === 429) {
        retryAfter = response.headers.get("retry-after");
        expect(response.body.error.code).toBe("RATE_LIMITED");
      }
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    expect(Number(retryAfter)).toBeLessThanOrEqual(60);
  });
});
