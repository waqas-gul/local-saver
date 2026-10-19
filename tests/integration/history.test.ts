import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { requestDeletion } from "./support/billing";
import { accountDevice, grantOverride, proDevice, setCounter } from "./support/entitlements";
import { adminDb, type ApiResponse, closeAdminDb, Device, newNetwork, PNG_BYTES, Viewer } from "./support/api";
import { createInvite, createRoom, createRoomLink, join, postRoomText, uploadToRoom } from "./support/rooms";

/**
 * Transfer history (phase 4 §17.8.6, P4-20). T4-H1: the caller's own shares, in every state, within the current plan's
 * window, by cursor; Free refused. T4-H2: download records of the caller's own shares only, by actor kind, with no
 * identity, IP or network key in any field (D4-20). E24 and the downgrade (07 §5: hidden, kept). The IDOR matrix has
 * the routes' rows.
 */

const code = (response: ApiResponse) => response.body?.error?.code as string | undefined;
const unique = (prefix: string) => `${prefix} ${randomBytes(4).toString("hex")}`;

type HistoryShare = {
  id: string;
  kind: "files" | "text";
  title: string | null;
  scope: string;
  room?: { id: string; label: string };
  status: string;
  createdAt: string;
  expiresAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  burnAfterDownload: boolean;
  fileCount: number;
  totalBytes: number;
};
type HistoryDownload = {
  id: string;
  at: string;
  share: { id: string; title: string | null };
  file: { id: string; name: string } | null;
  event: string;
  actorKind: string;
  link: { kind: "share" | "room"; id: string | null } | null;
  browser: string | null;
};
type Page<T> = { items: T[]; nextCursor: string | null };

async function get<T>(device: Device, path: string): Promise<Page<T>> {
  const response = await device.call("GET", path);
  expect(response.status, response.text).toBe(200);
  return response.body as Page<T>;
}

/** Every page, `limit` at a time, following nextCursor. */
async function all<T>(device: Device, route: "shares" | "downloads", query = "", limit = 100): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams(query);
    params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    const page: Page<T> = await get<T>(device, `/api/v1/history/${route}?${params}`);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

async function uploadShare(device: Device, name: string, destination: "network" | "link_only" = "network") {
  const { init, upload, complete } = await device.uploadFile(name, PNG_BYTES, "image/png", PNG_BYTES.length, destination);
  expect(complete.status, complete.text).toBe(200);
  return { shareId: init.body.share.id as string, fileId: upload.fileId };
}

async function viewerDownload(linkId: string, secret: string, fileId: string) {
  const viewer = new Viewer(newNetwork().ip());
  expect((await viewer.unlock(linkId, secret)).status).toBe(200);
  const url = await viewer.fileUrl(linkId, fileId);
  expect(url.status, url.text).toBe(200);
}

afterAll(closeAdminDb);

describe("who may see history (E24)", () => {
  it("Free accounts and anonymous browsers get 403 with the Pro hint; a downgrade hides history and an upgrade shows the same rows again", async () => {
    const refused = { status: 403, code: "FEATURE_NOT_IN_PLAN", details: { feature: "transferHistory", requiredPlan: "pro" } };
    const free = (await accountDevice()).device;
    const anonymous = await Device.create(newNetwork().ip());
    for (const caller of [free, anonymous]) {
      for (const route of ["shares", "downloads"]) {
        const response = await caller.call("GET", `/api/v1/history/${route}`);
        expect({ status: response.status, code: code(response), details: response.body.error?.details }).toEqual(refused);
      }
    }
    // Free's own shares never show, even with a shareId.
    const note = await free.postText();
    expect(code(await free.call("GET", `/api/v1/history/downloads?shareId=${note.id}`))).toBe("FEATURE_NOT_IN_PLAN");

    const pro = await proDevice();
    const kept = await pro.device.postText();
    const before = await all<HistoryShare>(pro.device, "shares");
    expect(before.map((s) => s.id)).toEqual([kept.id]);
    await pro.downgrade();
    for (const route of ["shares", "downloads"]) expect(code(await pro.device.call("GET", `/api/v1/history/${route}`))).toBe("FEATURE_NOT_IN_PLAN");
    await grantOverride(pro.userId);
    expect(await all<HistoryShare>(pro.device, "shares")).toEqual(before);

    // An account being deleted (E30) is read-only, so it still reads its history.
    await requestDeletion(pro.userId);
    expect((await all<HistoryShare>(pro.device, "shares")).map((s) => s.id)).toEqual([kept.id]);
  });

  it("is rate limited per device (60 a minute for each route)", async () => {
    const pro = await proDevice();
    await setCounter(`historyShares:${pro.device.deviceId}`, "1 minute", 60);
    expect(code(await pro.device.call("GET", "/api/v1/history/shares"))).toBe("RATE_LIMITED");
    expect((await pro.device.call("GET", "/api/v1/history/downloads")).status).toBe(200);
    await setCounter(`historyDownloads:${pro.device.deviceId}`, "1 minute", 60);
    expect(code(await pro.device.call("GET", "/api/v1/history/downloads"))).toBe("RATE_LIMITED");
  });
});

