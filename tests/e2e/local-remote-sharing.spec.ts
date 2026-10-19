import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { feed, newNetwork, openDevice, postText, unique } from "./support/local-devices";
import {
  adminDb,
  closeAdminDb,
  createLinkFor,
  createLinkInDialog,
  decodeShownQr,
  linkIdOf,
  openViewer,
  refocus,
  thirdPartyRequests,
} from "./support/remote";

/**
 * Phase 2 E2E (phase 2 §12): a sender on network A shares with a viewer on network B by link,
 * QR code and short code; revocation, expiry and takedown reach the viewer; link-only posts
 * never appear on A; unfurlers learn nothing; share pages make no third-party requests.
 * Each browser context is a separate browser; viewers never open the app itself.
 */

test.afterAll(closeAdminDb);

test("a viewer on another network opens a link and gets only that share, its file and nothing else (AC-2.1, AC-2.9)", async ({ browser }) => {
  const netA = newNetwork();
  const sender = await openDevice(browser, netA.ip());
  const shared = unique("for the viewer");
  const notShared = unique("stays on network A");
  await postText(sender, notShared);
  await postText(sender, shared);
  const { url } = await createLinkFor(sender, shared);
  expect(new URL(url).hash).toMatch(/^#k=[A-Za-z0-9_-]{43}$/);

  const viewer = await openViewer(browser, newNetwork().ip());
  const response = await viewer.page.goto(url);
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  expect(response?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  await expect(viewer.page.getByTestId("shared-text")).toHaveText(shared);
  await expect(viewer.page.getByText(notShared)).toHaveCount(0);
  // The secret leaves the address bar once the link is unlocked.
  await expect.poll(() => viewer.page.url()).toBe(url.split("#")[0]);
  // Nothing from the app's own session or network view reaches the viewer.
  await expect(viewer.page.getByTestId("network-line")).toHaveCount(0);
  await expect(viewer.page.getByTestId("device-label")).toHaveCount(0);

  expect(thirdPartyRequests(viewer)).toEqual([]);
  expect(viewer.requests.some((u) => u.includes("/auth/v1/"))).toBe(false); // no Supabase sign-in for viewers
  expect(await viewer.cspViolations()).toEqual([]);
});

test("files: the viewer downloads through the grant; archives need a confirmation (03 §7.4)", async ({ browser }) => {
  const sender = await openDevice(browser, newNetwork().ip());
  const name = `${randomBytes(3).toString("hex")}-notes.zip`;
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, ...Buffer.from(`zip ${randomBytes(4).toString("hex")}`)]);
  await sender.page.getByRole("tab", { name: "Files" }).click();
  await sender.page.getByTestId("composer-files").setInputFiles([{ name, mimeType: "application/zip", buffer: bytes }]);
  await sender.page.getByTestId("composer-submit").click();
  await expect(feed(sender).getByText(name)).toBeVisible();
  const { url } = await createLinkFor(sender, name);

  const viewer = await openViewer(browser, newNetwork().ip(), { viewport: { width: 320, height: 640 } });
  await viewer.page.goto(url);
  await expect(viewer.page.getByText(name)).toBeVisible();
  await expect(viewer.page.getByText("Archive")).toBeVisible();
  await viewer.page.getByRole("button", { name: `Download ${name}` }).click();
  await expect(viewer.page.getByText("Download this archive?")).toBeVisible();
  const downloadPromise = viewer.page.waitForEvent("download");
  await viewer.page.getByRole("button", { name: "Download anyway" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(name);
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
  // Phone width: no sideways scrolling on the share page.
  expect(await viewer.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(thirdPartyRequests(viewer)).toEqual([]);
});

test("the QR code holds the link, and opening it works on another network (AC-2.6, URL content)", async ({ browser }) => {
  const sender = await openDevice(browser, newNetwork().ip());
  const text = unique("by QR");
  await postText(sender, text);
  const { url } = await createLinkFor(sender, text);
  await expect(sender.page.getByText("Anyone who scans this can open the share.", { exact: false })).toBeVisible();
  const scanned = await decodeShownQr(sender.page);
  expect(scanned).toBe(url);

  const phone = await openViewer(browser, newNetwork().ip());
  await phone.page.goto(scanned);
  await expect(phone.page.getByTestId("shared-text")).toHaveText(text);
  expect(await sender.cspViolations()).toEqual([]);
});

test("a short code opens the share on a third network without the link (AC-2.4 flow)", async ({ browser }) => {
  const sender = await openDevice(browser, newNetwork().ip());
  const text = unique("by code");
  await postText(sender, text);
  const { url, code } = await createLinkFor(sender, text, { code: true });
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);

  const viewer = await openViewer(browser, newNetwork().ip());
  const page = await viewer.page.goto("/c");
  expect(page?.headers()["referrer-policy"]).toBe("no-referrer");
  // Typed the way a phone keyboard might: lower case, spaces instead of the hyphen.
  await viewer.page.getByTestId("code-input").fill(code!.toLowerCase().replace("-", " "));
  await viewer.page.getByTestId("code-submit").click();
  await expect(viewer.page.getByTestId("shared-text")).toHaveText(text);
  expect(viewer.page.url()).toBe(url.split("#")[0]);
  expect(viewer.requests.some((u) => u.includes(new URL(url).hash.slice(3)))).toBe(false); // the secret is never involved

  await viewer.page.goto("/c");
  await viewer.page.getByTestId("code-input").fill("ZZZZZ-ZZZZZ");
  await viewer.page.getByTestId("code-submit").click();
  await expect(viewer.page.getByRole("alert").filter({ hasText: "isn't valid or has expired" })).toBeVisible();
});

test("turning a link off and expiry end the viewer's access on the next request (AC-2.3)", async ({ browser }) => {
  const sender = await openDevice(browser, newNetwork().ip());
  const text = unique("short-lived access");
  await postText(sender, text);
  const first = await createLinkFor(sender, text);

  const viewer = await openViewer(browser, newNetwork().ip());
  await viewer.page.goto(first.url);
  await expect(viewer.page.getByTestId("shared-text")).toHaveText(text);

  await first.dialog.getByRole("button", { name: "Create another link" }).click();
  const row = first.dialog.locator(`[data-link-id="${linkIdOf(first.url)}"]`);
  await row.getByRole("button", { name: "Turn off this link" }).click();
  await expect(row.getByText("Turned off")).toBeVisible();
  await refocus(viewer.page);
  await expect(viewer.page.getByTestId("viewer-state")).toHaveAttribute("data-state", "expired");
  await expect(viewer.page.getByText(text)).toHaveCount(0);

  const second = await createLinkInDialog(sender.page);
  const other = await openViewer(browser, newNetwork().ip());
  await other.page.goto(second.url);
  await expect(other.page.getByTestId("shared-text")).toHaveText(text);
  await adminDb().query("update app.share_links set created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' where id = $1", [
    linkIdOf(second.url),
  ]);
  await other.page.reload();
  await expect(other.page.getByTestId("viewer-state")).toHaveAttribute("data-state", "expired");
});

test("a link-only post never appears on its network; its creator shares it by link (AC-2.6, T-012)", async ({ browser }) => {
  const netA = newNetwork();
  const sender = await openDevice(browser, netA.ip());
  const neighbour = await openDevice(browser, netA.ip());
  const text = unique("link only");

  await sender.page.getByTestId("composer-destination").click();
  await sender.page.getByRole("option", { name: "Link only" }).click();
  await expect(sender.page.getByTestId("audience-line")).toHaveText(/Not visible on any network/);
  await sender.page.getByTestId("composer-text").fill(text);
  await sender.page.getByTestId("composer-submit").click();
  const { url } = await createLinkInDialog(sender.page);
  await sender.page.keyboard.press("Escape");

  await expect(feed(sender).getByText(text)).toHaveCount(0);
  await neighbour.page.reload();
  await expect(neighbour.page.getByTestId("local-feed")).toBeVisible();
  await expect(neighbour.page.getByText(text)).toHaveCount(0);

  await sender.page.getByRole("link", { name: "My uploads" }).click();
  const mine = sender.page.getByTestId("share-card").filter({ hasText: text });
  await expect(mine.getByText("Link only", { exact: true })).toBeVisible();

  const viewer = await openViewer(browser, newNetwork().ip());
  await viewer.page.goto(url);
  await expect(viewer.page.getByTestId("shared-text")).toHaveText(text);
});

test("link-preview bots get generic metadata and change nothing (AC-2.5, T-033)", async ({ browser, request }) => {
  const sender = await openDevice(browser, newNetwork().ip());
  const text = unique("private preview");
  await postText(sender, text);
  const { url } = await createLinkFor(sender, text);
  const linkId = linkIdOf(url);
  const before = await adminDb().query("select unlock_count from app.share_links where id = $1", [linkId]);

  for (const agent of ["Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", "WhatsApp/2.23.20.0", "Twitterbot/1.0"]) {
    // Bots fetch the URL without its fragment: browsers and HTTP clients never send it.
    const response = await request.get(new URL(url).pathname, { headers: { "user-agent": agent } });
    expect(response.status()).toBe(200);
    expect(response.headers()["set-cookie"]).toBeUndefined();
    const html = await response.text();
    expect(html).toContain("Something was shared with you");
    expect(html).not.toContain(text);
  }
  const after = await adminDb().query("select unlock_count from app.share_links where id = $1", [linkId]);
  expect(after.rows[0].unlock_count).toBe(before.rows[0].unlock_count);
});

test("a viewer reports the share; an operator takedown ends it for the viewer (T-036)", async ({ browser }) => {
  const sender = await openDevice(browser, newNetwork().ip());
  const text = unique("please report me");
  await postText(sender, text);
  const { url } = await createLinkFor(sender, text);
  const viewer = await openViewer(browser, newNetwork().ip());
  await viewer.page.goto(url);
  await expect(viewer.page.getByTestId("shared-text")).toHaveText(text);

  await viewer.page.getByRole("button", { name: "Report" }).click();
  const dialog = viewer.page.getByTestId("report-dialog");
  await dialog.getByLabel("Phishing or a scam").check();
  await dialog.getByLabel(/^Details/).fill("Pretends to be my bank");
  const sent = viewer.page.waitForResponse((r) => r.url().endsWith("/api/v1/reports"));
  await dialog.getByTestId("report-submit").click();
  expect((await sent).status()).toBe(201);
  await expect(dialog.getByText("Thanks for reporting")).toBeVisible();
  await viewer.page.keyboard.press("Escape");

  const { rows } = await adminDb().query("select id, share_id from app.abuse_reports where link_id = $1", [linkIdOf(url)]);
  expect(rows).toHaveLength(1);
  await adminDb().query("select app.admin_block_share($1, 'confirmed phishing', 'e2e-operator', $2)", [rows[0].share_id, rows[0].id]);
  await refocus(viewer.page);
  await expect(viewer.page.getByTestId("viewer-state")).toHaveAttribute("data-state", "expired");
  await sender.page.reload();
  await expect(feed(sender).getByText(text)).toHaveCount(0);
});

test("an incomplete link explains itself and points to the code page", async ({ browser }) => {
  const viewer = await openViewer(browser, newNetwork().ip());
  await viewer.page.goto(`/s/${randomBytes(12).toString("base64url")}`);
  await expect(viewer.page.getByTestId("viewer-state")).toHaveAttribute("data-state", "incomplete");
  await expect(viewer.page.getByRole("link", { name: "Enter a share code" })).toBeVisible();
});
