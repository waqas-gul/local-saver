import { randomUUID } from "node:crypto";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { adminDb, closeAdminDb, Device, newNetwork } from "./support/api";

/** Realtime authorization and delivery on the local Supabase stack (T-015 … T-018, DEC-011). */

type Joined = { status: string; channel: RealtimeChannel; messages: Record<string, unknown>[] };
const devices: Device[] = [];

async function device(ip: string | null) {
  const d = await Device.create(ip);
  devices.push(d);
  return d;
}

async function join(d: Device, topic: string, options: { private?: boolean } = {}): Promise<Joined> {
  const messages: Record<string, unknown>[] = [];
  const channel = d.supabase.channel(topic, {
    config: { private: options.private ?? true, presence: { key: d.deviceId } },
  });
  channel.on("broadcast", { event: "*" }, (message) => messages.push(message.payload as Record<string, unknown>));
  // Presence is only delivered to channels that listen for it before subscribing.
  channel.on("presence", { event: "sync" }, () => {});
  const status = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve("TIMED_OUT"), 10_000);
    channel.subscribe((state) => {
      if (state !== "SUBSCRIBED" && state !== "CHANNEL_ERROR" && state !== "TIMED_OUT" && state !== "CLOSED") return;
      clearTimeout(timer);
      resolve(state);
    });
  });
  return { status, channel, messages };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

afterEach(async () => {
  await Promise.all(devices.splice(0).map((d) => d.supabase.removeAllChannels()));
});
afterAll(closeAdminDb);

describe("topic authorization", () => {
  it("user:{id} is joinable only by that user (T-016)", async () => {
    const a = await device(newNetwork().ip());
    const b = await device(newNetwork().ip());
    expect((await join(a, `user:${a.userId}`)).status).toBe("SUBSCRIBED");
    expect((await join(b, `user:${a.userId}`)).status).toBe("CHANNEL_ERROR");
  });

  it("net:{space} needs fresh presence on an ok space (T-015)", async () => {
    const home = newNetwork();
    const a = await device(home.ip());
    const [spaceId] = (await a.observe()).spaceIds;
    expect((await join(a, `net:${spaceId}`)).status).toBe("SUBSCRIBED");

    const stranger = await device(newNetwork().ip());
    expect((await join(stranger, `net:${spaceId}`)).status).toBe("CHANNEL_ERROR");

    const leaver = await device(home.ip());
    await leaver.moveTo(newNetwork().ip());
    expect((await join(leaver, `net:${spaceId}`)).status).toBe("CHANNEL_ERROR");
  });
});

describe("delivery", () => {
  it("a new local share reaches other devices on the network within 2 s, as IDs only (AC-1.1, T-018)", async () => {
    const net = newNetwork();
    const a = await device(net.ip());
    const b = await device(net.ip());
    const [spaceId] = (await b.observe()).spaceIds;
    const listener = await join(b, `net:${spaceId}`);
    expect(listener.status).toBe("SUBSCRIBED");

    const started = Date.now();
    const share = await a.postText("realtime hello");
    const received = await waitFor(() => listener.messages.some((m) => m.shareId === share.id), 2_000);
    expect(received, `no signal within 2 s (waited ${Date.now() - started} ms)`).toBe(true);

    const message = listener.messages.find((m) => m.shareId === share.id) as Record<string, unknown>;
    expect(message).toMatchObject({ v: 1, type: "share.changed", shareId: share.id, status: "active" });
    expect(Object.keys(message).every((k) => ["v", "type", "shareId", "status", "version", "id"].includes(k))).toBe(true);
    expect(JSON.stringify(listener.messages)).not.toContain("realtime hello");
  });

  it("the creator's user topic carries their own shares (My uploads)", async () => {
    const a = await device(newNetwork().ip());
    const mine = await join(a, `user:${a.userId}`);
    const share = await a.postText();
    expect(await waitFor(() => mine.messages.some((m) => m.shareId === share.id), 2_000)).toBe(true);
  });

  it("clients cannot broadcast, but present devices can track presence (T-015)", async () => {
    const net = newNetwork();
    const a = await device(net.ip());
    const b = await device(net.ip());
    const [spaceId] = (await b.observe()).spaceIds;
    const sender = await join(a, `net:${spaceId}`);
    const listener = await join(b, `net:${spaceId}`);
    expect([sender.status, listener.status]).toEqual(["SUBSCRIBED", "SUBSCRIBED"]);

    await sender.channel.send({ type: "broadcast", event: "share.changed", payload: { shareId: "forged" } });
    expect(await waitFor(() => listener.messages.some((m) => m.shareId === "forged"), 1_500)).toBe(false);

    expect(await sender.channel.track({ deviceId: a.deviceId, label: a.label })).toBe("ok");
    const seen = await waitFor(() => Object.keys(listener.channel.presenceState()).includes(a.deviceId), 3_000);
    expect(seen).toBe(true);
  });

  it("a public channel with the same topic receives none of the private signals", async () => {
    const net = newNetwork();
    const a = await device(net.ip());
    const [spaceId] = (await a.observe()).spaceIds;
    const outsider = await device(newNetwork().ip());
    const sneaky = await join(outsider, `net:${spaceId}`, { private: false });
    const share = await a.postText();
    expect(await waitFor(() => sneaky.messages.some((m) => m.shareId === share.id), 1_500)).toBe(false);
  });

  it("a rolled-back transaction emits nothing (T-017)", async () => {
    const net = newNetwork();
    const a = await device(net.ip());
    const [spaceId] = (await a.observe()).spaceIds;
    const listener = await join(a, `net:${spaceId}`);
    const shareId = randomUUID();

    const client = await adminDb().connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into app.shares (id, scope, network_space_id, kind, created_by_user_id, billing_subject_type,
                                 billing_subject_id, status, retention_class, expires_at, entitlement_snapshot)
         values ($1, 'network', $2, 'text', $3, 'user', $3, 'active', 'd7', now() + interval '1 hour', '{}')`,
        [shareId, spaceId, a.userId],
      );
      await client.query("rollback");
    } finally {
      client.release();
    }

    const stored = await adminDb().query("select count(*)::int as n from realtime.messages where payload ->> 'shareId' = $1", [shareId]);
    expect(stored.rows[0].n).toBe(0);
    expect(await waitFor(() => listener.messages.some((m) => m.shareId === shareId), 1_500)).toBe(false);
  });
});
