import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { signInByCode } from "./support/accounts";
import { accountDevice, proDevice } from "./support/entitlements";
import { adminDb, closeAdminDb, Device, newNetwork, PNG_BYTES, stack, turnstilePass, Viewer, type ApiResponse } from "./support/api";

/**
 * Link passwords (P4-16, phase 4 §17.8.3, §17.19.5, AC-4.6). A password link needs the link's secret (or a
 * short code) AND the password. The password is checked on the grant, in accessFor, so on every viewer
 * request whatever made the grant (C4-8): T4-P1 … P7 and P9, the creator's side (E11), IDOR, the attempt
 * limits under concurrency and a password change racing a verification.
 */

afterAll(closeAdminDb);

const PASSWORD = "violet harbour 71";
const OTHER = "copper lantern 42";
const DB_CONTAINER = "supabase_db_local-saver";

type Created = Awaited<ReturnType<Device["createLink"]>>;

/** A Pro creator (override) and a link-only text behind a password link. */
async function passwordText(options: { shortCode?: boolean; password?: string } = {}) {
  const pro = await proDevice(newNetwork().ip());
  const share = await pro.device.postText(`behind a password ${randomBytes(3).toString("hex")}`, undefined, "link_only");
  const link = await pro.device.createLink(share.id, { password: options.password ?? PASSWORD, ...(options.shortCode ? { shortCode: {} } : {}) });
  return { pro, share, link };
}

/** A Pro creator and an image share (link only) behind a password link: content, download and preview. */
async function passwordImage() {
  const pro = await proDevice(newNetwork().ip());
  const upload = await pro.device.uploadFile("photo.png", PNG_BYTES, "image/png", PNG_BYTES.length, "link_only");
  expect(upload.complete.status).toBe(200);
  const shareId = upload.init.body.share.id as string;
  const link = await pro.device.createLink(shareId, { password: PASSWORD });
  return { pro, shareId, fileId: upload.upload.fileId, link };
}

/** A viewer whose grant for `link` exists but hasn't proved the password. */
async function unverifiedViewer(link: Created, ip?: string) {
  const viewer = new Viewer(ip ?? newNetwork().ip());
  const unlocked = await viewer.unlock(link.id, link.secret);
  expect(unlocked.status, unlocked.text).toBe(409);
  return viewer;
}

async function verifiedViewer(link: Created) {
  const viewer = await unverifiedViewer(link);
  expect((await viewer.password(link.id, PASSWORD)).status).toBe(204);
  return viewer;
}

const code = (response: ApiResponse) => response.body?.error?.code as string | undefined;

async function linkRow(linkId: string) {
  const { rows } = await adminDb().query(
    "select password_hash, password_version, password_set_at, password_locked_until from app.share_links where id = $1",
    [linkId],
  );
  return rows[0] as { password_hash: string | null; password_version: number; password_set_at: Date | null; password_locked_until: Date | null };
}

/** A link's recent failures (every window of its counter). */
async function failures(linkId: string): Promise<number> {
  const { rows } = await adminDb().query("select coalesce(sum(value), 0)::int as n from app.rate_counters where key = $1", [`pwFail:${linkId}`]);
  return rows[0].n as number;
}

async function grantRows(linkId: string) {
  const { rows } = await adminDb().query("select password_version, password_verified_at from app.link_grants where link_id = $1", [linkId]);
  return rows as { password_version: number; password_verified_at: Date | null }[];
}

/** The viewer routes under /links/{linkId}: everything but the creator's (PATCH/DELETE, code) and the two ways in (unlock, password). */
function viewerLinkRoutes(): string[] {
  const root = join(process.cwd(), "app", "api", "v1", "links", "[linkId]");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "route.ts") {
        const path = relative(root, dir).split(sep).join("/");
        for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
          if (new RegExp(`export\\s+const\\s+${method}\\b`).test(readFileSync(full, "utf8"))) found.push(`${method} ${path}`);
        }
      }
    }
  };
  walk(root);
  return found.filter((r) => !["PATCH ", "DELETE ", "POST code", "POST unlock", "POST password"].includes(r)).sort();
}

