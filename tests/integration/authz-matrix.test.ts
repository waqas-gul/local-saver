import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminDb, api, closeAdminDb, Device, newNetwork, PNG_BYTES } from "./support/api";

/**
 * IDOR matrix as code (09 §5, AC-1.3). Mirrors the local-mode rows of 03 §9.
 * The first test fails if any route or method under app/api/v1 has no entry here.
 */

type Actor =
  | "anonymous" // no session
  | "sameNetwork" // a device on the share's network, not the creator
  | "otherNetwork" // a device on a different network
  | "leftNetwork" // was on the share's network, now elsewhere
  | "blockedNetwork" // on the share's network while it is blocked (stands for every non-ok status)
  | "creatorSame" // the creator, on the share's network
  | "creatorOther"; // the creator's second device, on another network

type Entry = Partial<Record<Actor, number>>;

const MATRIX: Record<string, Entry> = {
  "GET /api/v1/health": { anonymous: 200 },
  "POST /api/v1/devices": { anonymous: 401, sameNetwork: 200 },
  "PATCH /api/v1/devices/[deviceId]": { anonymous: 401, sameNetwork: 404, creatorSame: 200 },
  "POST /api/v1/network/observe": { anonymous: 401, sameNetwork: 200, otherNetwork: 200, blockedNetwork: 200 },
  "GET /api/v1/local/shares": {
    anonymous: 401, sameNetwork: 200, otherNetwork: 200, leftNetwork: 200, blockedNetwork: 200, creatorSame: 200, creatorOther: 200,
  },
  "GET /api/v1/me/shares": { anonymous: 401, sameNetwork: 200, otherNetwork: 200, creatorSame: 200, creatorOther: 200 },
  "POST /api/v1/shares": { anonymous: 401, sameNetwork: 201, otherNetwork: 201, blockedNetwork: 409 },
  "POST /api/v1/texts": { anonymous: 401, sameNetwork: 201, otherNetwork: 201, blockedNetwork: 409 },
  "GET /api/v1/shares/[shareId]": {
    anonymous: 401, sameNetwork: 200, otherNetwork: 404, leftNetwork: 404, blockedNetwork: 404, creatorSame: 200, creatorOther: 200,
  },
  "PATCH /api/v1/shares/[shareId]/text": {
    anonymous: 401, sameNetwork: 403, otherNetwork: 404, leftNetwork: 404, blockedNetwork: 404, creatorSame: 200, creatorOther: 200,
  },
  "DELETE /api/v1/shares/[shareId]": {
    anonymous: 401, sameNetwork: 403, otherNetwork: 404, leftNetwork: 404, blockedNetwork: 404, creatorOther: 204,
  },
  "POST /api/v1/shares/[shareId]/files/[fileId]/complete": {
    anonymous: 401, sameNetwork: 404, otherNetwork: 404, leftNetwork: 404, blockedNetwork: 404, creatorSame: 200,
  },
  "POST /api/v1/files/[fileId]/download-url": {
    anonymous: 401, sameNetwork: 200, otherNetwork: 404, leftNetwork: 404, blockedNetwork: 404, creatorSame: 200, creatorOther: 200,
  },
  "POST /api/v1/files/[fileId]/preview-url": {
    anonymous: 401, sameNetwork: 200, otherNetwork: 404, leftNetwork: 404, blockedNetwork: 404, creatorSame: 200, creatorOther: 200,
  },
};

const ACTOR_ORDER: Actor[] = [
  "anonymous", "sameNetwork", "otherNetwork", "leftNetwork", "blockedNetwork", "creatorOther", "creatorSame",
];

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

describe("authorization matrix (local mode, 03 §9)", () => {
  const actors = {} as Record<Exclude<Actor, "anonymous">, Device>;
  const ids = {
    text: "",
    deletable: "",
    file: "",
    pendingShare: "",
    pendingFile: "",
    blockedText: "",
    blockedFile: "",
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

    // The creator's second device (same user) on another network.
    const second = await api("POST", "/api/v1/devices", { token: creator.token, body: {} });
    actors.creatorOther = Object.assign(Object.create(Object.getPrototypeOf(creator)), creator, {
      deviceId: second.body.device.id,
      ip: newNetwork().ip(),
    }) as Device;
    await actors.creatorOther.observe();

    await actors.leftNetwork.moveTo(newNetwork().ip());

    // A blocked network with content posted before the block.
    const blockedCreator = await Device.create(blockedNet.ip());
    ids.blockedText = (await blockedCreator.postText("before the block")).id;
    ids.blockedFile = (await blockedCreator.uploadFile("b.png", PNG_BYTES, "image/png")).upload.fileId;
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
    return route.startsWith("POST") || route.startsWith("PATCH") ? {} : undefined;
  }

  function pathFor(route: string, actor: Actor): string {
    const p = params(actor);
    let path = route.split(" ")[1] as string;
    if (route.startsWith("DELETE")) path = path.replace("[shareId]", actor === "blockedNetwork" ? ids.blockedText : ids.deletable);
    if (route.includes("/complete")) {
      path = path.replace("[shareId]", ids.pendingShare).replace("[fileId]", ids.pendingFile);
    }
    return path.replace("[shareId]", p.shareId).replace("[fileId]", p.fileId).replace("[deviceId]", p.deviceId);
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
            : await actors[actor].call(method, path, body);
        expect(response.status, `${actor}: ${method} ${path} → ${response.text.slice(0, 200)}`).toBe(expected);
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
