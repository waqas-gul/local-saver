import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminDb, api, closeAdminDb, Device, newNetwork, PNG_BYTES, turnstilePass, Viewer } from "./support/api";

/**
 * IDOR matrix as code (09 §5, AC-1.3, Phase 2 T-029). Mirrors 03 §9: the local-mode rows and,
 * from Phase 2, link viewers of this share and of another share.
 * The first test fails if any route or method under app/api/v1 has no entry here.
 */

type Actor =
  | "anonymous" // no session, no link cookie
  | "sameNetwork" // a device on the share's network, not the creator
  | "otherNetwork" // a device on a different network
  | "leftNetwork" // was on the share's network, now elsewhere
  | "blockedNetwork" // on the share's network while it is blocked (stands for every non-ok status)
  | "linkViewer" // a browser holding a grant for this share's link (no Supabase session)
  | "otherLinkViewer" // a browser holding a grant for another share's link
  | "creatorSame" // the creator, on the share's network
  | "creatorOther"; // the creator's second device, on another network

type Entry = Partial<Record<Actor, number>>;

const MATRIX: Record<string, Entry> = {
  "GET /api/v1/health": { anonymous: 200 },
  "POST /api/v1/devices": { anonymous: 401, sameNetwork: 200 },
  "PATCH /api/v1/devices/[deviceId]": { anonymous: 401, sameNetwork: 404, linkViewer: 401, creatorSame: 200 },
  "POST /api/v1/network/observe": { anonymous: 401, sameNetwork: 200, otherNetwork: 200, blockedNetwork: 200, linkViewer: 401 },
  "GET /api/v1/local/shares": {
    anonymous: 401, sameNetwork: 200, otherNetwork: 200, leftNetwork: 200, blockedNetwork: 200, linkViewer: 401, creatorSame: 200, creatorOther: 200,
  },
  "GET /api/v1/me/shares": { anonymous: 401, sameNetwork: 200, otherNetwork: 200, linkViewer: 401, creatorSame: 200, creatorOther: 200 },
  "POST /api/v1/shares": { anonymous: 401, sameNetwork: 201, otherNetwork: 201, blockedNetwork: 409, linkViewer: 401 },
  "POST /api/v1/texts": { anonymous: 401, sameNetwork: 201, otherNetwork: 201, blockedNetwork: 409, linkViewer: 401 },
  "GET /api/v1/shares/[shareId]": {
    anonymous: 401, sameNetwork: 200, otherNetwork: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 200, creatorOther: 200,
  },
  "PATCH /api/v1/shares/[shareId]/text": {
    anonymous: 401, sameNetwork: 403, otherNetwork: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 200, creatorOther: 200,
  },
  "DELETE /api/v1/shares/[shareId]": {
    anonymous: 401, sameNetwork: 403, otherNetwork: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorOther: 204,
  },
  "POST /api/v1/shares/[shareId]/files/[fileId]/complete": {
    anonymous: 401, sameNetwork: 404, otherNetwork: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 200,
  },
  "POST /api/v1/files/[fileId]/download-url": {
    anonymous: 401, sameNetwork: 200, otherNetwork: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 200, creatorOther: 200,
  },
  "POST /api/v1/files/[fileId]/preview-url": {
    anonymous: 401, sameNetwork: 200, otherNetwork: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 200, creatorOther: 200,
  },

  // Phase 2: creator side. Only the share's creator, from any network (DEC-033, T-011).
  "POST /api/v1/shares/[shareId]/links": {
    anonymous: 401, sameNetwork: 403, otherNetwork: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, otherLinkViewer: 401,
    creatorSame: 201, creatorOther: 201,
  },
  "GET /api/v1/shares/[shareId]/links": {
    anonymous: 401, sameNetwork: 403, otherNetwork: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 200, creatorOther: 200,
  },
  "DELETE /api/v1/links/[linkId]": {
    anonymous: 401, sameNetwork: 403, otherNetwork: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, otherLinkViewer: 401,
    creatorOther: 204,
  },
  "POST /api/v1/links/[linkId]/code": {
    anonymous: 401, sameNetwork: 403, otherNetwork: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 401, creatorSame: 200, creatorOther: 200,
  },
  // Phase 2: link viewers. Only the link's secret (or code) or a grant for this link opens it (T-029, T-030).
  "POST /api/v1/links/[linkId]/unlock": { anonymous: 404, sameNetwork: 404, otherNetwork: 404, linkViewer: 200, otherLinkViewer: 404 },
  "GET /api/v1/links/[linkId]/content": {
    anonymous: 404, sameNetwork: 404, otherNetwork: 404, linkViewer: 200, otherLinkViewer: 404, creatorSame: 404,
  },
  "POST /api/v1/links/[linkId]/files/[fileId]/download-url": {
    anonymous: 404, sameNetwork: 404, otherNetwork: 404, linkViewer: 200, otherLinkViewer: 404, creatorSame: 404,
  },
  "POST /api/v1/links/[linkId]/files/[fileId]/preview-url": {
    anonymous: 404, sameNetwork: 404, otherNetwork: 404, linkViewer: 200, otherLinkViewer: 404, creatorSame: 404,
  },
  "POST /api/v1/codes/resolve": { anonymous: 404, otherNetwork: 404, linkViewer: 200, otherLinkViewer: 404 },
  // Reports: whoever can see the share (03 §9 "Report content").
  "POST /api/v1/reports": {
    anonymous: 401, sameNetwork: 201, otherNetwork: 404, leftNetwork: 404, blockedNetwork: 404, linkViewer: 201, otherLinkViewer: 404,
    creatorSame: 201, creatorOther: 201,
  },
};