describe("the creator sets, changes and removes a password (E11, phase 4 §17.8.3)", () => {
  it("a Pro creator sets one with a new link; the summary says so, never the password or its hash", async () => {
    const { pro, share, link } = await passwordText();
    const row = await linkRow(link.id);
    expect(row.password_hash).toMatch(/^\$scrypt\$ln=17,r=8,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(row.password_version).toBe(1);
    expect(row.password_set_at).not.toBeNull();
    const listed = await pro.device.call("GET", `/api/v1/shares/${share.id}/links`);
    expect(listed.status).toBe(200);
    expect(listed.body.links[0]).toMatchObject({ id: link.id, hasPassword: true });
    expect(listed.text).not.toContain(PASSWORD);
    expect(listed.text).not.toContain("scrypt");
    expect(JSON.stringify(link)).not.toContain(PASSWORD);
  });

  it("PATCH sets, changes and removes it: each bumps the version; removing an absent one changes nothing", async () => {
    const pro = await proDevice(newNetwork().ip());
    const share = await pro.device.postText("patch me", undefined, "link_only");
    const link = await pro.device.createLink(share.id);
    expect(await linkRow(link.id)).toMatchObject({ password_hash: null, password_version: 0 });

    const set = await pro.device.call("PATCH", `/api/v1/links/${link.id}`, { password: PASSWORD });
    expect(set.status, set.text).toBe(200);
    expect(set.body.link).toMatchObject({ id: link.id, state: "active", hasPassword: true });
    expect(set.text).not.toContain(PASSWORD);
    expect((await linkRow(link.id)).password_version).toBe(1);

    expect((await pro.device.call("PATCH", `/api/v1/links/${link.id}`, { password: OTHER })).status).toBe(200);
    expect((await linkRow(link.id)).password_version).toBe(2);
    const removed = await pro.device.call("PATCH", `/api/v1/links/${link.id}`, { password: null });
    expect(removed.status).toBe(200);
    expect(removed.body.link.hasPassword).toBe(false);
    expect(await linkRow(link.id)).toMatchObject({ password_hash: null, password_version: 3, password_set_at: null });
    expect((await pro.device.call("PATCH", `/api/v1/links/${link.id}`, { password: null })).status).toBe(200);
    expect((await linkRow(link.id)).password_version).toBe(3);

    const { rows } = await adminDb().query(
      "select action, metadata from app.audit_events where target_type = 'link' and target_id = $1 and action like 'link.password%' order by id",
      [link.id],
    );
    expect(rows.map((r) => r.action)).toEqual(["link.password_set", "link.password_set", "link.password_removed"]);
    expect(rows.map((r) => r.metadata.changed)).toEqual([false, true, undefined]);
    for (const row of rows) expect(JSON.stringify(row.metadata)).not.toMatch(/violet|copper|scrypt/);
  });

  it("only the link's creator, from any of their devices: 403 NOT_CREATOR on the share's network, 404 elsewhere, 401 for a viewer", async () => {
    const net = newNetwork();
    const pro = await proDevice(net.ip());
    const share = await pro.device.postText("whose link?");
    const link = await pro.device.createLink(share.id);
    const neighbour = await Device.create(net.ip());
    const stranger = await proDevice(newNetwork().ip());
    const viewer = new Viewer();
    expect((await viewer.unlock(link.id, link.secret)).status).toBe(200);

    const patch = (device: Device) => device.call("PATCH", `/api/v1/links/${link.id}`, { password: PASSWORD });
    const sameNetwork = await patch(neighbour);
    expect([sameNetwork.status, code(sameNetwork)]).toEqual([403, "NOT_CREATOR"]);
    expect((await patch(stranger.device)).status).toBe(404);
    expect((await viewer.call("PATCH", `/api/v1/links/${link.id}`, { password: PASSWORD })).status).toBe(401);
    expect((await stranger.device.call("PATCH", "/api/v1/links/AAAAAAAAAAAAAAAA", { password: PASSWORD })).status).toBe(404);
    expect((await stranger.device.call("PATCH", "/api/v1/links/not-a-link", { password: PASSWORD })).status).toBe(404);
    expect((await linkRow(link.id)).password_hash).toBeNull();

    // The creator's second browser (another sign-in of the account), on another network.
    const second = await Device.attach(await signInByCode(pro.email), newNetwork().ip());
    expect((await patch(second)).status).toBe(200);
    expect((await linkRow(link.id)).password_version).toBe(1);
  });

  it("Free refused: 403 FEATURE_NOT_IN_PLAN with the Pro hint, at creation and by PATCH; nothing stored", async () => {
    const free = await accountDevice();
    const share = await free.device.postText("free text", undefined, "link_only");
    const created = await free.device.call("POST", `/api/v1/shares/${share.id}/links`, { password: PASSWORD });
    expect(created.status).toBe(403);
    expect(created.body.error).toMatchObject({ code: "FEATURE_NOT_IN_PLAN", details: { feature: "linkPasswords", requiredPlan: "pro" } });
    const link = await free.device.createLink(share.id);
    const patched = await free.device.call("PATCH", `/api/v1/links/${link.id}`, { password: PASSWORD });
    expect([patched.status, code(patched)]).toEqual([403, "FEATURE_NOT_IN_PLAN"]);
    expect((await linkRow(link.id)).password_hash).toBeNull();
    // Removing is always allowed (D4-12), even when there is nothing to remove.
    expect((await free.device.call("PATCH", `/api/v1/links/${link.id}`, { password: null })).status).toBe(200);
    // Anonymous browsers are Free too.
    const anonymous = await Device.create(newNetwork().ip());
    const anonShare = await anonymous.postText("anon", undefined, "link_only");
    expect((await anonymous.call("POST", `/api/v1/shares/${anonShare.id}/links`, { password: PASSWORD })).status).toBe(403);
  });

  it("input rules: 8–128 characters (422 PASSWORD_INVALID); strict bodies, so no hash, version or plan from the client", async () => {
    const pro = await proDevice(newNetwork().ip());
    const share = await pro.device.postText("rules", undefined, "link_only");
    const link = await pro.device.createLink(share.id);
    for (const password of ["seven77", "x".repeat(129)]) {
      const response = await pro.device.call("PATCH", `/api/v1/links/${link.id}`, { password });
      expect(response.status).toBe(422);
      expect(response.body.error).toMatchObject({ code: "PASSWORD_INVALID", details: { minLength: 8, maxLength: 128 } });
      expect(response.text).not.toContain(password);
    }
    expect((await pro.device.call("POST", `/api/v1/shares/${share.id}/links`, { password: "short" })).status).toBe(422);
    for (const body of [
      {},
      { password: PASSWORD, passwordHash: "$scrypt$ln=17,r=8,p=1$AAAA$AAAA" },
      { password: PASSWORD, passwordVersion: 0 },
      { password: PASSWORD, plan: "pro" },
      { expiresIn: 3600 },
      { password: 12345678 },
    ]) {
      const response = await pro.device.call("PATCH", `/api/v1/links/${link.id}`, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.text).not.toContain(PASSWORD);
    }
    expect((await linkRow(link.id)).password_hash).toBeNull();
  });

  it("an ended link takes no password (409 LINK_NOT_ACTIVE), but removal stays harmless", async () => {
    const pro = await proDevice(newNetwork().ip());
    const share = await pro.device.postText("ending", undefined, "link_only");
    const link = await pro.device.createLink(share.id);
    expect((await pro.device.call("DELETE", `/api/v1/links/${link.id}`)).status).toBe(204);
    const set = await pro.device.call("PATCH", `/api/v1/links/${link.id}`, { password: PASSWORD });
    expect([set.status, code(set)]).toEqual([409, "LINK_NOT_ACTIVE"]);
    expect((await linkRow(link.id)).password_hash).toBeNull();
  });
});

describe("T4-P1: the right password verifies the grant and opens the content", () => {
  it("the secret alone gets 409 PASSWORD_REQUIRED and an unverified grant; the password opens content, downloads and previews", { timeout: 60_000 }, async () => {
    const { link, fileId } = await passwordImage();
    const viewer = new Viewer();
    const unlocked = await viewer.unlock(link.id, link.secret);
    expect(unlocked.status).toBe(409);
    expect(unlocked.body.error).toMatchObject({ code: "PASSWORD_REQUIRED", details: { linkId: link.id } });
    expect(unlocked.headers.get("set-cookie")).toMatch(/link_session=/);
    expect(unlocked.text).not.toContain("photo.png");
    expect(await grantRows(link.id)).toEqual([{ password_version: 1, password_verified_at: null }]);
    expect(code(await viewer.content(link.id))).toBe("PASSWORD_REQUIRED");

    expect((await viewer.password(link.id, PASSWORD)).status).toBe(204);
    const [grant] = await grantRows(link.id);
    expect(grant!.password_version).toBe(1);
    expect(grant!.password_verified_at).not.toBeNull();
    const content = await viewer.content(link.id);
    expect(content.status).toBe(200);
    expect(content.body.share.files[0]).toMatchObject({ id: fileId, name: "photo.png" });
    expect((await viewer.fileUrl(link.id, fileId)).status).toBe(200);
    expect((await viewer.fileUrl(link.id, fileId, "preview-url")).status).toBe(200);
  });

  it("the password may come with the unlock: right → 200 with the content; wrong → 403 with the session cookie, then the password route", { timeout: 60_000 }, async () => {
    const { link, share } = await passwordText();
    const direct = new Viewer();
    const ok = await direct.unlock(link.id, link.secret, { password: PASSWORD });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.share.text.content).toContain("behind a password");

    const retry = new Viewer();
    const wrong = await retry.unlock(link.id, link.secret, { password: OTHER });
    expect([wrong.status, code(wrong)]).toEqual([403, "PASSWORD_INCORRECT"]);
    expect(wrong.headers.get("set-cookie")).toMatch(/link_session=/);
    expect((await retry.password(link.id, PASSWORD)).status).toBe(204);
    expect((await retry.content(link.id)).body.share.text.content).toBe((await direct.content(link.id)).body.share.text.content);
    expect(share.id).toBeTruthy();
  });

  it("a link with no password needs none, and its password route has nothing to prove (204, no hash)", async () => {
    const pro = await proDevice(newNetwork().ip());
    const link = await pro.device.createLink((await pro.device.postText("open", undefined, "link_only")).id);
    const viewer = new Viewer();
    expect((await viewer.unlock(link.id, link.secret)).status).toBe(200);
    expect((await viewer.password(link.id, "anything at all")).status).toBe(204);
    expect((await viewer.content(link.id)).status).toBe(200);
  });
});

