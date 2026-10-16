import { randomBytes } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { adminDb, api, closeAdminDb, Device, newNetwork, PNG_BYTES, setFlag, Viewer } from "./support/api";

/**
 * Phase 2 remote links (02 §6.2, 03 §4): creator-only links (T-011), unlock with uniform failures
 * (T-030), viewer isolation (T-029), revocation and expiry (T-031), link-only shares (T-012),
 * the remote file policy (T-035), per-link caps and the kill switch.
 */

afterAll(closeAdminDb);
afterEach(async () => {
  await setFlag("remote_links_enabled", true);
  await setFlag("short_codes_enabled", true);
});

const without = (body: { error?: Record<string, unknown> }) => ({ ...body, error: { ...body.error, requestId: undefined } });
const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, ...Buffer.from("not really a zip")]);
const PE_BYTES = new Uint8Array([0x4d, 0x5a, 0x90, 0, ...Buffer.from("not really a program")]);

describe("share links: creator only, from any network (T-011, DEC-033)", () => {
  it("the creator gets a one-time URL with the secret only in the fragment, from another network too", async () => {
    const home = newNetwork();
    const creator = await Device.create(home.ip());
    const share = await creator.postText("for a friend");
    await creator.moveTo(newNetwork().ip());

    const response = await creator.call("POST", `/api/v1/shares/${share.id}/links`, {});
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const link = response.body.link;
    const url = new URL(link.url);
    expect(url.pathname).toBe(`/s/${link.id}`);
    expect(url.search).toBe("");
    expect(url.hash).toMatch(/^#k=[A-Za-z0-9_-]{43}$/);
    expect(link.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(link.shortCode).toBeNull();
    const { rows } = await adminDb().query("select expires_at from app.shares where id = $1", [share.id]);
    expect(new Date(link.expiresAt).getTime()).toBe(new Date(rows[0].expires_at).getTime());
  });

  it("other devices on the network get 403 NOT_CREATOR; other networks get 404", async () => {
    const home = newNetwork();
    const creator = await Device.create(home.ip());
    const neighbour = await Device.create(home.ip());
    const stranger = await Device.create(newNetwork().ip());
    const share = await creator.postText("mine");
    const link = await creator.createLink(share.id);

    for (const [method, path] of [
      ["POST", `/api/v1/shares/${share.id}/links`],
      ["GET", `/api/v1/shares/${share.id}/links`],
      ["DELETE", `/api/v1/links/${link.id}`],
      ["POST", `/api/v1/links/${link.id}/code`],
    ] as const) {
      const body = method === "DELETE" || method === "GET" ? undefined : {};
      const near = await neighbour.call(method, path, body);
      expect(near.status, `${method} ${path}`).toBe(403);
      expect(near.body.error.code).toBe("NOT_CREATOR");
      expect((await stranger.call(method, path, body)).status, `${method} ${path}`).toBe(404);
    }
  });

  it("a link never outlives its share, and only offered expiries are accepted", async () => {
    const creator = await Device.create(newNetwork().ip());
    const share = await creator.postText("for a day", 86400);
    const tooLong = await creator.call("POST", `/api/v1/shares/${share.id}/links`, { expiresIn: 7 * 86400 });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.error).toMatchObject({ code: "EXPIRY_NOT_ALLOWED", details: { reason: "after_share_expiry" } });
    const odd = await creator.call("POST", `/api/v1/shares/${share.id}/links`, { expiresIn: 1234 });
    expect(odd.status).toBe(422);
    const longCode = await creator.call("POST", `/api/v1/shares/${share.id}/links`, { shortCode: { expiresIn: 7 * 86400 } });
    expect(longCode.status).toBe(422);
    expect((await creator.call("POST", `/api/v1/shares/${share.id}/links`, { expiresIn: 3600 })).status).toBe(201);
  });

  it("lists links without secrets, URLs or codes, and revocation shows there", async () => {
    const creator = await Device.create(newNetwork().ip());
    const share = await creator.postText("listed");
    const kept = await creator.createLink(share.id, { shortCode: {} });
    const revoked = await creator.createLink(share.id);
    expect((await creator.call("DELETE", `/api/v1/links/${revoked.id}`)).status).toBe(204);
    expect((await creator.call("DELETE", `/api/v1/links/${revoked.id}`)).status).toBe(204); // idempotent

    const list = await creator.call("GET", `/api/v1/shares/${share.id}/links`);
    expect(list.status).toBe(200);
    type Summary = { id: string; state: string; shortCodeExpiresAt: string | null; unlockCount: number };
    const byId = Object.fromEntries((list.body.links as Summary[]).map((l) => [l.id, l]));
    expect(byId[kept.id]).toMatchObject({ state: "active", unlockCount: 0 });
    expect(byId[kept.id]?.shortCodeExpiresAt).not.toBeNull();
    expect(byId[revoked.id]).toMatchObject({ state: "revoked", shortCodeExpiresAt: null });
    expect(list.text).not.toContain(kept.secret);
    expect(list.text).not.toContain(kept.shortCode!.code);
    expect(list.text).not.toContain("http");

    // Audited, once each, with the actor and without the secret (03 §14).
    const { rows } = await adminDb().query(
      "select action, actor_kind, actor_user_id, metadata from app.audit_events where target_type = 'link' and target_id = $1 order by id",
      [revoked.id],
    );
    expect(rows.map((r) => r.action)).toEqual(["link.created", "link.revoked"]);
    expect(rows.every((r) => r.actor_kind === "device" && r.actor_user_id === creator.userId)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(revoked.secret);
  });

  it("refuses links while an upload is still in progress (409)", async () => {
    const creator = await Device.create(newNetwork().ip());
    const init = await creator.call("POST", "/api/v1/shares", { destination: "network", files: [{ name: "a.bin", size: 3, type: "" }] });
    const response = await creator.call("POST", `/api/v1/shares/${init.body.share.id}/links`, {});
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("UPLOAD_INCOMPLETE");
  });

  it("stores only HMACs: the secret and the code never reach the database", async () => {
    const creator = await Device.create(newNetwork().ip());
    const share = await creator.postText("hashed");
    const link = await creator.createLink(share.id, { shortCode: {} });
    const { rows } = await adminDb().query("select to_jsonb(l) as row from app.share_links l where id = $1", [link.id]);
    const stored = JSON.stringify(rows[0].row);
    expect(stored).not.toContain(link.secret);
    expect(stored).not.toContain(link.shortCode!.code.replace("-", ""));
    expect(rows[0].row.secret_hmac).toMatch(/^\\x[0-9a-f]{64}$/);
  });
});

describe("unlock: uniform failures, state only after proof (T-030)", () => {
  it("a wrong secret, an unknown link and a malformed link ID get the identical 404, and no cookie", async () => {
    const creator = await Device.create(newNetwork().ip());
    const link = await creator.createLink((await creator.postText("guarded")).id);
    const wrongSecret = await new Viewer().unlock(link.id, randomBytes(32).toString("base64url"));
    const unknownLink = await new Viewer().unlock(randomBytes(12).toString("base64url"), link.secret);
    const malformed = await new Viewer().unlock("not-a-link-id", link.secret);
    for (const response of [wrongSecret, unknownLink, malformed]) {
      expect(response.status).toBe(404);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(without(response.body)).toEqual({ error: { code: "LINK_UNAVAILABLE", message: "This link isn't available" } });
    }
  });

  it("takes comparable time for an unknown link and a wrong secret", { timeout: 60_000 }, async () => {
    const creator = await Device.create(newNetwork().ip());
    const link = await creator.createLink((await creator.postText("timing")).id);
    const time = async (fn: () => Promise<unknown>) => {
      const start = performance.now();
      await fn();
      return performance.now() - start;
    };
    const unknown: number[] = [];
    const wrong: number[] = [];
    for (let i = 0; i < 20; i++) {
      unknown.push(await time(() => new Viewer().unlock(randomBytes(12).toString("base64url"), link.secret)));
      wrong.push(await time(() => new Viewer().unlock(link.id, randomBytes(32).toString("base64url"))));
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const [a, b] = [median(unknown), median(wrong)];
    expect(Math.abs(a - b)).toBeLessThan(Math.max(15, 0.5 * Math.min(a, b)));
  });

  it("reveals a revoked or expired link only to someone holding its secret (410)", async () => {
    const creator = await Device.create(newNetwork().ip());
    const share = await creator.postText("ending");
    const revoked = await creator.createLink(share.id);
    await creator.call("DELETE", `/api/v1/links/${revoked.id}`);
    expect((await new Viewer().unlock(revoked.id, randomBytes(32).toString("base64url"))).status).toBe(404);
    const proven = await new Viewer().unlock(revoked.id, revoked.secret);
    expect(proven.status).toBe(410);
    expect(proven.body.error.code).toBe("LINK_EXPIRED");

    const expired = await creator.createLink(share.id);
    await adminDb().query("update app.share_links set created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' where id = $1", [expired.id]);
    expect((await new Viewer().unlock(expired.id, expired.secret)).status).toBe(410);
  });
});

describe("viewers see only the link's target (T-029, G4)", () => {
  it("unlocking sets an httpOnly, SameSite=Lax session cookie and returns only the target share", async () => {
    const home = newNetwork();
    const creator = await Device.create(home.ip());
    const other = await creator.postText("another post on the same network");
    const share = await creator.uploadFile("pic.png", PNG_BYTES, "image/png");
    const shareId = share.init.body.share.id as string;
    const link = await creator.createLink(shareId);

    const viewer = new Viewer();
    const unlocked = await viewer.unlock(link.id, link.secret);
    expect(unlocked.status).toBe(200);
    const cookie = unlocked.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^link_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=43200; HttpOnly; SameSite=Lax$/);

    const content = await viewer.content(link.id);
    expect(content.status).toBe(200);
    expect(Object.keys(content.body).sort()).toEqual(["access", "link", "share"]);
    expect(Object.keys(content.body.share).sort()).toEqual(["expiresAt", "files", "kind", "text"]);
    expect(Object.keys(content.body.share.files[0]).sort()).toEqual(["id", "name", "previewable", "riskFlags", "sizeBytes", "type"]);
    expect(content.body.share.files[0]).toMatchObject({ id: share.upload.fileId, name: "pic.png", previewable: true });
    const { rows } = await adminDb().query("select network_space_id, created_by_user_id, created_by_device_id from app.shares where id = $1", [shareId]);
    for (const value of [rows[0].network_space_id, rows[0].created_by_user_id, rows[0].created_by_device_id, shareId, other.id, creator.label]) {
      expect(content.text).not.toContain(value);
    }
  });

  it("a grant opens only its own link, files of its own share, and nothing in the local API", async () => {
    const creator = await Device.create(newNetwork().ip());
    const mine = await creator.uploadFile("a.txt", Buffer.from("aaa"), "text/plain");
    const theirs = await creator.uploadFile("b.txt", Buffer.from("bbb"), "text/plain");
    const linkA = await creator.createLink(mine.init.body.share.id);
    const linkB = await creator.createLink(theirs.init.body.share.id);

    const viewer = new Viewer();
    expect((await viewer.unlock(linkA.id, linkA.secret)).status).toBe(200);
    expect((await viewer.content(linkB.id)).status).toBe(404); // this share vs another share
    expect((await viewer.fileUrl(linkA.id, theirs.upload.fileId)).status).toBe(404);
    expect((await viewer.fileUrl(linkB.id, theirs.upload.fileId)).status).toBe(404);
    const local = await viewer.call("GET", "/api/v1/local/shares");
    expect(local.status).toBe(401);
    expect((await viewer.call("POST", `/api/v1/files/${mine.upload.fileId}/download-url`, {})).status).toBe(401);

    const download = await viewer.fileUrl(linkA.id, mine.upload.fileId);
    expect(download.status).toBe(200);
    expect(download.body.fileName).toBe("a.txt");
    const bytes = await fetch(download.body.url);
    expect(await bytes.text()).toBe("aaa");
    expect(bytes.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect((await viewer.fileUrl(linkA.id, mine.upload.fileId, "preview-url")).status).toBe(422);
    const { rows } = await adminDb().query("select actor_kind, user_id, device_id from app.downloads where link_id = $1", [linkA.id]);
    expect(rows).toEqual([{ actor_kind: "link_viewer", user_id: null, device_id: null }]);
  });

  it("no cookie, or a cookie of the viewer's own choosing, opens nothing; a session is never adopted", async () => {
    const creator = await Device.create(newNetwork().ip());
    const link = await creator.createLink((await creator.postText("fixation")).id);
    expect((await new Viewer().content(link.id)).status).toBe(404);

    const chosen = randomBytes(32).toString("base64url");
    const viewer = new Viewer();
    viewer.cookie = `link_session=${chosen}`;
    expect((await viewer.content(link.id)).status).toBe(404);
    expect((await viewer.unlock(link.id, link.secret)).status).toBe(200);
    expect(viewer.cookie).not.toBe(`link_session=${chosen}`);
    const attacker = new Viewer();
    attacker.cookie = `link_session=${chosen}`;
    expect((await attacker.content(link.id)).status).toBe(404);
  });
});

describe("revocation and expiry take effect on the next request (T-031)", () => {
  it("revoking, expiring, ending the share or an expired grant all stop a viewer", async () => {
    const creator = await Device.create(newNetwork().ip());
    const share = await creator.postText("watch me go");
    const viewerOf = async () => {
      const link = await creator.createLink(share.id);
      const viewer = new Viewer();
      expect((await viewer.unlock(link.id, link.secret)).status).toBe(200);
      return { link, viewer };
    };

    const a = await viewerOf();
    await creator.call("DELETE", `/api/v1/links/${a.link.id}`);
    expect((await a.viewer.content(a.link.id)).status).toBe(410);

    const b = await viewerOf();
    await adminDb().query("update app.share_links set created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' where id = $1", [b.link.id]);
    expect((await b.viewer.content(b.link.id)).status).toBe(410);

    const c = await viewerOf();
    await adminDb().query("update app.link_grants set granted_at = now() - interval '13 hours', expires_at = now() - interval '1 hour' where link_id = $1", [c.link.id]);
    const lapsed = await c.viewer.content(c.link.id);
    expect(lapsed.status).toBe(404); // the link still works, but this browser needs it again
    expect((await c.viewer.unlock(c.link.id, c.link.secret)).status).toBe(200);

    expect((await creator.call("DELETE", `/api/v1/shares/${share.id}`)).status).toBe(204);
    expect((await c.viewer.content(c.link.id)).status).toBe(410);
    const { rows } = await adminDb().query("select revoke_reason from app.share_links where id = $1", [c.link.id]);
    expect(rows[0].revoke_reason).toBe("share_ended");
  });

  it("an expired share stops its links before any job runs (T-041)", async () => {
    const creator = await Device.create(newNetwork().ip());
    const share = await creator.postText("expiring");
    const link = await creator.createLink(share.id);
    const viewer = new Viewer();
    await viewer.unlock(link.id, link.secret);
    await adminDb().query("update app.shares set expires_at = now() - interval '1 second' where id = $1", [share.id]);
    expect((await viewer.content(link.id)).status).toBe(410);
  });
});

describe("link-only shares (T-012, DEC-033)", () => {
  it("never appear in a network feed, only to their creator and through links", async () => {
    const home = newNetwork();
    const creator = await Device.create(home.ip());
    const neighbour = await Device.create(home.ip());
    const share = await creator.postText("link only please", undefined, "link_only");
    expect(share.scope).toBe("link_only");

    expect(await neighbour.feedIds()).not.toContain(share.id);
    expect(await creator.feedIds()).not.toContain(share.id);
    expect((await neighbour.call("GET", `/api/v1/shares/${share.id}`)).status).toBe(404);
    expect(await creator.myShareIds()).toContain(share.id);
    const { rows } = await adminDb().query("select scope, network_space_id from app.shares where id = $1", [share.id]);
    expect(rows[0]).toEqual({ scope: "link_only", network_space_id: null });

    const link = await creator.createLink(share.id);
    const viewer = new Viewer();
    expect((await viewer.unlock(link.id, link.secret)).body.share.text.content).toBe("link only please");
  });

  it("can be posted where local sharing is off, but not when remote links are switched off", async () => {
    const relay = newNetwork();
    const creator = await Device.create(relay.ip());
    const [space] = (await creator.observe()).spaceIds;
    await adminDb().query("update app.network_spaces set status = 'blocked' where id = $1", [space]);
    expect((await creator.call("POST", "/api/v1/texts", { destination: "network", content: "x" })).status).toBe(409);
    expect((await creator.call("POST", "/api/v1/texts", { destination: "link_only", content: "x" })).status).toBe(201);

    await setFlag("remote_links_enabled", false);
    const off = await creator.call("POST", "/api/v1/texts", { destination: "link_only", content: "x" });
    expect(off.status).toBe(503);
    expect(off.body.error.code).toBe("REMOTE_LINKS_DISABLED");
  });
});

describe("remote file policy (T-035, Q-010)", () => {
  it("an executable can't get a link; the local share keeps working with its warning", async () => {
    const home = newNetwork();
    const creator = await Device.create(home.ip());
    const program = await creator.uploadFile("setup.exe", PE_BYTES);
    const shareId = program.init.body.share.id;
    const refused = await creator.call("POST", `/api/v1/shares/${shareId}/links`, {});
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: "REMOTE_FILE_BLOCKED", details: { blockedFlags: ["executable"] } });
    // Phase 1 behaviour is unchanged on the network: visible, flagged, downloadable.
    const neighbour = await Device.create(home.ip());
    expect(await neighbour.feedIds()).toContain(shareId);
    expect((await neighbour.call("POST", `/api/v1/files/${program.upload.fileId}/download-url`, {})).status).toBe(200);
  });

  it("refuses executables in link-only shares, by name at once and by content at completion", async () => {
    const creator = await Device.create(newNetwork().ip());
    const byName = await creator.call("POST", "/api/v1/shares", { destination: "link_only", files: [{ name: "run.bat", size: 3, type: "" }] });
    expect(byName.status).toBe(422);
    expect(byName.body.error.code).toBe("REMOTE_FILE_BLOCKED");

    const disguised = await creator.uploadFile("notes.txt", PE_BYTES, "text/plain", PE_BYTES.length, "link_only");
    expect(disguised.complete.status).toBe(422);
    expect(disguised.complete.body.error).toMatchObject({ code: "UPLOAD_REJECTED", details: { reason: "remote_file_blocked" } });

    // The same bytes posted to the network are accepted, with the executable flag (Phase 1 policy).
    const local = await creator.uploadFile("notes.txt", PE_BYTES, "text/plain");
    expect(local.complete.status).toBe(200);
    expect(local.complete.body.share.files[0].riskFlags).toContain("executable");
  });

  it("allows archives by link, with the archive flag for the viewer's warning", async () => {
    const creator = await Device.create(newNetwork().ip());
    const archive = await creator.uploadFile("photos.zip", ZIP_BYTES, "application/zip");
    const link = await creator.createLink(archive.init.body.share.id);
    const viewer = new Viewer();
    const unlocked = await viewer.unlock(link.id, link.secret);
    expect(unlocked.body.share.files[0].riskFlags).toEqual(["archive"]);
    expect((await viewer.fileUrl(link.id, archive.upload.fileId)).status).toBe(200);
  });
});

describe("per-link limits and the kill switch (Q-027, 03 §10)", () => {
  it("caps download and preview URLs per link per day (429 LINK_DAILY_LIMIT)", async () => {
    const creator = await Device.create(newNetwork().ip());
    const image = await creator.uploadFile("p.png", PNG_BYTES, "image/png");
    const link = await creator.createLink(image.init.body.share.id);
    await adminDb().query(
      "update app.share_links set entitlement_snapshot = jsonb_set(entitlement_snapshot, '{limits,linkDailyUrlIssuances}', '2') where id = $1",
      [link.id],
    );
    const viewer = new Viewer();
    await viewer.unlock(link.id, link.secret);
    expect((await viewer.fileUrl(link.id, image.upload.fileId)).status).toBe(200);
    expect((await viewer.fileUrl(link.id, image.upload.fileId, "preview-url")).status).toBe(200);
    const capped = await viewer.fileUrl(link.id, image.upload.fileId);
    expect(capped.status).toBe(429);
    expect(capped.body.error.code).toBe("LINK_DAILY_LIMIT");
    expect(Number(capped.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("limits unlock attempts per link (429 with Retry-After, T-049)", { timeout: 60_000 }, async () => {
    const creator = await Device.create(newNetwork().ip());
    const link = await creator.createLink((await creator.postText("popular")).id);
    for (let i = 0; i < 30; i++) expect((await new Viewer().unlock(link.id, randomBytes(32).toString("base64url"))).status).toBe(404);
    const limited = await new Viewer().unlock(link.id, link.secret);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("switching remote links off stops creation, unlocking, content and downloads at once (503)", async () => {
    const creator = await Device.create(newNetwork().ip());
    const file = await creator.uploadFile("k.txt", Buffer.from("kill"), "text/plain");
    const shareId = file.init.body.share.id;
    const link = await creator.createLink(shareId);
    const viewer = new Viewer();
    await viewer.unlock(link.id, link.secret);

    await setFlag("remote_links_enabled", false);
    for (const response of [
      await creator.call("POST", `/api/v1/shares/${shareId}/links`, {}),
      await new Viewer().unlock(link.id, link.secret),
      await viewer.content(link.id),
      await viewer.fileUrl(link.id, file.upload.fileId),
    ]) {
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("REMOTE_LINKS_DISABLED");
    }
    // Revoking stays possible while links are off.
    expect((await creator.call("DELETE", `/api/v1/links/${link.id}`)).status).toBe(204);
    await setFlag("remote_links_enabled", true);
    expect((await viewer.content(link.id)).status).toBe(410);
  });

  it("anonymous callers without a session get 401 on creator endpoints", async () => {
    const creator = await Device.create(newNetwork().ip());
    const share = await creator.postText("x");
    expect((await api("POST", `/api/v1/shares/${share.id}/links`, { body: {} })).status).toBe(401);
  });
});