const ACTOR_ORDER: Actor[] = [
  "anonymous", "sameNetwork", "otherNetwork", "leftNetwork", "blockedNetwork", "linkViewer", "otherLinkViewer", "creatorOther", "creatorSame",
];
const VIEWERS = ["linkViewer", "otherLinkViewer"] as const;
type ViewerActor = (typeof VIEWERS)[number];
const isViewer = (actor: Actor): actor is ViewerActor => (VIEWERS as readonly string[]).includes(actor);

function discoverRoutes(): string[] {
  const root = join(process.cwd(), "app", "api", "v1");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "route.ts") {
        const path = `/api/v1/${relative(root, dir).split(sep).join("/")}`.replace(/\/$/, "");
        const source = readFileSync(full, "utf8");
        for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
          if (new RegExp(`export\\s+(const|async\\s+function|function)\\s+${method}\\b`).test(source)) {
            found.push(`${method} ${path}`);
          }
        }
      }
    }
  };
  walk(root);
  return found.sort();
}

describe("authorization matrix coverage", () => {
  it("has an entry for every route and method, and no stale entries", () => {
    expect(Object.keys(MATRIX).sort()).toEqual(discoverRoutes());
  });
});

describe("authorization matrix (03 §9: local mode and link viewers)", () => {
  const actors = {} as Record<Exclude<Actor, "anonymous" | ViewerActor>, Device>;
  const viewers = {} as Record<ViewerActor, Viewer>;
  const ids = {
    text: "",
    deletable: "",
    file: "",
    imageShare: "",
    pendingShare: "",
    pendingFile: "",
    blockedText: "",
    blockedFile: "",
    // Phase 2: a link (with a code) to the image share, another share's link, links to revoke.
    link: "",
    linkSecret: "",
    linkCode: "",
    otherLink: "",
    otherLinkSecret: "",
    revocable: "",
    blockedLink: "",
  };

  beforeAll(async () => {
    const home = newNetwork();
    const blockedNet = newNetwork();

    const creator = await Device.create(home.ip());
    actors.creatorSame = creator;
    actors.sameNetwork = await Device.create(home.ip());
    actors.otherNetwork = await Device.create(newNetwork().ip());
    actors.leftNetwork = await Device.create(home.ip());

    ids.text = (await creator.postText("matrix text")).id;
    ids.deletable = (await creator.postText("matrix delete")).id;
    const image = await creator.uploadFile("m.png", PNG_BYTES, "image/png");
    ids.file = image.upload.fileId;
    ids.imageShare = image.init.body.share.id;

    const pending = await creator.call("POST", "/api/v1/shares", {
      destination: "network",
      files: [{ name: "p.bin", size: 3, type: "application/octet-stream" }],
    });
    ids.pendingShare = pending.body.share.id;
    ids.pendingFile = pending.body.uploads[0].fileId;
    await fetch(pending.body.uploads[0].url, {
      method: "PUT",
      headers: pending.body.uploads[0].headers,
      body: Buffer.from([1, 2, 3]),
    });

    // Links: this share (the image), another share, and one only for revoking.
    const link = await creator.createLink(ids.imageShare, { shortCode: {} });
    ids.link = link.id;
    ids.linkSecret = link.secret;
    ids.linkCode = link.shortCode!.code;
    const otherLink = await creator.createLink((await creator.postText("another share")).id);
    ids.otherLink = otherLink.id;
    ids.otherLinkSecret = otherLink.secret;
    ids.revocable = (await creator.createLink(ids.text)).id;
    viewers.linkViewer = new Viewer();
    viewers.otherLinkViewer = new Viewer();
    expect((await viewers.linkViewer.unlock(ids.link, ids.linkSecret)).status).toBe(200);
    expect((await viewers.otherLinkViewer.unlock(ids.otherLink, ids.otherLinkSecret)).status).toBe(200);

    // The creator's second device (same user) on another network.
    const second = await api("POST", "/api/v1/devices", { token: creator.token, body: {} });
    actors.creatorOther = Object.assign(Object.create(Object.getPrototypeOf(creator)), creator, {
      deviceId: second.body.device.id,
      ip: newNetwork().ip(),
    }) as Device;
    await actors.creatorOther.observe();

    await actors.leftNetwork.moveTo(newNetwork().ip());

    // A blocked network with content (and a link) made before the block.
    const blockedCreator = await Device.create(blockedNet.ip());
    ids.blockedText = (await blockedCreator.postText("before the block")).id;
    ids.blockedFile = (await blockedCreator.uploadFile("b.png", PNG_BYTES, "image/png")).upload.fileId;
    ids.blockedLink = (await blockedCreator.createLink(ids.blockedText)).id;
    actors.blockedNetwork = await Device.create(blockedNet.ip());
    const [blockedSpace] = (await actors.blockedNetwork.observe()).spaceIds;
    await adminDb().query("update app.network_spaces set status = 'blocked' where id = $1", [blockedSpace]);
  });

  afterAll(closeAdminDb);

  /** Resource IDs per actor: the blocked-network actor targets the blocked network's content. */
  function params(actor: Actor) {
    const blocked = actor === "blockedNetwork";
    return {
      shareId: blocked ? ids.blockedText : ids.text,
      fileId: blocked ? ids.blockedFile : ids.file,
      deviceId: actors.creatorSame.deviceId,
      linkId: blocked ? ids.blockedLink : ids.link,
    };
  }

  async function bodyFor(route: string, actor: Actor): Promise<unknown> {
    if (route.startsWith("PATCH /api/v1/shares/")) {
      const { rows } = await adminDb().query("select version from app.text_items where share_id = $1", [params(actor).shareId]);
      return { content: `edit by ${actor}`, version: rows[0]?.version ?? 1 };
    }
    if (route === "PATCH /api/v1/devices/[deviceId]") return { label: "Renamed" };
    if (route === "POST /api/v1/shares") {
      return { destination: "network", files: [{ name: "n.txt", size: 1, type: "text/plain" }] };
    }
    if (route === "POST /api/v1/texts") return { destination: "network", content: `post by ${actor}` };
    if (route === "POST /api/v1/links/[linkId]/unlock") {
      const secret = actor === "linkViewer" ? ids.linkSecret : actor === "otherLinkViewer" ? ids.otherLinkSecret : randomBytes(32).toString("base64url");
      return { secret };
    }
    if (route === "POST /api/v1/codes/resolve") return { code: actor === "linkViewer" ? ids.linkCode : "0000000000" };
    if (route === "POST /api/v1/reports") {
      const target = isViewer(actor) ? { type: "link", linkId: ids.link } : { type: "share", shareId: params(actor).shareId };
      return { target, category: "spam", turnstileToken: turnstilePass() };
    }
    return route.startsWith("POST") || route.startsWith("PATCH") ? {} : undefined;
  }

  function pathFor(route: string, actor: Actor): string {
    const p = params(actor);
    let path = route.split(" ")[1] as string;
    if (route === "DELETE /api/v1/shares/[shareId]") path = path.replace("[shareId]", actor === "blockedNetwork" ? ids.blockedText : ids.deletable);
    if (route === "DELETE /api/v1/links/[linkId]") path = path.replace("[linkId]", actor === "blockedNetwork" ? ids.blockedLink : ids.revocable);
    if (route.includes("/complete")) {
      path = path.replace("[shareId]", ids.pendingShare).replace("[fileId]", ids.pendingFile);
    }
    return path
      .replace("[shareId]", p.shareId)
      .replace("[fileId]", p.fileId)
      .replace("[deviceId]", p.deviceId)
      .replace("[linkId]", p.linkId);
  }

  for (const [route, expectations] of Object.entries(MATRIX)) {
    it(route, async () => {
      const method = route.split(" ")[0] as string;
      for (const actor of ACTOR_ORDER) {
        const expected = expectations[actor];
        if (expected === undefined) continue;
        const path = pathFor(route, actor);
        const body = await bodyFor(route, actor);
        const response =
          actor === "anonymous"
            ? await api(method, path, { body, ip: newNetwork().ip() })
            : isViewer(actor)
              ? await viewers[actor].call(method, path, body)
              : await actors[actor].call(method, path, body);
        expect(response.status, `${actor}: ${method} ${path} → ${response.text.slice(0, 200)}`).toBe(expected);
        // A new code replaces the old one; later rows must use the current code.
        if (route === "POST /api/v1/links/[linkId]/code" && response.status === 200) ids.linkCode = response.body.shortCode.code;
      }
    });
  }

  it("feeds and My uploads list exactly what each actor may see", async () => {
    const feed = async (d: Device) => ((await d.call("GET", "/api/v1/local/shares")).body.shares as { id: string }[]).map((s) => s.id);
    const mine = async (d: Device) => ((await d.call("GET", "/api/v1/me/shares")).body.shares as { id: string }[]).map((s) => s.id);
    expect(await feed(actors.sameNetwork)).toContain(ids.text);
    expect(await feed(actors.creatorSame)).toContain(ids.text);
    for (const actor of ["otherNetwork", "leftNetwork", "creatorOther"] as const) {
      expect(await feed(actors[actor]), actor).not.toContain(ids.text);
    }
    expect(await feed(actors.blockedNetwork)).toEqual([]);
    expect(await mine(actors.creatorOther)).toContain(ids.text);
    expect(await mine(actors.sameNetwork)).not.toContain(ids.text);
  });
});