describe("T4-H1: share history", () => {
  it("lists only the caller's own shares, in every state, newest first, and never a text's content", async () => {
    const home = newNetwork();
    const owner = await proDevice(home.ip());
    const neighbour = await Device.create(home.ip());
    const stranger = await proDevice();
    const secret = unique("never in history");
    const states: Record<string, { status: string; endReason: string | null }> = {};

    const text = await owner.device.postText(secret);
    states[text.id] = { status: "active", endReason: null };
    const file = await uploadShare(owner.device, "holiday.png");
    states[file.shareId] = { status: "active", endReason: null };
    const linkOnly = await owner.device.postText(unique("link only"), undefined, "link_only");
    states[linkOnly.id] = { status: "active", endReason: null };
    const room = await createRoom(owner.device, { name: "History room" });
    const roomText = await postRoomText(owner.device, room.id);
    states[roomText.id] = { status: "active", endReason: null };

    const deleted = await owner.device.postText();
    expect((await owner.device.call("DELETE", `/api/v1/shares/${deleted.id}`)).status).toBe(204);
    states[deleted.id] = { status: "deleted", endReason: "deleted_by_creator" };
    const lapsed = await owner.device.postText();
    states[lapsed.id] = { status: "expired", endReason: "expired" };
    // A burn text revealed on the network: claimed during its grace, consumed after it (before the job runs).
    const burning = await owner.device.call("POST", "/api/v1/texts", { destination: "network", content: secret, burnAfterDownload: true });
    expect(burning.status, burning.text).toBe(201);
    expect((await neighbour.call("POST", `/api/v1/shares/${burning.body.share.id}/reveal`, { confirm: true })).status).toBe(200);
    states[burning.body.share.id] = { status: "claimed", endReason: null };
    const burnt = await owner.device.call("POST", "/api/v1/texts", { destination: "network", content: secret, burnAfterDownload: true });
    expect((await neighbour.call("POST", `/api/v1/shares/${burnt.body.share.id}/reveal`, { confirm: true })).status).toBe(200);
    await adminDb().query("update app.shares set claim_grace_until = now() - interval '1 second' where id = $1", [burnt.body.share.id]);
    states[burnt.body.share.id] = { status: "consumed", endReason: "consumed" };
    const blocked = await owner.device.postText();
    await adminDb().query("select app.admin_block_share($1, 'history test', 'tests')", [blocked.id]);
    states[blocked.id] = { status: "blocked", endReason: "blocked" };
    const pending = await owner.device.call("POST", "/api/v1/shares", { destination: "network", files: [{ name: "never.bin", size: 10, type: "application/octet-stream" }] });
    states[pending.body.share.id] = { status: "pending_upload", endReason: null };
    const failed = await owner.device.call("POST", "/api/v1/shares", { destination: "network", files: [{ name: "broken.bin", size: 10, type: "application/octet-stream" }] });
    await adminDb().query("select app.end_share($1, 'upload_failed')", [failed.body.share.id]);
    states[failed.body.share.id] = { status: "failed", endReason: "upload_failed" };
    await stranger.device.postText();

    // Past its time: before the minute's expiry job reads as expired, ended at its expiry; after it, as the job left it.
    await adminDb().query("update app.shares set expires_at = now() - interval '1 second' where id = $1", [lapsed.id]);
    const response = await owner.device.call("GET", "/api/v1/history/shares");
    const lapsedRow = (await adminDb().query("select status, ended_at from app.shares where id = $1", [lapsed.id])).rows[0];
    expect(response.text).not.toContain(secret);
    const items = (response.body as Page<HistoryShare>).items;
    expect(new Set(items.map((s) => s.id))).toEqual(new Set(Object.keys(states)));
    expect(Object.fromEntries(items.map((s) => [s.id, { status: s.status, endReason: s.endReason }]))).toEqual(states);
    const times = items.map((s) => s.createdAt);
    expect(times).toEqual([...times].sort().reverse());

    const byId = new Map(items.map((s) => [s.id, s]));
    expect(byId.get(file.shareId)).toMatchObject({ kind: "files", title: "holiday.png", scope: "network", fileCount: 1, totalBytes: PNG_BYTES.length, endedAt: null });
    expect(byId.get(text.id)).toMatchObject({ kind: "text", title: null, scope: "network" });
    expect(byId.get(text.id)?.room).toBeUndefined();
    expect(byId.get(linkOnly.id)).toMatchObject({ scope: "link_only" });
    expect(byId.get(roomText.id)).toMatchObject({ scope: "room", room: { id: room.id, label: "History room" } });
    const shownLapsed = byId.get(lapsed.id) as HistoryShare;
    if (lapsedRow.status === "active") expect(shownLapsed.endedAt).toBe(shownLapsed.expiresAt);
    else expect(shownLapsed.endedAt).toBe((lapsedRow.ended_at as Date).toISOString());
    expect(byId.get(burnt.body.share.id)).toMatchObject({ burnAfterDownload: true });
    expect(byId.get(deleted.id)?.endedAt).not.toBeNull();
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(
        ["burnAfterDownload", "createdAt", "endReason", "endedAt", "expiresAt", "fileCount", "id", "kind", "scope", "status", "title", "totalBytes", ...(item.room ? ["room"] : [])].sort(),
      );
    }
  });

  it("filters by state and kind, pages by cursor, and keeps to the current plan's window", async () => {
    const owner = await proDevice();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await owner.device.postText()).id);
    const file = await uploadShare(owner.device, "page.png");
    ids.push(file.shareId);
    const ended = ids[0] as string;
    expect((await owner.device.call("DELETE", `/api/v1/shares/${ended}`)).status).toBe(204);

    const whole = (await get<HistoryShare>(owner.device, "/api/v1/history/shares")).items.map((s) => s.id);
    expect(whole).toEqual([...ids].reverse());
    expect((await all<HistoryShare>(owner.device, "shares", "", 2)).map((s) => s.id)).toEqual(whole);
    expect((await all<HistoryShare>(owner.device, "shares", "status=ended")).map((s) => s.id)).toEqual([ended]);
    expect((await all<HistoryShare>(owner.device, "shares", "status=active")).map((s) => s.id)).toEqual(whole.filter((id) => id !== ended));
    expect((await all<HistoryShare>(owner.device, "shares", "kind=files")).map((s) => s.id)).toEqual([file.shareId]);
    expect((await all<HistoryShare>(owner.device, "shares", "kind=text&status=active", 1)).map((s) => s.id)).toEqual(
      whole.filter((id) => id !== ended && id !== file.shareId),
    );

    for (const [query, expected] of [
      ["status=open", "VALIDATION_FAILED"], ["kind=image", "VALIDATION_FAILED"], ["cursor=not-a-cursor", "INVALID_CURSOR"],
      ["limit=0", "INVALID_LIMIT"], ["limit=101", "INVALID_LIMIT"],
    ] as const) {
      const response = await owner.device.call("GET", `/api/v1/history/shares?${query}`);
      expect({ status: response.status, code: code(response) }, query).toEqual({ status: 400, code: expected });
    }

    // Pro's window is 365 days: a share made 366 days ago is out of it, one made 364 days ago is in.
    await adminDb().query("update app.shares set created_at = now() - interval '366 days' where id = $1", [ended]);
    await adminDb().query("update app.shares set created_at = now() - interval '364 days' where id = $1", [ids[1]]);
    const windowed = (await all<HistoryShare>(owner.device, "shares")).map((s) => s.id);
    expect(windowed).not.toContain(ended);
    expect(windowed[windowed.length - 1]).toBe(ids[1]);
  });
});