describe("T4-P2: wrong passwords, the lock, Turnstile after it and the network limit", () => {
  it("wrong → 403; 10 failures in 15 minutes lock the link (423 + Retry-After) even for the right password; verified sessions keep access", { timeout: 90_000 }, async () => {
    const { link } = await passwordText();
    const before = await verifiedViewer(link);
    const viewer = await unverifiedViewer(link);
    for (let i = 1; i <= 10; i++) {
      const wrong = await viewer.password(link.id, `${OTHER} ${i}`);
      expect([wrong.status, code(wrong)], `attempt ${i}`).toEqual([403, "PASSWORD_INCORRECT"]);
      expect(wrong.text).not.toContain(OTHER);
    }
    const locked = await viewer.password(link.id, PASSWORD);
    expect([locked.status, code(locked)]).toEqual([423, "LINK_LOCKED"]);
    const retryAfter = Number(locked.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(800);
    expect(retryAfter).toBeLessThanOrEqual(900);
    const row = await linkRow(link.id);
    expect(row.password_locked_until!.getTime()).toBeGreaterThan(Date.now() + 800_000);

    // Everyone new waits, however they got their grant; the inline password too.
    const newcomer = await unverifiedViewer(link);
    expect((await newcomer.password(link.id, PASSWORD)).status).toBe(423);
    expect((await new Viewer().unlock(link.id, link.secret, { password: PASSWORD })).status).toBe(423);
    // RISK-044: a session that proved the password before keeps access.
    expect((await before.content(link.id)).status).toBe(200);
    expect(code(await viewer.content(link.id))).toBe("PASSWORD_REQUIRED");

    const { rows } = await adminDb().query(
      "select metadata from app.audit_events where action = 'link.password_failed' and target_id = $1",
      [link.id],
    );
    expect(rows).toEqual([{ metadata: { threshold: "lock", failures: 10 } }]);
    // The lock takes over from those failures: the link's count starts again from zero.
    expect(await failures(link.id)).toBe(0);
  });

  it("failures either side of a window boundary still count together: any 10 within 15 minutes lock the link", { timeout: 60_000 }, async () => {
    const { link } = await passwordText();
    const viewer = await unverifiedViewer(link);
    // Nine failures in the previous 15-minute window, as a guesser timing them around the boundary would leave.
    await adminDb().query(
      `insert into app.rate_counters (key, window_start, value, expires_at)
       values ($1, date_bin('15 minutes', now(), timestamptz '2000-01-01 00:00:00+00') - interval '15 minutes', 9,
               date_bin('15 minutes', now(), timestamptz '2000-01-01 00:00:00+00'))`,
      [`pwFail:${link.id}`],
    );
    expect(code(await viewer.password(link.id, OTHER))).toBe("PASSWORD_INCORRECT");
    const locked = await viewer.password(link.id, PASSWORD);
    expect([locked.status, code(locked)]).toEqual([423, "LINK_LOCKED"]);
    expect((await linkRow(link.id)).password_locked_until).not.toBeNull();
  });

  it("after the lock, Turnstile is required for an hour: without a valid token even the right password is refused; with one it is evaluated", { timeout: 90_000 }, async () => {
    const { link } = await passwordText();
    const viewer = await unverifiedViewer(link);
    for (let i = 0; i < 10; i++) expect((await viewer.password(link.id, `${OTHER} ${i}`)).status).toBe(403);
    // The lock runs out. Its failures were cleared when it was set, so only Turnstile stands in the way now.
    await adminDb().query("update app.share_links set password_locked_until = now() - interval '1 second' where id = $1", [link.id]);

    const noToken = await viewer.password(link.id, PASSWORD);
    expect(noToken.status).toBe(403);
    expect(noToken.body.error).toMatchObject({ code: "TURNSTILE_REQUIRED", details: { turnstile: true } });
    expect((await viewer.password(link.id, PASSWORD, "fail-not-a-real-token")).status).toBe(403);
    expect(code(await viewer.content(link.id))).toBe("PASSWORD_REQUIRED");
    const wrong = await viewer.password(link.id, OTHER, turnstilePass());
    expect(code(wrong)).toBe("PASSWORD_INCORRECT");
    expect((await viewer.password(link.id, PASSWORD, turnstilePass())).status).toBe(204);
    expect((await viewer.content(link.id)).status).toBe(200);

    // An hour after the lock ended, no challenge.
    await adminDb().query("update app.share_links set password_locked_until = now() - interval '61 minutes' where id = $1", [link.id]);
    const later = await unverifiedViewer(link);
    expect((await later.password(link.id, PASSWORD)).status).toBe(204);
  });

  it("20 wrong passwords in an hour from one network: 429 for that network on every link, before any password is checked", { timeout: 120_000 }, async () => {
    const net = newNetwork();
    const links = await Promise.all([passwordText(), passwordText(), passwordText()]);
    const viewers = await Promise.all(links.map(({ link }) => unverifiedViewer(link, net.ip())));
    for (let i = 0; i < 20; i++) {
      const target = i % 3;
      const wrong = await viewers[target]!.password(links[target]!.link.id, `${OTHER} ${i}`);
      expect(code(wrong), `failure ${i + 1}`).toBe("PASSWORD_INCORRECT");
    }
    const limited = await viewers[0]!.password(links[0]!.link.id, PASSWORD);
    expect([limited.status, code(limited)]).toEqual([429, "RATE_LIMITED"]);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    const fourth = await passwordText();
    expect((await (await unverifiedViewer(fourth.link, net.ip())).password(fourth.link.id, PASSWORD)).status).toBe(429);
    // No link is locked (at most 7 failures each), and other networks are unaffected.
    for (const { link } of links) expect((await linkRow(link.id)).password_locked_until).toBeNull();
    expect((await (await unverifiedViewer(links[0]!.link)).password(links[0]!.link.id, PASSWORD)).status).toBe(204);
  });

  it("concurrent wrong attempts can't exceed the limit: of 15 at once at most 10 are evaluated, the rest refused before hashing (423)", { timeout: 120_000 }, async () => {
    const { link } = await passwordText();
    const viewers = await Promise.all(Array.from({ length: 15 }, () => unverifiedViewer(link)));
    const results = await Promise.all(viewers.map((v, i) => v.password(link.id, `${OTHER} ${i}`)));
    const statuses = results.map((r) => r.status);
    const evaluated = statuses.filter((s) => s === 403).length;
    expect(evaluated).toBeLessThanOrEqual(10);
    expect(evaluated + statuses.filter((s) => s === 423).length, statuses.join(",")).toBe(15);
    expect((await linkRow(link.id)).password_locked_until!.getTime()).toBeGreaterThan(Date.now());
    expect((await viewers[0]!.password(link.id, PASSWORD)).status).toBe(423);
  });

  it("concurrent right passwords from many browsers all succeed, and none counts as a failure", { timeout: 90_000 }, async () => {
    const { link } = await passwordText();
    const viewers = await Promise.all(Array.from({ length: 8 }, () => unverifiedViewer(link)));
    const results = await Promise.all(viewers.map((v) => v.password(link.id, PASSWORD)));
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(204));
    expect(await failures(link.id)).toBe(0);
    for (const viewer of viewers) expect((await viewer.content(link.id)).status).toBe(200);
  });
});

