import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminDb, api, closeAdminDb, Device, newNetwork, PNG_BYTES, setFlag, stack, turnstilePass, Viewer } from "./support/api";
import { drainJanitor } from "./support/janitor";

/**
 * Burn after download through the API (phase 3 §17.8–§17.12; T-028 burn part, T-038, T-039,
 * T-040). The 50-claimant race is in burn-concurrency.test.ts.
 */

beforeAll(() => setFlag("free_burn_after_download", true));
afterAll(async () => {
  await setFlag("free_burn_after_download", false);
  await setFlag("burn_after_download_enabled", true);
  await closeAdminDb();
});

const BYTES = new TextEncoder().encode("the secret file");

/**
 * GET /me/entitlements. Phase 4B (§17.6.3, deviation DV4-19) extends the response with the plan's
 * source, limits, usage and subscription, so the Phase 3 exact-shape assertions now check the plan
 * and the burn feature exactly, and the full key set, instead of the whole body.
 */
async function burnEntitlements(d: Device, burnAfterDownload: boolean) {
  const { body } = await d.call("GET", "/api/v1/me/entitlements");
  expect(body).toMatchObject({ plan: "free", features: { burnAfterDownload } });
  expect(Object.keys(body).sort()).toEqual(["features", "limits", "plan", "source", "subscription", "usage"]);
}

async function burnFile(creator: Device, name = "secret.txt", bytes: Uint8Array = BYTES, type = "text/plain", destination: "network" | "link_only" = "network") {
  const { init, upload, complete } = await creator.uploadFile(name, bytes, type, bytes.length, destination, { burnAfterDownload: true });
  expect(complete.status, complete.text).toBe(200);
  return { shareId: init.body.share.id as string, fileId: upload.fileId, objectKey: decodeURIComponent(new URL(upload.url).pathname).split("/").slice(2).join("/") };
}

async function shareRow(id: string) {
  const { rows } = await adminDb().query(
    "select status, end_reason, burn_after_download, claimed_by_user_id, claimed_device_id, claimed_link_id, claim_grace_until, expires_at, entitlement_snapshot from app.shares where id = $1",
    [id],
  );
  return rows[0];
}

function downloadUrl(d: Device, fileId: string, body: Record<string, unknown> = { confirm: true }) {
  return d.call("POST", `/api/v1/files/${fileId}/download-url`, body);
}

describe("the burn gate (Q-008, phase 3 §17.10)", () => {
  it("Free can't create burn shares while free_burn_after_download is off: 403 FEATURE_NOT_IN_PLAN with requiredPlan", async () => {
    await setFlag("free_burn_after_download", false);
    try {
      const a = await Device.create(newNetwork().ip());
      const text = await a.call("POST", "/api/v1/texts", { destination: "network", content: "x", burnAfterDownload: true });
      expect(text.status).toBe(403);
      expect(text.body.error).toMatchObject({ code: "FEATURE_NOT_IN_PLAN", details: { feature: "burnAfterDownload", requiredPlan: "pro" } });
      const files = await a.call("POST", "/api/v1/shares", {
        destination: "network",
        burnAfterDownload: true,
        files: [{ name: "a.txt", size: 1, type: "text/plain" }],
      });
      expect(files.status).toBe(403);
      // Everything else is unchanged by the flag.
      expect((await a.call("POST", "/api/v1/texts", { destination: "network", content: "x", burnAfterDownload: false })).status).toBe(201);
      await burnEntitlements(a, false);
    } finally {
      await setFlag("free_burn_after_download", true);
    }
  });

  it("the kill switch stops new burn shares (503) and leaves existing ones working", async () => {
    const net = newNetwork();
    const a = await Device.create(net.ip());
    const existing = await a.postBurnText("made before the switch");
    await setFlag("burn_after_download_enabled", false);
    try {
      const refused = await a.call("POST", "/api/v1/texts", { destination: "network", content: "x", burnAfterDownload: true });
      expect(refused.status).toBe(503);
      expect(refused.body.error.code).toBe("BURN_AFTER_DOWNLOAD_DISABLED");
      expect((await a.call("GET", "/api/v1/me/entitlements")).body.features.burnAfterDownload).toBe(false);
      const b = await Device.create(net.ip());
      expect((await b.call("POST", `/api/v1/shares/${existing.id}/reveal`, { confirm: true })).status).toBe(200);
    } finally {
      await setFlag("burn_after_download_enabled", true);
    }
  });

  it("with the beta flag on, Free creates burn shares; the snapshot records the grant and the audit says burn", async () => {
    const a = await Device.create(newNetwork().ip());
    await burnEntitlements(a, true);
    const share = await a.postBurnText("hello");
    const row = await shareRow(share.id);
    expect(row.burn_after_download).toBe(true);
    expect(row.entitlement_snapshot.features.burnAfterDownload).toBe(true);
    expect(row.entitlement_snapshot.plan).toBe("free");
    const audit = await adminDb().query("select metadata from app.audit_events where action = 'share.created' and target_id = $1", [share.id]);
    expect(audit.rows[0].metadata).toMatchObject({ kind: "text", burn: true });
    // A share that isn't burn keeps the Phase 1–2 shape: no burn field at all.
    const plain = await a.postText("plain");
    expect(plain).not.toHaveProperty("burn");
  });
});