describe("T4-H2: download history", () => {
  it("records what happened to the caller's own shares by actor kind and link kind, and nothing about who", async () => {
    const home = newNetwork();
    const ip = home.ip();
    const owner = await proDevice(ip);
    const neighbour = await Device.create(home.ip());
    const member = await proDevice();
    const stranger = await proDevice(home.ip());

    // On the network: the creator, a neighbour's download and preview, and a burn text revealed.
    const file = await uploadShare(owner.device, "photo.png");
    expect((await owner.device.call("POST", `/api/v1/files/${file.fileId}/download-url`, {})).status).toBe(200);
    expect((await neighbour.call("POST", `/api/v1/files/${file.fileId}/download-url`, {})).status).toBe(200);
    expect((await neighbour.call("POST", `/api/v1/files/${file.fileId}/preview-url`, {})).status).toBe(200);
    const burn = await owner.device.call("POST", "/api/v1/texts", { destination: "network", content: unique("burn"), burnAfterDownload: true });
    expect((await neighbour.call("POST", `/api/v1/shares/${burn.body.share.id}/reveal`, { confirm: true })).status).toBe(200);
    // Through the owner's own share link.
    const link = await owner.device.createLink(file.shareId);
    await viewerDownload(link.id, link.secret, file.fileId);

    // In the owner's room: a member's file downloaded by the owner and through the owner's room link (someone else's link,
    // to the member: only the creator makes share links for a share, P4-17).
    const room = await createRoom(owner.device);
    await join(member.device, await createInvite(owner.device, room.id));
    const memberFile = await uploadToRoom(member.device, room.id, "member.png", PNG_BYTES, "image/png");
    const ownerRoomFile = await uploadToRoom(owner.device, room.id, "owner.png", PNG_BYTES, "image/png");
    expect((await owner.device.call("POST", `/api/v1/files/${memberFile.fileId}/download-url`, {})).status).toBe(200);
    const roomLink = await createRoomLink(owner.device, room.id);
    await viewerDownload(roomLink.id, roomLink.secret, memberFile.fileId);
    await viewerDownload(roomLink.id, roomLink.secret, ownerRoomFile.fileId);

    // Someone else's share, downloaded on the same network: never in the owner's history.
    const theirs = await uploadShare(stranger.device, "theirs.png");
    expect((await owner.device.call("POST", `/api/v1/files/${theirs.fileId}/download-url`, {})).status).toBe(200);

    const ownerResponse = await owner.device.call("GET", "/api/v1/history/downloads");
    expect(ownerResponse.status).toBe(200);
    const mine = (ownerResponse.body as Page<HistoryDownload>).items;
    const row = (d: HistoryDownload) => [d.share.id, d.file?.id ?? null, d.event, d.actorKind, d.link?.kind ?? null, d.link?.id ?? null];
    expect(mine.map(row).sort()).toEqual(
      [
        [file.shareId, file.fileId, "url_issued", "creator", null, null],
        [file.shareId, file.fileId, "url_issued", "network_device", null, null],
        [file.shareId, file.fileId, "preview_issued", "network_device", null, null],
        [burn.body.share.id, null, "text_revealed", "network_device", null, null],
        [file.shareId, file.fileId, "url_issued", "link_viewer", "share", link.id],
        [ownerRoomFile.shareId, ownerRoomFile.fileId, "url_issued", "link_viewer", "room", roomLink.id],
      ].sort(),
    );
    expect(mine.find((d) => d.share.id === file.shareId)).toMatchObject({ share: { title: "photo.png" }, file: { name: "photo.png" } });
    const times = mine.map((d) => d.at);
    expect(times).toEqual([...times].sort().reverse());

    // The member's history: the owner's download is a room member's; the owner's room link shows its kind, not its ID.
    const memberRows = (await all<HistoryDownload>(member.device, "downloads")).map(row);
    expect(memberRows.sort()).toEqual(
      [
        [memberFile.shareId, memberFile.fileId, "url_issued", "room_member", null, null],
        [memberFile.shareId, memberFile.fileId, "url_issued", "link_viewer", "room", null],
      ].sort(),
    );

    // D4-20: no identity, IP, network key, device name or secret anywhere, only these fields.
    const spaces = [...(await owner.device.observe()).spaceIds, ...(await member.device.observe()).spaceIds];
    const forbidden = [
      owner.userId, owner.device.deviceId, owner.device.label, owner.email, neighbour.userId, neighbour.deviceId, neighbour.label,
      member.userId, member.device.deviceId, member.email, stranger.userId, ip, link.secret, roomLink.secret, ...spaces,
    ];
    for (const value of forbidden) expect(ownerResponse.text, value).not.toContain(value);
    const memberText = (await member.device.call("GET", "/api/v1/history/downloads")).text;
    for (const value of [...forbidden, roomLink.id, link.id]) {
      expect(memberText, value).not.toContain(value);
    }
    for (const item of mine) expect(Object.keys(item).sort()).toEqual(["actorKind", "at", "browser", "event", "file", "id", "link", "share"]);
  });

  it("narrows to one of the caller's shares; anyone else's, unknown and malformed IDs are one 404; pages by cursor and window", async () => {
    const home = newNetwork();
    const owner = await proDevice(home.ip());
    const neighbour = await Device.create(home.ip());
    const other = await proDevice(home.ip());
    const first = await uploadShare(owner.device, "first.png");
    const second = await uploadShare(owner.device, "second.png");
    for (let i = 0; i < 3; i++) expect((await neighbour.call("POST", `/api/v1/files/${first.fileId}/download-url`, {})).status).toBe(200);
    expect((await neighbour.call("POST", `/api/v1/files/${second.fileId}/download-url`, {})).status).toBe(200);
    const theirs = await uploadShare(other.device, "theirs.png");
    expect((await neighbour.call("POST", `/api/v1/files/${theirs.fileId}/download-url`, {})).status).toBe(200);

    const narrowed = await all<HistoryDownload>(owner.device, "downloads", `shareId=${first.shareId}`, 1);
    expect(narrowed.map((d) => d.share.id)).toEqual([first.shareId, first.shareId, first.shareId]);
    expect(new Set(narrowed.map((d) => d.id)).size).toBe(3);
    expect((await all<HistoryDownload>(owner.device, "downloads", "", 2)).map((d) => d.id)).toEqual(
      (await get<HistoryDownload>(owner.device, "/api/v1/history/downloads")).items.map((d) => d.id),
    );

    const unknown = await owner.device.call("GET", `/api/v1/history/downloads?shareId=${randomUUID()}`);
    expect({ status: unknown.status, code: code(unknown) }).toEqual({ status: 404, code: "NOT_FOUND" });
    for (const probe of [theirs.shareId, "not-a-uuid", ""]) {
      const response = await owner.device.call("GET", `/api/v1/history/downloads?shareId=${probe}`);
      expect({ status: response.status, body: { ...response.body, error: { ...response.body.error, requestId: "" } } }, probe).toEqual({
        status: 404,
        body: { ...unknown.body, error: { ...unknown.body.error, requestId: "" } },
      });
    }
    expect(code(await owner.device.call("GET", `/api/v1/history/downloads?cursor=${Buffer.from(JSON.stringify({ t: new Date().toISOString(), id: randomUUID() })).toString("base64url")}`))).toBe(
      "INVALID_CURSOR",
    );

    // Pro's window: a record written 366 days ago is out of it.
    const oldest = narrowed[narrowed.length - 1] as HistoryDownload;
    await adminDb().query("update app.downloads set created_at = now() - interval '366 days' where id = $1", [oldest.id]);
    expect((await all<HistoryDownload>(owner.device, "downloads", `shareId=${first.shareId}`)).map((d) => d.id)).not.toContain(oldest.id);
  });
});