describe("T4-P3: a code-resolved grant also needs the password (C4-8)", () => {
  it("the code gives a grant and 409 PASSWORD_REQUIRED, never the content; the password then opens it", { timeout: 60_000 }, async () => {
    const { link } = await passwordText({ shortCode: true });
    const viewer = new Viewer();
    const resolved = await viewer.resolve(link.shortCode!.code);
    expect(resolved.status).toBe(409);
    expect(resolved.body.error).toMatchObject({ code: "PASSWORD_REQUIRED", details: { linkId: link.id } });
    expect(resolved.headers.get("set-cookie")).toMatch(/link_session=/);
    expect(code(await viewer.content(link.id))).toBe("PASSWORD_REQUIRED");
    expect(code(await viewer.password(link.id, OTHER))).toBe("PASSWORD_INCORRECT");
    expect((await viewer.password(link.id, PASSWORD)).status).toBe(204);
    expect((await viewer.content(link.id)).status).toBe(200);
  });
});

describe("T4-P4: every viewer route refuses an unverified grant", () => {
  it("content, download, preview, reveal, confirm-received and link reports: 409 PASSWORD_REQUIRED, and nothing claimed or issued", { timeout: 90_000 }, async () => {
    // Every viewer route under /links/{linkId} is in this list, so a new one can't slip past.
    expect(viewerLinkRoutes()).toEqual([
      "GET content",
      "POST confirm-received",
      "POST files/[fileId]/download-url",
      "POST files/[fileId]/preview-url",
      "POST reveal",
    ]);
    const { link, fileId, shareId } = await passwordImage();
    const burnCreator = await proDevice(newNetwork().ip());
    const burn = await burnCreator.device.postBurnText("burn behind a password", "link_only");
    const burnLink = await burnCreator.device.createLink(burn.id, { password: PASSWORD });

    const viewer = await unverifiedViewer(link);
    expect((await viewer.unlock(burnLink.id, burnLink.secret)).status).toBe(409);
    const refused = [
      await viewer.content(link.id),
      await viewer.fileUrl(link.id, fileId),
      await viewer.fileUrl(link.id, fileId, "preview-url"),
      await viewer.call("POST", `/api/v1/links/${burnLink.id}/reveal`, { confirm: true }),
      await viewer.call("POST", `/api/v1/links/${burnLink.id}/confirm-received`, {}),
      await viewer.call("POST", "/api/v1/reports", { target: { type: "link", linkId: link.id }, category: "spam", turnstileToken: turnstilePass() }),
    ];
    for (const response of refused) {
      expect([response.status, code(response)], response.text).toEqual([409, "PASSWORD_REQUIRED"]);
      expect(response.text).not.toMatch(/photo\.png|burn behind|X-Amz/);
    }
    const { rows } = await adminDb().query(
      `select (select count(*)::int from app.downloads where share_id = any($1::uuid[])) as downloads,
              (select status from app.shares where id = $2) as burn_status,
              (select count(*)::int from app.abuse_reports where link_id = $3) as reports`,
      [[shareId, burn.id], burn.id, link.id],
    );
    expect(rows[0]).toEqual({ downloads: 0, burn_status: "active", reports: 0 });
  });

  it("the proof is per grant, not per browser: a session holding two password links proves each one", { timeout: 60_000 }, async () => {
    const a = await passwordText();
    const b = await passwordText({ password: OTHER });
    const viewer = await unverifiedViewer(a.link);
    expect((await viewer.unlock(b.link.id, b.link.secret)).status).toBe(409);
    expect((await viewer.password(a.link.id, PASSWORD)).status).toBe(204);
    expect((await viewer.content(a.link.id)).status).toBe(200);
    expect(code(await viewer.content(b.link.id))).toBe("PASSWORD_REQUIRED");
    // A's password proves nothing for B.
    expect(code(await viewer.password(b.link.id, PASSWORD))).toBe("PASSWORD_INCORRECT");
    expect((await viewer.password(b.link.id, OTHER)).status).toBe(204);
    expect((await viewer.content(b.link.id)).status).toBe(200);
  });
});