describe("claiming a burn file on the network (T-038, T-039)", () => {
  it("needs confirm; the first device claims; it keeps the card, others get 410; 3 URLs per file", async () => {
    const net = newNetwork();
    const creator = await Device.create(net.ip());
    const { shareId, fileId } = await burnFile(creator);
    const b = await Device.create(net.ip());
    const c = await Device.create(net.ip());

    // Before any claim: visible to the network, no previews, nothing claimed.
    const before = (await c.call("GET", `/api/v1/shares/${shareId}`)).body.share;
    expect(before.burn).toEqual({ claimed: false, byYou: false, availableUntil: null, textHidden: false, revealsLeft: null });
    expect(before.files[0]).not.toHaveProperty("downloadsLeft");

    // A client that doesn't confirm (an older tab, a script) claims nothing.
    const unconfirmed = await downloadUrl(b, fileId, {});
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body.error.code).toBe("CONFIRMATION_REQUIRED");
    expect((await shareRow(shareId)).status).toBe("active");

    const first = await downloadUrl(b, fileId);
    expect(first.status).toBe(200);
    expect(first.body.burn.left).toBe(2);
    expect(new URL(first.body.url).searchParams.get("X-Amz-Expires")).toBe("60");
    expect(Buffer.from(await (await fetch(first.body.url)).arrayBuffer()).toString()).toBe("the secret file");
    const row = await shareRow(shareId);
    expect(row).toMatchObject({ status: "claimed", claimed_by_user_id: b.userId, claimed_device_id: b.deviceId });
    // Grace: 15 minutes plus a second per started MiB (one, here), and never past the share.
    expect(row.claim_grace_until.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(row.claim_grace_until.getTime() - Date.now()).toBeLessThan(16 * 60_000);
    expect(first.body.burn.availableUntil).toBe(row.claim_grace_until.toISOString());

    // The claimant keeps the card, with what is left; the others lose it.
    expect(await b.feedIds()).toContain(shareId);
    const mine = (await b.call("GET", `/api/v1/shares/${shareId}`)).body.share;
    expect(mine.status).toBe("claimed");
    expect(mine.burn).toMatchObject({ claimed: true, byYou: true, availableUntil: row.claim_grace_until.toISOString() });
    expect(mine.files[0].downloadsLeft).toBe(2);
    expect(await c.feedIds()).not.toContain(shareId);
    const other = await c.call("GET", `/api/v1/shares/${shareId}`);
    expect(other.status).toBe(410);
    expect(other.body.error).toMatchObject({ code: "ALREADY_DOWNLOADED", details: { byYou: false } });
    expect((await downloadUrl(c, fileId)).status).toBe(410);
    // Someone on another network still gets the plain 404 (nothing revealed).
    const stranger = await Device.create(newNetwork().ip());
    expect((await stranger.call("GET", `/api/v1/shares/${shareId}`)).status).toBe(404);

    // Retries: two more, then the limit (T-038).
    expect((await downloadUrl(b, fileId)).body.burn.left).toBe(1);
    expect((await downloadUrl(b, fileId)).body.burn.left).toBe(0);
    const fourth = await downloadUrl(b, fileId);
    expect(fourth.status).toBe(409);
    expect(fourth.body.error.code).toBe("BURN_RETRY_LIMIT");
    const events = await adminDb().query("select event from app.downloads where share_id = $1 order by id", [shareId]);
    expect(events.rows.map((r) => r.event)).toEqual(["burn_claimed", "burn_retry", "burn_retry"]);
  });

  it("the creator never claims and may download until the share is consumed (T-039, D-7)", async () => {
    const net = newNetwork();
    const creator = await Device.create(net.ip());
    const { shareId, fileId } = await burnFile(creator);
    // Before a claim: the creator's own downloads don't claim it.
    expect((await downloadUrl(creator, fileId, {})).status).toBe(200);
    expect((await shareRow(shareId)).status).toBe("active");

    const b = await Device.create(net.ip());
    expect((await downloadUrl(b, fileId)).status).toBe(200);
    // While claimed: the creator still downloads, from any network, and sees it in My uploads.
    expect((await downloadUrl(creator, fileId, {})).status).toBe(200);
    await creator.moveTo(newNetwork().ip());
    expect((await downloadUrl(creator, fileId, {})).status).toBe(200);
    expect(await creator.myShareIds()).toContain(shareId);
    const view = (await creator.call("GET", `/api/v1/shares/${shareId}`)).body.share;
    expect(view.burn).toMatchObject({ claimed: true, byYou: false });
    expect(view.burn.availableUntil).not.toBeNull();
    const actors = await adminDb().query("select actor_kind, event from app.downloads where share_id = $1 order by id", [shareId]);
    expect(actors.rows).toEqual([
      { actor_kind: "creator", event: "url_issued" },
      { actor_kind: "network_device", event: "burn_claimed" },
      { actor_kind: "creator", event: "url_issued" },
      { actor_kind: "creator", event: "url_issued" },
    ]);

    // Once consumed, nobody gets it, the creator included.
    expect((await b.call("POST", `/api/v1/shares/${shareId}/confirm-received`, {})).status).toBe(204);
    const after = await downloadUrl(creator, fileId, {});
    expect(after.status).toBe(410);
    expect(await creator.myShareIds()).not.toContain(shareId);
  });

  it("burn shares never have previews, not even for the creator (T-028)", async () => {
    const net = newNetwork();
    const creator = await Device.create(net.ip());
    const { shareId, fileId } = await burnFile(creator, "pic.png", PNG_BYTES, "image/png");
    const b = await Device.create(net.ip());
    expect((await b.call("GET", `/api/v1/shares/${shareId}`)).body.share.files[0].previewable).toBe(false);
    for (const d of [creator, b]) {
      const preview = await d.call("POST", `/api/v1/files/${fileId}/preview-url`, {});
      expect(preview.status).toBe(422);
      expect(preview.body.error.code).toBe("PREVIEW_UNAVAILABLE");
    }
    const { rows } = await adminDb().query("select preview_kind from app.files where id = $1", [fileId]);
    expect(rows[0].preview_kind).toBe("none");
    expect((await shareRow(shareId)).status).toBe("active");
  });

  it("the claimant loses access on leaving the network, and gets it back on returning within grace (R3-5)", async () => {
    const net = newNetwork();
    const creator = await Device.create(net.ip());
    const { fileId } = await burnFile(creator);
    const b = await Device.create(net.ip());
    expect((await downloadUrl(b, fileId)).status).toBe(200);
    const home = b.ip;
    await b.moveTo(newNetwork().ip());
    expect((await downloadUrl(b, fileId)).status).toBe(404);
    await b.moveTo(home);
    expect((await downloadUrl(b, fileId)).status).toBe(200);
  });
});