describe("T4-H3: kept by the snapshot", () => {
  it("a Pro share's download records are kept 365 days and its tombstone outlives them (C4-12), whatever the plan is later", async () => {
    const home = newNetwork();
    const owner = await proDevice(home.ip());
    const neighbour = await Device.create(home.ip());
    const file = await uploadShare(owner.device, "kept.png");
    expect((await neighbour.call("POST", `/api/v1/files/${file.fileId}/download-url`, {})).status).toBe(200);
    const link = await owner.device.createLink(file.shareId);
    await viewerDownload(link.id, link.secret, file.fileId);
    // The dates come from the snapshots (07 §5), not the plan of the day: after a downgrade too.
    await owner.downgrade();
    expect((await neighbour.call("POST", `/api/v1/files/${file.fileId}/download-url`, {})).status).toBe(200);
    expect((await owner.device.call("DELETE", `/api/v1/shares/${file.shareId}`)).status).toBe(204);

    const { rows } = await adminDb().query(
      `select round(extract(epoch from s.metadata_purge_after - s.ended_at) / 86400)::int as share_days,
              (select array_agg(round(extract(epoch from d.retention_until - d.created_at) / 86400)::int order by d.id)
                 from app.downloads d where d.share_id = s.id) as download_days,
              (select bool_and(d.retention_until <= s.metadata_purge_after) from app.downloads d where d.share_id = s.id) as outlived
         from app.shares s where s.id = $1`,
      [file.shareId],
    );
    expect(rows).toEqual([{ share_days: 365, download_days: [365, 365, 365], outlived: true }]);
  });
});