describe("T4-P5: a change or removal invalidates every grant", () => {
  it("change: verified sessions are asked again; the old password is wrong, the new one works", { timeout: 60_000 }, async () => {
    const { pro, link } = await passwordText();
    const viewer = await verifiedViewer(link);
    expect((await pro.device.call("PATCH", `/api/v1/links/${link.id}`, { password: OTHER })).status).toBe(200);
    expect(code(await viewer.content(link.id))).toBe("PASSWORD_REQUIRED");
    expect(code(await viewer.password(link.id, PASSWORD))).toBe("PASSWORD_INCORRECT");
    expect((await viewer.password(link.id, OTHER)).status).toBe(204);
    expect((await viewer.content(link.id)).status).toBe(200);
  });

  it("removal: every grant is invalid (404, the link is needed again); unlocking again needs no password", { timeout: 60_000 }, async () => {
    const { pro, link } = await passwordText();
    const verified = await verifiedViewer(link);
    const waiting = await unverifiedViewer(link);
    expect((await pro.device.call("PATCH", `/api/v1/links/${link.id}`, { password: null })).status).toBe(200);
    for (const viewer of [verified, waiting]) {
      expect(code(await viewer.content(link.id))).toBe("LINK_UNAVAILABLE");
      expect(code(await viewer.password(link.id, PASSWORD))).toBe("LINK_UNAVAILABLE");
    }
    expect((await verified.unlock(link.id, link.secret)).status).toBe(200);
    expect((await verified.content(link.id)).status).toBe(200);
  });

  it("setting a password on a link that had none invalidates the grants it already had", { timeout: 60_000 }, async () => {
    const pro = await proDevice(newNetwork().ip());
    const link = await pro.device.createLink((await pro.device.postText("open first", undefined, "link_only")).id);
    const viewer = new Viewer();
    expect((await viewer.unlock(link.id, link.secret)).status).toBe(200);
    expect((await pro.device.call("PATCH", `/api/v1/links/${link.id}`, { password: PASSWORD })).status).toBe(200);
    expect(code(await viewer.content(link.id))).toBe("PASSWORD_REQUIRED");
    expect((await viewer.password(link.id, PASSWORD)).status).toBe(204);
    expect((await viewer.content(link.id)).status).toBe(200);
  });

  it("a new unlock or code restarts the grant unverified, and a proof never outlives its grant", { timeout: 60_000 }, async () => {
    const { link } = await passwordText({ shortCode: true });
    const viewer = await verifiedViewer(link);
    expect((await viewer.unlock(link.id, link.secret)).status).toBe(409);
    expect(code(await viewer.content(link.id))).toBe("PASSWORD_REQUIRED");
    expect((await viewer.password(link.id, PASSWORD)).status).toBe(204);
    expect((await viewer.resolve(link.shortCode!.code)).status).toBe(409);
    expect(code(await viewer.content(link.id))).toBe("PASSWORD_REQUIRED");
    expect((await viewer.password(link.id, PASSWORD)).status).toBe(204);
    // Twelve hours on, the grant (and its proof) has run out: the link is needed again.
    await adminDb().query(
      "update app.link_grants set granted_at = now() - interval '13 hours', expires_at = now() - interval '1 hour', password_verified_at = now() - interval '12 hours' where link_id = $1",
      [link.id],
    );
    expect(code(await viewer.content(link.id))).toBe("LINK_UNAVAILABLE");
    expect(code(await viewer.password(link.id, PASSWORD))).toBe("LINK_UNAVAILABLE");
  });

  it("a change racing a verification never leaves a grant verified for the new password", { timeout: 300_000 }, async () => {
    for (let round = 0; round < 6; round++) {
      const { pro, link } = await passwordText();
      const viewer = await unverifiedViewer(link);
      const [verify, change] = await Promise.all([
        viewer.password(link.id, PASSWORD),
        pro.device.call("PATCH", `/api/v1/links/${link.id}`, { password: OTHER }),
      ]);
      expect(change.status).toBe(200);
      expect([204, 403, 409], verify.text).toContain(verify.status);
      // Whatever the order, the old password can't open the link now.
      expect(code(await viewer.content(link.id)), `round ${round}`).toBe("PASSWORD_REQUIRED");
      const [grant] = await grantRows(link.id);
      expect(grant!.password_verified_at === null || grant!.password_version !== (await linkRow(link.id)).password_version).toBe(true);
    }
  });
});