describe("text reveal (T-040)", () => {
  it("withholds the text from everyone but the creator; Reveal claims it, 3 times at most", async () => {
    const net = newNetwork();
    const creator = await Device.create(net.ip());
    const posted = await creator.postBurnText("meet at noon");
    expect(posted.text).toEqual({ content: "meet at noon", version: 1 });
    expect(posted.burn.textHidden).toBe(false);
    const b = await Device.create(net.ip());
    const c = await Device.create(net.ip());

    const seen = (await b.call("GET", "/api/v1/local/shares")).body.shares.find((s: { id: string }) => s.id === posted.id);
    expect(seen.text).toBeNull();
    expect(seen.burn).toMatchObject({ claimed: false, textHidden: true });
    expect((await c.call("GET", `/api/v1/shares/${posted.id}`)).text).not.toContain("meet at noon");

    const unconfirmed = await b.call("POST", `/api/v1/shares/${posted.id}/reveal`, {});
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body.error.code).toBe("CONFIRMATION_REQUIRED");

    const reveal = await b.call("POST", `/api/v1/shares/${posted.id}/reveal`, { confirm: true });
    expect(reveal.status).toBe(200);
    expect(reveal.body).toMatchObject({ text: { content: "meet at noon" }, burn: { left: 2 } });
    // Still withheld from the claimant's DTO: only Reveal returns it (nothing to cache).
    const claimantView = (await b.call("GET", `/api/v1/shares/${posted.id}`)).body.share;
    expect(claimantView.text).toBeNull();
    expect(claimantView.burn).toMatchObject({ claimed: true, byYou: true, textHidden: true, revealsLeft: 2 });
    expect((await c.call("POST", `/api/v1/shares/${posted.id}/reveal`, { confirm: true })).status).toBe(410);
    expect((await b.call("POST", `/api/v1/shares/${posted.id}/reveal`, { confirm: true })).body.burn.left).toBe(1);
    expect((await b.call("POST", `/api/v1/shares/${posted.id}/reveal`, { confirm: true })).body.burn.left).toBe(0);
    expect((await b.call("POST", `/api/v1/shares/${posted.id}/reveal`, { confirm: true })).body.error.code).toBe("BURN_RETRY_LIMIT");
    // The creator still reads it, and can't edit a burn text.
    expect((await creator.call("GET", `/api/v1/shares/${posted.id}`)).body.share.text.content).toBe("meet at noon");
    expect((await creator.call("PATCH", `/api/v1/shares/${posted.id}/text`, { content: "changed", version: 1 })).status).toBe(404);
    // Reveal is never logged with the content.
    const { rows } = await adminDb().query("select count(*)::int as n from app.downloads where share_id = $1 and event = 'text_revealed'", [posted.id]);
    expect(rows[0].n).toBe(3);
  });

  it("reveal on a share that isn't a burn text is a 404", async () => {
    const net = newNetwork();
    const creator = await Device.create(net.ip());
    const plain = await creator.postText("plain");
    const b = await Device.create(net.ip());
    expect((await b.call("POST", `/api/v1/shares/${plain.id}/reveal`, { confirm: true })).status).toBe(404);
    const { shareId } = await burnFile(creator);
    expect((await b.call("POST", `/api/v1/shares/${shareId}/reveal`, { confirm: true })).status).toBe(404);
  });
});

