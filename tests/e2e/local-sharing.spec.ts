import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { feed, newNetwork, openDevice, PNG_1X1, postText, type SimDevice, unique } from "./support/local-devices";

/**
 * Phase 1 multi-device E2E (09 §1.5): each browser context is a separate device with its own
 * anonymous user, on a simulated network (X-Test-Client-IP on same-origin API calls only).
 * Runs against the STACK server (full local stack).
 */

test("same network: a new device sees existing posts with no join step, and new posts within 2 s (AC-1.1, T-002)", async ({ browser }) => {
  const net = newNetwork();
  const a = await openDevice(browser, net.ip());
  const first = unique("existing note");
  await postText(a, first);
  await expect(feed(a).getByText(first)).toBeVisible();

  const b = await openDevice(browser, net.ip());
  await expect(feed(b).getByText(first)).toBeVisible();
  await expect(b.page.getByTestId("network-line")).toHaveText("This network · 2 devices here now");
  // The audience is stated once, at the point of posting (DEC-033).
  await expect(b.page.getByTestId("audience-line")).toHaveText("Visible to everyone on this network");
  await expect(b.page.getByText(/Visible to everyone on this network/)).toHaveCount(1);

  const second = unique("live note");
  await postText(a, second);
  const started = Date.now();
  await expect(feed(b).getByText(second)).toBeVisible({ timeout: 2_000 });
  expect(Date.now() - started).toBeLessThan(2_000);

  expect(await a.cspViolations()).toEqual([]);
  expect(await b.cspViolations()).toEqual([]);
});

test("another network sees nothing (T-001)", async ({ browser }) => {
  const a = await openDevice(browser, newNetwork().ip());
  const secret = unique("network A only");
  await postText(a, secret);

  const c = await openDevice(browser, newNetwork().ip());
  await expect(c.page.getByText("Nothing has been shared on this network yet.")).toBeVisible();
  await expect(c.page.getByText(secret)).toHaveCount(0);
});

test("leaving the network removes its content from the page (T-003, RISK-027)", async ({ browser }) => {
  const home = newNetwork();
  const a = await openDevice(browser, home.ip());
  const note = unique("home note");
  await postText(a, note);
  const b = await openDevice(browser, home.ip());
  await expect(feed(b).getByText(note)).toBeVisible();

  await b.moveTo(newNetwork().ip());
  await expect(b.page.getByText("Nothing has been shared on this network yet.")).toBeVisible();
  await expect(b.page.getByText(note)).toHaveCount(0);

  await b.moveTo(home.ip());
  await expect(feed(b).getByText(note)).toBeVisible();
});

test("files upload with progress, preview on another device and download as attachments", async ({ browser }) => {
  const net = newNetwork();
  const a = await openDevice(browser, net.ip());
  const b = await openDevice(browser, net.ip());
  const name = `${randomBytes(3).toString("hex")}-notes.txt`;
  const content = `hello ${randomBytes(4).toString("hex")}`;

  await a.page.getByRole("tab", { name: "Files" }).click();
  await a.page.getByTestId("composer-files").setInputFiles([
    { name, mimeType: "text/plain", buffer: Buffer.from(content) },
    { name: "pixel.png", mimeType: "image/png", buffer: PNG_1X1 },
  ]);
  await a.page.getByTestId("composer-submit").click();
  await expect(a.page.getByText(/^Shared/).first()).toBeVisible();

  await expect(feed(b).getByText(name)).toBeVisible({ timeout: 5_000 });
  const preview = feed(b).getByRole("img", { name: "pixel.png" });
  await expect(preview).toBeVisible();
  expect(await preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);

  const downloadPromise = b.page.waitForEvent("download");
  await feed(b).getByRole("button", { name: `Download ${name}` }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(name);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  expect(Buffer.concat(chunks).toString("utf8")).toBe(content);

  expect(await b.cspViolations()).toEqual([]);
});

test("the creator edits and deletes; the other device follows live (T-011, T-015)", async ({ browser }) => {
  const net = newNetwork();
  const a = await openDevice(browser, net.ip());
  const b = await openDevice(browser, net.ip());
  const original = unique("draft");
  await postText(a, original);
  await expect(feed(b).getByText(original)).toBeVisible();

  const card = (device: SimDevice, text: string) => feed(device).getByTestId("share-card").filter({ hasText: text });
  await expect(card(b, original).getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(card(b, original).getByRole("button", { name: "Delete" })).toHaveCount(0);

  const edited = unique("edited");
  await card(a, original).getByRole("button", { name: "Edit" }).click();
  await feed(a).getByLabel("Edit text").fill(edited);
  await feed(a).getByRole("button", { name: "Save" }).click();
  await expect(feed(b).getByText(edited)).toBeVisible({ timeout: 2_000 });

  await card(a, edited).getByRole("button", { name: "Delete" }).click();
  await expect(feed(b).getByText(edited)).toHaveCount(0, { timeout: 2_000 });
});