describe("T4-P6: an expired or revoked password link → 410 after the secret, whatever the password", () => {
  it("revoked: unlock (with or without the password), the password route and verified sessions all get 410", { timeout: 60_000 }, async () => {
    const { pro, link } = await passwordText();
    const verified = await verifiedViewer(link);
    const waiting = await unverifiedViewer(link);
    expect((await pro.device.call("DELETE", `/api/v1/links/${link.id}`)).status).toBe(204);
    expect(code(await new Viewer().unlock(link.id, link.secret, { password: PASSWORD }))).toBe("LINK_EXPIRED");
    expect(code(await new Viewer().unlock(link.id, link.secret))).toBe("LINK_EXPIRED");
    expect(code(await waiting.password(link.id, PASSWORD))).toBe("LINK_EXPIRED");
    expect(code(await verified.content(link.id))).toBe("LINK_EXPIRED");
    // A wrong secret still learns nothing, with or without a password.
    expect(code(await new Viewer().unlock(link.id, `${link.secret.slice(0, -1)}A`, { password: PASSWORD }))).toBe("LINK_UNAVAILABLE");
  });

  it("expired, or its share ended: the same 410", { timeout: 60_000 }, async () => {
    const expired = await passwordText();
    const waiting = await unverifiedViewer(expired.link);
    await adminDb().query("update app.share_links set created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' where id = $1", [expired.link.id]);
    expect(code(await new Viewer().unlock(expired.link.id, expired.link.secret, { password: PASSWORD }))).toBe("LINK_EXPIRED");
    expect(code(await waiting.password(expired.link.id, PASSWORD))).toBe("LINK_EXPIRED");

    const ended = await passwordText();
    const verified = await verifiedViewer(ended.link);
    expect((await ended.pro.device.call("DELETE", `/api/v1/shares/${ended.share.id}`)).status).toBe(204);
    expect(code(await verified.content(ended.link.id))).toBe("LINK_EXPIRED");
    expect(code(await verified.password(ended.link.id, PASSWORD))).toBe("LINK_EXPIRED");
  });
});