describe("the end of a claim (phase 3 §17.8.6)", () => {
  it("\"I've got it\" consumes the share at once, repeats are 204, others 404; the objects go 5 minutes later", async () => {
    const net = newNetwork();
    const creator = await Device.create(net.ip());
    const { shareId, fileId, objectKey } = await burnFile(creator);
    const b = await Device.create(net.ip());
    const c = await Device.create(net.ip());
    expect((await downloadUrl(b, fileId)).status).toBe(200);

    expect((await c.call("POST", `/api/v1/shares/${shareId}/confirm-received`, {})).status).toBe(404);
    expect((await creator.call("POST", `/api/v1/shares/${shareId}/confirm-received`, {})).status).toBe(404);
    expect((await b.call("POST", `/api/v1/shares/${shareId}/confirm-received`, {})).status).toBe(204);
    expect((await b.call("POST", `/api/v1/shares/${shareId}/confirm-received`, {})).status).toBe(204);
    expect(await shareRow(shareId)).toMatchObject({ status: "consumed", end_reason: "consumed" });
    const audit = await adminDb().query("select actor_device_id from app.audit_events where action = 'burn.confirmed' and target_id = $1", [shareId]);
    expect(audit.rows).toEqual([{ actor_device_id: b.deviceId }]);

    const gone = await downloadUrl(b, fileId);
    expect(gone.status).toBe(410);
    expect(gone.body.error.details).toEqual({ byYou: true });
    expect(await b.feedIds()).not.toContain(shareId);

    // The deletion waits 5 minutes (a download from a URL issued just before can finish)...
    const outbox = await adminDb().query("select not_before - now() as wait from app.object_deletions where object_key = $1 and completed_at is null", [objectKey]);
    expect(outbox.rows).toHaveLength(1);
    const s3 = new S3Client({
      region: "auto",
      endpoint: stack().storage.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: stack().storage.accessKeyId, secretAccessKey: stack().storage.secretAccessKey },
    });
    const exists = () =>
      s3.send(new HeadObjectCommand({ Bucket: stack().storage.bucket, Key: objectKey })).then(
        () => true,
        () => false,
      );
    expect(await exists()).toBe(true);
    // ...then the janitor deletes it (time moved on).
    await adminDb().query("update app.object_deletions set not_before = now() - interval '1 second' where object_key = $1 and completed_at is null", [objectKey]);
    await adminDb().query("update app.files set upload_url_expires_at = now() - interval '10 minutes' where id = $1", [fileId]);
    expect(await drainJanitor(async () => !(await exists()))).toBe(true);
  });

  it("access ends when grace ends, before the finalize job runs; the job then consumes the share", async () => {
    const net = newNetwork();
    const creator = await Device.create(net.ip());
    const { shareId, fileId } = await burnFile(creator);
    const b = await Device.create(net.ip());
    expect((await downloadUrl(b, fileId)).status).toBe(200);
    await adminDb().query(
      "update app.shares set claimed_at = now() - interval '1 hour', claim_grace_until = now() - interval '1 second' where id = $1",
      [shareId],
    );
    const late = await downloadUrl(b, fileId);
    expect(late.status).toBe(410);
    expect(late.body.error.details).toEqual({ byYou: true });
    expect((await shareRow(shareId)).status).toBe("claimed");
    await adminDb().query("select app.run_job('finalize-burn-claims')");
    expect((await shareRow(shareId)).status).toBe("consumed");
  });

  it("grace never outlasts the share: a claim near expiry ends with it (D-6)", async () => {
    const net = newNetwork();
    const creator = await Device.create(net.ip());
    const { shareId, fileId } = await burnFile(creator);
    await adminDb().query("update app.shares set expires_at = now() + interval '2 minutes' where id = $1", [shareId]);
    const b = await Device.create(net.ip());
    const claim = await downloadUrl(b, fileId);
    expect(claim.status).toBe(200);
    const row = await shareRow(shareId);
    expect(row.claim_grace_until.getTime()).toBe(row.expires_at.getTime());
    // Past expiry nobody is served, before any job (request-time check).
    await adminDb().query(
      "update app.shares set claimed_at = now() - interval '10 minutes', expires_at = now() - interval '1 second', claim_grace_until = now() - interval '1 second' where id = $1",
      [shareId],
    );
    expect((await downloadUrl(b, fileId)).status).toBe(404);
    expect((await creator.call("GET", `/api/v1/shares/${shareId}`)).status).toBe(404);
  });
});

