import { randomBytes } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { adminDb, closeAdminDb, Device, newNetwork, setFlag, turnstilePass, Viewer } from "./support/api";

/**
 * Short codes (DEC-014, 03 §4.4, T-032): normalization, expiry, regeneration, failure limits
 * with Turnstile escalation and the 24-hour block, and never revealing the link secret.
 */

afterAll(closeAdminDb);
afterEach(async () => {
  await setFlag("remote_links_enabled", true);
  await setFlag("short_codes_enabled", true);
});

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** A well-formed code that (almost certainly) belongs to no link. */
const randomCode = () => Array.from({ length: 10 }, () => ALPHABET[Math.floor(Math.random() * 32)]).join("");

async function linkWithCode(body: { expiresIn?: number } = {}) {
  const creator = await Device.create(newNetwork().ip());
  const share = await creator.postText(`code ${randomBytes(3).toString("hex")}`);
  const link = await creator.createLink(share.id, { shortCode: body });
  return { creator, share, link, code: link.shortCode!.code };
}

describe("short codes resolve to a grant, never to the secret (T-032)", () => {
  it("are ten Crockford characters shown as XXXXX-XXXXX, valid for 1 hour by default", async () => {
    const { link, code } = await linkWithCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    const ttl = new Date(link.shortCode!.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(55 * 60_000);
    expect(ttl).toBeLessThanOrEqual(60 * 60_000);
  });

  it("accept the code however it is typed, and return only the link ID and a session cookie", async () => {
    const { link, code } = await linkWithCode();
    const typed = ` ${code.toLowerCase().replace("-", " - ")} `.replace(/0/g, "o").replace(/1/g, "l");
    const viewer = new Viewer();
    const resolved = await viewer.resolve(typed);
    expect(resolved.status).toBe(200);
    expect(resolved.body).toEqual({ linkId: link.id });
    expect(resolved.text).not.toContain(link.secret);
    expect(resolved.headers.get("set-cookie")).toMatch(/^link_session=/);
    const content = await viewer.content(link.id);
    expect(content.status).toBe(200);
    expect(content.text).not.toContain(link.secret);
  });

  it("stop working when they expire, when replaced, or when the link is revoked", async () => {
    const expired = await linkWithCode();
    await adminDb().query("update app.share_links set short_code_expires_at = now() - interval '1 second' where id = $1", [expired.link.id]);
    const late = await new Viewer().resolve(expired.code);
    expect(late.status).toBe(404);
    expect(late.body.error.code).toBe("CODE_UNAVAILABLE");

    const replaced = await linkWithCode();
    const fresh = await replaced.creator.call("POST", `/api/v1/links/${replaced.link.id}/code`, { expiresIn: 600 });
    expect(fresh.status).toBe(200);
    expect(fresh.body.shortCode.code).not.toBe(replaced.code);
    expect(fresh.text).not.toContain(replaced.link.secret);
    expect((await new Viewer().resolve(replaced.code)).status).toBe(404);
    expect((await new Viewer().resolve(fresh.body.shortCode.code)).status).toBe(200);

    const revoked = await linkWithCode();
    await revoked.creator.call("DELETE", `/api/v1/links/${revoked.link.id}`);
    expect((await new Viewer().resolve(revoked.code)).status).toBe(404);
    expect((await revoked.creator.call("POST", `/api/v1/links/${revoked.link.id}/code`, {})).status).toBe(409);
  });

  it("never outlive their link, and Free codes last at most 24 hours", async () => {
    const creator = await Device.create(newNetwork().ip());
    const share = await creator.postText("brief", 3600);
    const link = await creator.createLink(share.id, { shortCode: { expiresIn: 86400 } });
    expect(new Date(link.shortCode!.expiresAt).getTime()).toBeLessThanOrEqual(new Date(link.expiresAt).getTime());
    const tooLong = await creator.call("POST", `/api/v1/shares/${share.id}/links`, { shortCode: { expiresIn: 2 * 86400 } });
    expect(tooLong.status).toBe(422);
  });
});

describe("guessing limits (03 §4.4, §10)", () => {
  it("after 5 failures in 10 minutes, every attempt needs Turnstile", async () => {
    const { link, code } = await linkWithCode();
    const net = newNetwork();
    const guesser = () => new Viewer(net.ip());
    for (let i = 0; i < 5; i++) expect((await guesser().resolve(randomCode())).status).toBe(404);

    const challenged = await guesser().resolve(code);
    expect(challenged.status).toBe(403);
    expect(challenged.body.error).toMatchObject({ code: "TURNSTILE_REQUIRED", details: { turnstile: true } });
    expect((await guesser().resolve(code, "fail-token")).status).toBe(403);

    expect((await guesser().resolve(randomCode(), turnstilePass())).status).toBe(404);
    const token = turnstilePass();
    const solved = await guesser().resolve(code, token);
    expect(solved.status).toBe(200);
    expect(solved.body).toEqual({ linkId: link.id });
    // Tokens are single use.
    expect((await guesser().resolve(code, token)).status).toBe(403);

    // Another network is unaffected.
    expect((await new Viewer().resolve(code)).status).toBe(200);
    const { rows } = await adminDb().query(
      "select count(*)::int as n from app.audit_events where action = 'code.resolve_failed' and occurred_at > now() - interval '1 minute'",
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("counts failures per link session too, even across networks", async () => {
    const { code } = await linkWithCode();
    const { link: other } = await linkWithCode();
    const viewer = new Viewer();
    // A session first: open another link.
    const otherCode = other.shortCode!.code;
    expect((await viewer.resolve(otherCode)).status).toBe(200);
    for (let i = 0; i < 5; i++) {
      viewer.ip = newNetwork().ip();
      expect((await viewer.resolve(randomCode())).status).toBe(404);
    }
    viewer.ip = newNetwork().ip();
    expect((await viewer.resolve(code)).status).toBe(403);
  });

  it("20 failures in a day block the network for 24 hours, whatever the code", { timeout: 60_000 }, async () => {
    const { code } = await linkWithCode();
    const net = newNetwork();
    for (let i = 0; i < 20; i++) {
      const response = await new Viewer(net.ip()).resolve(randomCode(), i >= 5 ? turnstilePass() : undefined);
      expect(response.status, `attempt ${i + 1}`).toBe(404);
    }
    const blocked = await new Viewer(net.ip()).resolve(code, turnstilePass());
    expect(blocked.status).toBe(429);
    const retryAfter = Number(blocked.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(23 * 3600);
    expect(retryAfter).toBeLessThanOrEqual(24 * 3600);
  });

  it("malformed input counts as a failure and reveals nothing", async () => {
    const response = await new Viewer().resolve("not a code at all");
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("CODE_UNAVAILABLE");
  });
});

describe("kill switches", () => {
  it("short codes off: no new codes and no resolution; links keep working", async () => {
    const { creator, share, link, code } = await linkWithCode();
    await setFlag("short_codes_enabled", false);
    const resolve = await new Viewer().resolve(code);
    expect(resolve.status).toBe(503);
    expect(resolve.body.error.code).toBe("SHORT_CODES_DISABLED");
    expect((await creator.call("POST", `/api/v1/shares/${share.id}/links`, { shortCode: {} })).status).toBe(503);
    expect((await creator.call("POST", `/api/v1/links/${link.id}/code`, {})).status).toBe(503);
    expect((await creator.call("POST", `/api/v1/shares/${share.id}/links`, {})).status).toBe(201);
    expect((await new Viewer().unlock(link.id, link.secret)).status).toBe(200);
  });

  it("remote links off: codes stop too", async () => {
    const { code } = await linkWithCode();
    await setFlag("remote_links_enabled", false);
    expect((await new Viewer().resolve(code)).status).toBe(503);
  });
});