describe("T4-P9: after a downgrade the password stays enforced; changing is refused, removing allowed", () => {
  it("Pro → Free", { timeout: 60_000 }, async () => {
    const { pro, link } = await passwordText();
    const verified = await verifiedViewer(link);
    await pro.downgrade();
    const viewer = await unverifiedViewer(link);
    expect(code(await viewer.content(link.id))).toBe("PASSWORD_REQUIRED");
    expect((await viewer.password(link.id, PASSWORD)).status).toBe(204);
    const change = await pro.device.call("PATCH", `/api/v1/links/${link.id}`, { password: OTHER });
    expect(change.status).toBe(403);
    expect(change.body.error).toMatchObject({ code: "FEATURE_NOT_IN_PLAN", details: { feature: "linkPasswords", requiredPlan: "pro" } });
    expect((await linkRow(link.id)).password_version).toBe(1);
    expect((await pro.device.call("PATCH", `/api/v1/links/${link.id}`, { password: null })).status).toBe(200);
    expect(code(await verified.content(link.id))).toBe("LINK_UNAVAILABLE");
    expect((await new Viewer().unlock(link.id, link.secret)).status).toBe(200);
  });
});

describe("IDOR: a password is never a way in by itself", () => {
  it("a grant for one link, or none, can't prove another link's password: 404 LINK_UNAVAILABLE", { timeout: 60_000 }, async () => {
    const a = await passwordText();
    const b = await passwordText({ password: OTHER });
    const viewer = await unverifiedViewer(a.link);
    expect(code(await viewer.password(b.link.id, OTHER))).toBe("LINK_UNAVAILABLE");
    expect(code(await new Viewer().password(b.link.id, OTHER))).toBe("LINK_UNAVAILABLE");
    expect(code(await new Viewer().password("AAAAAAAAAAAAAAAA", OTHER))).toBe("LINK_UNAVAILABLE");
    expect(code(await new Viewer().password("not-a-link", OTHER))).toBe("LINK_UNAVAILABLE");
    // The creator's device session isn't a viewer grant.
    expect(code(await b.pro.device.call("POST", `/api/v1/links/${b.link.id}/password`, { password: OTHER }))).toBe("LINK_UNAVAILABLE");
    expect(await grantRows(b.link.id)).toEqual([]);
  });

  it("the password route's body is strict and bounded", async () => {
    const { link } = await passwordText();
    const viewer = await unverifiedViewer(link);
    for (const body of [{}, { password: "" }, { password: "x".repeat(513) }, { password: PASSWORD, verified: true }, { password: PASSWORD, linkId: link.id }]) {
      expect((await viewer.call("POST", `/api/v1/links/${link.id}/password`, body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(code(await viewer.content(link.id))).toBe("PASSWORD_REQUIRED");
  });
});

describe("T4-P7: no password or hash in logs, audit metadata, errors or DTOs", () => {
  it("passwords never reach the server log or the database's statements; hashes never leave the database", { timeout: 120_000 }, async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const sql = (statement: string) =>
      execFileSync("docker", ["exec", DB_CONTAINER, "psql", "-U", "supabase_admin", "-d", "postgres", "-Atqc", statement]);
    sql("alter system set log_statement = 'all'");
    sql("select pg_reload_conf()");
    const first = `first ${randomBytes(6).toString("hex")}`;
    const second = `second ${randomBytes(6).toString("hex")}`;
    const wrong = `wrong ${randomBytes(6).toString("hex")}`;
    const responses: ApiResponse[] = [];
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const pro = await proDevice(newNetwork().ip());
      const share = await pro.device.postText("logged?", undefined, "link_only");
      const created = await pro.device.call("POST", `/api/v1/shares/${share.id}/links`, { password: first, shortCode: {} });
      responses.push(created);
      const link = created.body.link as { id: string; url: string; shortCode: { code: string } };
      const secret = new URL(link.url).hash.replace(/^#k=/, "");
      responses.push(await pro.device.call("PATCH", `/api/v1/links/${link.id}`, { password: second }));
      responses.push(await pro.device.call("PATCH", `/api/v1/links/${link.id}`, { password: "short" }));
      const viewer = new Viewer();
      responses.push(await viewer.unlock(link.id, secret, { password: wrong }));
      responses.push(await viewer.password(link.id, first));
      responses.push(await viewer.password(link.id, second));
      responses.push(await viewer.content(link.id));
      responses.push(await new Viewer().resolve(link.shortCode.code));
      responses.push(await pro.device.call("GET", `/api/v1/shares/${share.id}/links`));
      const stored = (await linkRow(link.id)).password_hash!;
      await new Promise((resolve) => setTimeout(resolve, 500));

      const dbLog = spawnSync("docker", ["logs", "--since", since, DB_CONTAINER], { encoding: "utf8" });
      const statements = `${dbLog.stdout}${dbLog.stderr}`;
      expect(statements).toContain("app.share_links"); // control: statements were logged
      const serverLog = readFileSync(stack().serverLog, "utf8");
      const { rows } = await adminDb().query("select metadata::text as m from app.audit_events where target_id = $1 or metadata ->> 'linkId' = $1", [link.id]);
      expect(rows.length).toBeGreaterThan(0);
      for (const value of [first, second, wrong]) {
        expect(statements).not.toContain(value);
        expect(serverLog).not.toContain(value);
        for (const response of responses) expect(response.text).not.toContain(value);
        for (const row of rows) expect(row.m).not.toContain(value);
      }
      expect(serverLog).not.toContain(stored);
      expect(serverLog).not.toContain("$scrypt$");
      for (const response of responses) expect(response.text).not.toContain("scrypt");
      for (const row of rows) expect(row.m).not.toContain("scrypt");
    } finally {
      sql("alter system reset log_statement");
      sql("select pg_reload_conf()");
    }
  });
});
