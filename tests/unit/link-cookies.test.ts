import { describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/server/env";
import { hashSessionToken, linkSessionCookie, readLinkSessionToken } from "@/lib/server/links/cookies";

/** Viewer session cookie (03 §4.2, DV2-3). */

const https = parseEnv({ NEXT_PUBLIC_APP_ORIGIN: "https://app.example.com" });
const http = parseEnv({ NEXT_PUBLIC_APP_ORIGIN: "http://127.0.0.1:3200" });
const TOKEN = "t".repeat(43);

function request(cookie: string): Request {
  return new Request("https://app.example.com/api/v1/links/x/content", { headers: { cookie } });
}

describe("link session cookie", () => {
  it("is __Host-link_session: Secure, HttpOnly, SameSite=Lax, Path=/ and no Domain over HTTPS", () => {
    const value = linkSessionCookie(https, TOKEN, 43200);
    expect(value).toBe(`__Host-link_session=${TOKEN}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax`);
    expect(value).not.toMatch(/Domain=/i);
  });

  it("drops the __Host- prefix and Secure only on plain-HTTP origins (local development and tests)", () => {
    expect(linkSessionCookie(http, TOKEN, 60)).toBe(`link_session=${TOKEN}; Path=/; Max-Age=60; HttpOnly; SameSite=Lax`);
  });

  it("reads only this environment's cookie name and a well-formed token", () => {
    expect(readLinkSessionToken(request(`a=b; __Host-link_session=${TOKEN}`), https)).toBe(TOKEN);
    expect(readLinkSessionToken(request(`link_session=${TOKEN}`), https)).toBeNull();
    expect(readLinkSessionToken(request(`link_session=${TOKEN}`), http)).toBe(TOKEN);
    expect(readLinkSessionToken(request("__Host-link_session=short"), https)).toBeNull();
    expect(readLinkSessionToken(request(`__Host-link_session=${TOKEN}x`), https)).toBeNull();
    expect(readLinkSessionToken(new Request("https://app.example.com/"), https)).toBeNull();
  });

  it("is stored only as a SHA-256 hash", () => {
    const hash = hashSessionToken(TOKEN);
    expect(hash).toHaveLength(32);
    expect(hash.toString("hex")).not.toContain(Buffer.from(TOKEN).toString("hex"));
  });
});
