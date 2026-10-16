import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnv } from "@/lib/server/env";
import { verifyTurnstile } from "@/lib/server/security/turnstile";

/** Server-side Turnstile verification (DV2-6): fail closed on anything but a clear success. */

const configured = parseEnv({
  NEXT_PUBLIC_APP_ORIGIN: "https://app.example.com",
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "site-key",
  TURNSTILE_SECRET_KEY: "turnstile-secret",
});

function respond(body: unknown, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe("verifyTurnstile", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts the secret and token to siteverify and accepts a success", async () => {
    const fetchMock = respond({ success: true, hostname: "app.example.com" });
    await expect(verifyTurnstile(configured, "token-1")).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("secret")).toBe("turnstile-secret");
    expect(body.get("response")).toBe("token-1");
    // The client address is not sent.
    expect(body.has("remoteip")).toBe(false);
  });

  it("refuses failures, other hostnames, server errors and network errors", async () => {
    respond({ success: false });
    await expect(verifyTurnstile(configured, "t")).resolves.toBe(false);
    respond({ success: true, hostname: "evil.example.net" });
    await expect(verifyTurnstile(configured, "t")).resolves.toBe(false);
    respond({ success: true }, 500);
    await expect(verifyTurnstile(configured, "t")).resolves.toBe(false);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await expect(verifyTurnstile(configured, "t")).resolves.toBe(false);
  });

  it("refuses a missing or oversized token without calling Cloudflare", async () => {
    const fetchMock = respond({ success: true });
    await expect(verifyTurnstile(configured, undefined)).resolves.toBe(false);
    await expect(verifyTurnstile(configured, "x".repeat(2049))).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses everything when no secret is configured", async () => {
    const fetchMock = respond({ success: true });
    await expect(verifyTurnstile(parseEnv({}), "t")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