describe("link viewers (phase 3 §17.8.4)", () => {
  it("a viewer session claims; others who hold the link learn it was downloaded; the claimant can reload", async () => {
    const creator = await Device.create(newNetwork().ip());
    const { shareId, fileId } = await burnFile(creator, "doc.txt", BYTES, "text/plain", "link_only");
    const link = await creator.createLink(shareId);
    const v1 = new Viewer();
    const early = new Viewer(); // holds a grant from before the claim
    expect((await early.unlock(link.id, link.secret)).status).toBe(200);
    const unlocked = await v1.unlock(link.id, link.secret);
    expect(unlocked.status).toBe(200);
    expect(unlocked.body.share.burn).toEqual({ claimed: false, byYou: false, availableUntil: null, textHidden: false, revealsLeft: null });
    expect(unlocked.body.share.files[0].previewable).toBe(false);

    expect((await v1.fileUrl(link.id, fileId)).status).toBe(409); // no confirm
    expect((await v1.fileUrl(link.id, fileId, "preview-url")).status).toBe(422);
    const claim = await v1.fileUrl(link.id, fileId, "download-url", { confirm: true });
    expect(claim.status).toBe(200);
    expect(claim.body.burn.left).toBe(2);
    const row = await shareRow(shareId);
    expect(row).toMatchObject({ status: "claimed", claimed_by_user_id: null, claimed_link_id: link.id });

    // The claimant's content shows their state; a reload (unlock again) keeps the claim.
    const own = await v1.content(link.id);
    expect(own.body.share.burn).toMatchObject({ claimed: true, byYou: true });
    expect(own.body.share.files[0].downloadsLeft).toBe(2);
    expect((await v1.unlock(link.id, link.secret)).status).toBe(200);
    expect((await v1.fileUrl(link.id, fileId, "download-url", { confirm: true })).body.burn.left).toBe(1);

    // Another grant holder, and a newcomer with the secret, get 410 ALREADY_DOWNLOADED.
    const other = await early.content(link.id);
    expect(other.status).toBe(410);
    expect(other.body.error).toMatchObject({ code: "ALREADY_DOWNLOADED", details: { byYou: false } });
    expect((await early.fileUrl(link.id, fileId, "download-url", { confirm: true })).status).toBe(410);
    const late = new Viewer();
    const lateUnlock = await late.unlock(link.id, link.secret);
    expect(lateUnlock.status).toBe(410);
    expect(lateUnlock.body.error.code).toBe("ALREADY_DOWNLOADED");
    // Without the secret, nothing is revealed (Phase 2 rule).
    expect((await new Viewer().unlock(link.id, "A".repeat(43))).status).toBe(404);

    // The claimant confirms; consuming revokes the links, but the claimant learns it was them.
    expect((await early.call("POST", `/api/v1/links/${link.id}/confirm-received`, {})).status).toBe(404);
    expect((await v1.call("POST", `/api/v1/links/${link.id}/confirm-received`, {})).status).toBe(204);
    expect((await v1.call("POST", `/api/v1/links/${link.id}/confirm-received`, {})).status).toBe(204);
    const after = await v1.content(link.id);
    expect(after.status).toBe(410);
    expect(after.body.error.details).toEqual({ byYou: true });
    expect((await shareRow(shareId)).status).toBe("consumed");
  });

  it("a creator who opens their own link in a browser is a link viewer, and claims it (R3-4)", async () => {
    const net = newNetwork();
    const creator = await Device.create(net.ip());
    const { shareId, fileId } = await burnFile(creator);
    const link = await creator.createLink(shareId);
    const creatorsBrowser = new Viewer(creator.ip);
    expect((await creatorsBrowser.unlock(link.id, link.secret)).status).toBe(200);
    expect((await creatorsBrowser.fileUrl(link.id, fileId, "download-url", { confirm: true })).status).toBe(200);
    expect((await shareRow(shareId)).status).toBe("claimed");
    // The network's devices lose it; the creator's device keeps access (D-7) but can't make new links.
    const b = await Device.create(net.ip());
    expect((await downloadUrl(b, fileId)).status).toBe(410);
    expect((await downloadUrl(creator, fileId, {})).status).toBe(200);
    expect((await creator.call("POST", `/api/v1/shares/${shareId}/links`, {})).status).toBe(410);
  });

  it("a link-viewer text claimant reveals it; the content never carries burn text", async () => {
    const creator = await Device.create(newNetwork().ip());
    const posted = await creator.postBurnText("for your eyes", "link_only");
    const link = await creator.createLink(posted.id);
    const v = new Viewer();
    const unlocked = await v.unlock(link.id, link.secret);
    expect(unlocked.body.share.text).toBeNull();
    expect(unlocked.body.share.burn.textHidden).toBe(true);
    expect((await v.call("POST", `/api/v1/links/${link.id}/reveal`, {})).status).toBe(409);
    const reveal = await v.call("POST", `/api/v1/links/${link.id}/reveal`, { confirm: true });
    expect(reveal.status).toBe(200);
    expect(reveal.body).toMatchObject({ text: { content: "for your eyes" }, burn: { left: 2 } });
    const again = await v.content(link.id);
    expect(again.body.share.text).toBeNull();
    expect(again.body.share.burn).toMatchObject({ claimed: true, byYou: true, revealsLeft: 2 });
    expect(again.text).not.toContain("for your eyes");
  });
});

