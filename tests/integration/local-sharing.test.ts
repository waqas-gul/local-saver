import { randomInt, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminDb, closeAdminDb, Device, newNetwork, setFlag, setLargeNetworkCap } from "./support/api";

/** Local visibility and isolation (09 §4.1–§4.2, §4.8). Every test uses fresh random networks. */

afterAll(closeAdminDb);

/** 404 bodies must not reveal anything: compare everything except the request ID. */
function withoutRequestId(body: { error?: Record<string, unknown> }) {
  const { requestId: _ignored, ...rest } = body.error ?? {};
  return rest;
}

describe("same network: automatic visibility (DEC-031)", () => {
  it("a second device sees existing local shares with no join step (T-002, AC-1.1)", async () => {
    const net = newNetwork();
    const a = await Device.create(net.ip());
    const share = await a.postText("hello from A");

    const b = await Device.create(net.ip());
    const status = await b.observe();
    expect(status).toMatchObject({ status: "ok", devicesHere: 2 });
    expect(status.spaceIds).toHaveLength(1);

    expect(await b.feedIds()).toContain(share.id);
    const detail = await b.call("GET", `/api/v1/shares/${share.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.share).toMatchObject({
      id: share.id,
      kind: "text",
      status: "active",
      isMine: false,
      fromLabel: a.label,
      text: { content: "hello from A", version: 1 },
    });
  });

  it("devices on one IPv6 /64 share a network; the feed is newest first", async () => {
    const net = newNetwork();
    const a = await Device.create(net.ip());
    const first = await a.postText("first");
    const second = await a.postText("second");
    const b = await Device.create(net.ip());
    const ids = await b.feedIds();
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
  });
});

describe("other networks see nothing (T-001, G1, G7)", () => {
  it("hides the feed, details and file URLs from another network, with the same 404 as a missing share", async () => {
    const a = await Device.create(newNetwork().ip());
    const text = await a.postText("private to network A");
    const upload = await a.uploadFile("notes.txt", new TextEncoder().encode("file bytes"), "text/plain");
    expect(upload.complete.status).toBe(200);
    const fileId = upload.upload.fileId;

    const x = await Device.create(newNetwork().ip());
    expect(await x.feedIds()).not.toContain(text.id);

    const missing = await x.call("GET", `/api/v1/shares/${randomUUID()}`);
    expect(missing.status).toBe(404);
    for (const [method, path] of [
      ["GET", `/api/v1/shares/${text.id}`],
      ["GET", `/api/v1/shares/${upload.init.body.share.id}`],
      ["POST", `/api/v1/files/${fileId}/download-url`],
      ["POST", `/api/v1/files/${fileId}/preview-url`],
    ] as const) {
      const response = await x.call(method, path, method === "POST" ? {} : undefined);
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(withoutRequestId(response.body), `${method} ${path}`).toEqual(withoutRequestId(missing.body));
    }
  });
});

describe("leaving the network (T-003, G3)", () => {
  it("loses access on the next request and ends presence on the old network", async () => {
    const home = newNetwork();
    const away = newNetwork();
    const a = await Device.create(home.ip());
    const share = await a.postText();
    const b = await Device.create(home.ip());
    expect(await b.feedIds()).toContain(share.id);

    const before = (await b.observe()).spaceIds;
    const after = await b.moveTo(away.ip());
    expect(after.status).toBe("ok");
    expect(after.spaceIds).not.toEqual(before);

    expect((await b.call("GET", `/api/v1/shares/${share.id}`)).status).toBe(404);
    expect(await b.feedIds()).not.toContain(share.id);
    expect((await a.observe()).devicesHere).toBe(1);

    await b.moveTo(home.ip());
    expect(await b.feedIds()).toContain(share.id);
  });
});

describe("no dual-stack binding without SP-04 (T-009 fallback, DV1-3)", () => {
  it("one household's IPv4 and IPv6 networks stay separate: only the current request's key counts", async () => {
    const v6 = newNetwork();
    const v4 = `203.0.113.${randomInt(2, 254)}`; // the same Wi-Fi, reached over IPv4
    const laptop = await Device.create(v6.ip());
    const overV6 = await laptop.postText("posted over IPv6");

    const phone = await Device.create(v4);
    expect(await phone.feedIds()).not.toContain(overV6.id);
    expect((await phone.call("GET", `/api/v1/shares/${overV6.id}`)).status).toBe(404);
    const overV4 = await phone.postText("posted over IPv4");

    // A device switching address family sees that family's network only, never a merged view.
    await laptop.moveTo(v4);
    expect(await laptop.feedIds()).toEqual(expect.arrayContaining([overV4.id]));
    expect(await laptop.feedIds()).not.toContain(overV6.id);
    await laptop.moveTo(v6.ip());
    expect(await laptop.feedIds()).toContain(overV6.id);
    expect(await laptop.feedIds()).not.toContain(overV4.id);
    // Its own post stays reachable from anywhere through My uploads (T-014).
    await laptop.moveTo(v4);
    expect(await laptop.myShareIds()).toContain(overV6.id);
  });
});

describe("fail-closed guards (DEC-032, G5)", () => {
  it("too_large hides existing shares and refuses posting; the creator keeps them (T-004, T-014)", async () => {
    const net = newNetwork();
    await setLargeNetworkCap(2);
    try {
      const a = await Device.create(net.ip());
      const share = await a.postText();
      const b = await Device.create(net.ip());
      expect(await b.feedIds()).toContain(share.id);

      const c = await Device.create(net.ip(), { observe: false });
      expect(await c.observe()).toMatchObject({ status: "too_large", spaceIds: [], devicesHere: 0 });

      const feed = await b.call("GET", "/api/v1/local/shares");
      expect(feed.body).toMatchObject({ networkStatus: "too_large", shares: [] });
      expect((await b.call("GET", `/api/v1/shares/${share.id}`)).status).toBe(404);
      const post = await b.call("POST", "/api/v1/texts", { destination: "network", content: "x" });
      expect(post.status).toBe(409);
      expect(post.body.error.code).toBe("LOCAL_SHARING_UNAVAILABLE");

      expect(await a.myShareIds()).toContain(share.id);
      expect((await a.call("GET", `/api/v1/shares/${share.id}`)).status).toBe(200);
    } finally {
      await setLargeNetworkCap(50);
    }
  });

  it("an address on an egress list is shared_egress (T-005)", async () => {
    const net = newNetwork();
    await adminDb().query("insert into app.network_egress_ranges (cidr, source) values ($1, 'vpn')", [net.prefix]);
    try {
      const d = await Device.create(net.ip(), { observe: false });
      expect(await d.observe()).toMatchObject({ status: "shared_egress", spaceIds: [] });
      const post = await d.call("POST", "/api/v1/texts", { destination: "network", content: "x" });
      expect(post.status).toBe(409);
    } finally {
      await adminDb().query("delete from app.network_egress_ranges where cidr = $1", [net.prefix]);
    }
  });

  it("no trusted IP, or a non-global one, is unavailable (T-007)", async () => {
    const d = await Device.create(null, { observe: false });
    expect(await d.observe()).toMatchObject({ status: "unavailable", reason: "no_trusted_ip", spaceIds: [] });
    expect(await d.moveTo("192.168.1.5")).toMatchObject({ status: "unavailable", reason: "non_global_ip" });
    const feed = await d.call("GET", "/api/v1/local/shares");
    expect(feed.body).toMatchObject({ networkStatus: "unavailable", shares: [] });
  });

  it("the local_sharing_enabled kill switch hides content and refuses posting (T-013)", async () => {
    const net = newNetwork();
    const a = await Device.create(net.ip());
    const share = await a.postText();
    const b = await Device.create(net.ip());
    await setFlag("local_sharing_enabled", false);
    try {
      expect(await b.observe()).toMatchObject({ status: "unavailable", reason: "disabled" });
      expect(await b.feedIds()).toEqual([]);
      expect((await b.call("GET", `/api/v1/shares/${share.id}`)).status).toBe(404);
      expect((await b.call("POST", "/api/v1/texts", { destination: "network", content: "x" })).status).toBe(409);
    } finally {
      await setFlag("local_sharing_enabled", true);
    }
    expect(await b.feedIds()).toContain(share.id);
  });

  it("a blocked network hides content and refuses posting; the creator keeps My uploads (T-013, T-014)", async () => {
    const net = newNetwork();
    const a = await Device.create(net.ip());
    const share = await a.postText();
    const b = await Device.create(net.ip());
    const [spaceId] = (await b.observe()).spaceIds;
    await adminDb().query("update app.network_spaces set status = 'blocked', status_reason = 'test' where id = $1", [spaceId]);

    expect(await b.observe()).toMatchObject({ status: "blocked", spaceIds: [] });
    expect(await b.feedIds()).toEqual([]);
    expect((await b.call("GET", `/api/v1/shares/${share.id}`)).status).toBe(404);
    expect((await b.call("POST", "/api/v1/texts", { destination: "network", content: "x" })).status).toBe(409);
    expect(await a.myShareIds()).toContain(share.id);
  });
});

describe("creator-only actions (T-011, DEC-033)", () => {
  it("only the creator edits (versioned) and deletes; others on the network get 403 NOT_CREATOR", async () => {
    const net = newNetwork();
    const a = await Device.create(net.ip());
    const share = await a.postText("v1");
    const b = await Device.create(net.ip());

    const otherEdit = await b.call("PATCH", `/api/v1/shares/${share.id}/text`, { content: "hijack", version: 1 });
    expect(otherEdit.status).toBe(403);
    expect(otherEdit.body.error.code).toBe("NOT_CREATOR");
    const otherDelete = await b.call("DELETE", `/api/v1/shares/${share.id}`);
    expect(otherDelete.status).toBe(403);
    expect(otherDelete.body.error.code).toBe("NOT_CREATOR");

    const edit = await a.call("PATCH", `/api/v1/shares/${share.id}/text`, { content: "v2", version: 1 });
    expect(edit.status).toBe(200);
    expect(edit.body.share.text).toEqual({ content: "v2", version: 2 });

    const stale = await a.call("PATCH", `/api/v1/shares/${share.id}/text`, { content: "v3", version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "VERSION_CONFLICT", details: { currentVersion: 2 } });

    const fromB = await b.call("GET", `/api/v1/shares/${share.id}`);
    expect(fromB.body.share.text.content).toBe("v2");

    expect((await a.call("DELETE", `/api/v1/shares/${share.id}`)).status).toBe(204);
    expect((await b.call("GET", `/api/v1/shares/${share.id}`)).status).toBe(404);
    expect((await a.call("GET", `/api/v1/shares/${share.id}`)).status).toBe(404);
    expect(await b.feedIds()).not.toContain(share.id);

    const row = await adminDb().query("select content from app.text_items where share_id = $1", [share.id]);
    expect(row.rows[0].content).toBeNull();
  });

  it("the creator edits and deletes from any network (T-014)", async () => {
    const a = await Device.create(newNetwork().ip());
    const share = await a.postText("from home");
    await a.moveTo(newNetwork().ip());
    expect(await a.myShareIds()).toContain(share.id);
    expect((await a.call("PATCH", `/api/v1/shares/${share.id}/text`, { content: "edited away", version: 1 })).status).toBe(200);
    expect((await a.call("DELETE", `/api/v1/shares/${share.id}`)).status).toBe(204);
  });
});

describe("expiry at request time (T-041)", () => {
  it("denies every access path once expires_at has passed, before any job runs", async () => {
    const net = newNetwork();
    const a = await Device.create(net.ip());
    const text = await a.postText();
    const upload = await a.uploadFile("x.bin", new Uint8Array([1, 2, 3]));
    const b = await Device.create(net.ip());
    await adminDb().query(
      "update app.shares set expires_at = now() - interval '1 second' where id = any($1::uuid[])",
      [[text.id, upload.init.body.share.id]],
    );

    expect(await b.feedIds()).not.toContain(text.id);
    expect((await b.call("GET", `/api/v1/shares/${text.id}`)).status).toBe(404);
    expect((await a.call("GET", `/api/v1/shares/${text.id}`)).status).toBe(404);
    expect(await a.myShareIds()).not.toContain(text.id);
    expect((await a.call("POST", `/api/v1/files/${upload.upload.fileId}/download-url`, {})).status).toBe(404);
  });

  it("offers 1 h, 24 h and 7 days, defaulting to 24 h (Q-030, assumed)", async () => {
    const a = await Device.create(newNetwork().ip());
    const share = await a.postText("default expiry");
    const detail = await a.call("GET", `/api/v1/shares/${share.id}`);
    const hours = (Date.parse(detail.body.share.expiresAt) - Date.parse(detail.body.share.createdAt)) / 3_600_000;
    expect(hours).toBeCloseTo(24, 1);

    const week = await a.call("POST", "/api/v1/texts", { destination: "network", content: "x", expiresIn: 604800 });
    expect(week.status).toBe(201);
    const month = await a.call("POST", "/api/v1/texts", { destination: "network", content: "x", expiresIn: 2592000 });
    expect(month.status).toBe(422);
    expect(month.body.error.code).toBe("EXPIRY_NOT_ALLOWED"); // 07 §4 error contract
  });
});