describe("unfurlers and scanners never claim (AC-3.8, T3-12 API part)", () => {
  it("bot GETs of the share page and the API, and a viewer that only unlocks and polls, leave the share active", async () => {
    const creator = await Device.create(newNetwork().ip());
    const { shareId } = await burnFile(creator, "doc.txt", BYTES, "text/plain", "link_only");
    const link = await creator.createLink(shareId);
    for (const agent of ["Slackbot-LinkExpanding 1.0", "facebookexternalhit/1.1", "Mozilla/5.0 (compatible; Googlebot/2.1)"]) {
      const page = await fetch(`${stack().origin}/s/${link.id}`, { headers: { "user-agent": agent } });
      expect(page.status).toBe(200);
      expect((await api("GET", `/api/v1/links/${link.id}/content`, { headers: { "user-agent": agent } })).status).toBe(404);
    }
    // A scanner that runs the page's script: unlock, then poll, but never click Download.
    const scanner = new Viewer();
    expect((await scanner.unlock(link.id, link.secret)).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await scanner.content(link.id)).status).toBe(200);
    expect((await shareRow(shareId)).status).toBe("active");
    const { rows } = await adminDb().query("select count(*)::int as n from app.downloads where share_id = $1", [shareId]);
    expect(rows[0].n).toBe(0);
  });
});

describe("other routes and a claimed share", () => {
  it("the claimant can still report it; the creator can still delete it", async () => {
    const net = newNetwork();
    const creator = await Device.create(net.ip());
    const { shareId, fileId } = await burnFile(creator);
    const b = await Device.create(net.ip());
    expect((await downloadUrl(b, fileId)).status).toBe(200);
    const report = await b.call("POST", "/api/v1/reports", {
      target: { type: "share", shareId },
      category: "spam",
      turnstileToken: turnstilePass(),
    });
    expect(report.status).toBe(201);
    expect((await creator.call("DELETE", `/api/v1/shares/${shareId}`)).status).toBe(204);
    expect(await shareRow(shareId)).toMatchObject({ status: "deleted" });
    expect((await downloadUrl(b, fileId)).status).toBe(404);
  });
});
