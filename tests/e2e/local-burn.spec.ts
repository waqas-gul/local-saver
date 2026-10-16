import { expect, test } from "@playwright/test";
import { feed, newNetwork, openDevice, unique, type SimDevice } from "./support/local-devices";
import { adminDb, closeAdminDb, createLinkFor, createLinkInDialog, expectFreeBurnOn, linkIdOf, openViewer } from "./support/remote";

/**
 * Phase 3 E2E (phase 3 §17.15): burn after download in real browsers on the local stack. A device
 * posts with the toggle; the first to open it after confirming gets it; everyone else sees it go.
 * Link viewers claim the same way; the creator never does; link unfurlers and a page left open
 * never claim. The wording marked OWNER REVIEW in components/burn/copy.ts is provisional (AC-3.8).
 */

// Free burn is switched on once for the whole run by the E2E global setup, never here: files that
// toggled it raced each other in parallel workers.
test.beforeAll(expectFreeBurnOn);
test.afterAll(closeAdminDb);

async function textShareStatus(text: string): Promise<string> {
  const { rows } = await adminDb().query(
    "select s.status from app.shares s join app.text_items t on t.share_id = s.id where t.content = $1 order by s.created_at desc limit 1",
    [text],
  );
  return rows[0]?.status ?? "missing";
}

async function postBurnText(device: SimDevice, text: string) {
  await device.page.getByTestId("composer-burn").check();
  await device.page.getByTestId("composer-text").fill(text);
  const posted = device.page.waitForResponse((r) => r.url().endsWith("/api/v1/texts") && r.status() === 201);
  await device.page.getByTestId("composer-submit").click();
  await posted;
}

async function postBurnFile(device: SimDevice, name: string, body: string) {
  await device.page.getByRole("tab", { name: "Files" }).click();
  await device.page.getByTestId("composer-burn").check();
  await device.page.getByTestId("composer-files").setInputFiles([{ name, mimeType: "text/plain", buffer: Buffer.from(body) }]);
  await device.page.getByTestId("composer-submit").click();
}

test("burn text: A posts it, B reveals it after confirming, C sees it go (T-040)", async ({ browser }) => {
  const net = newNetwork();
  const a = await openDevice(browser, net.ip());
  const b = await openDevice(browser, net.ip());
  const c = await openDevice(browser, net.ip());
  const secret = unique("burn note");

  await a.page.getByTestId("composer-burn").check();
  await expect(a.page.getByTestId("burn-line")).toHaveText("The first person on this network to open it gets it");
  await postBurnText(a, secret);

  const cardB = feed(b).getByTestId("share-card").filter({ has: b.page.getByTestId("burn-reveal") });
  await expect(cardB).toHaveCount(1, { timeout: 5_000 });
  await expect(feed(b).getByText(secret)).toHaveCount(0);
  await expect(feed(c).getByTestId("burn-reveal")).toHaveCount(1, { timeout: 5_000 });

  await cardB.getByTestId("burn-reveal").click();
  await expect(b.page.getByTestId("burn-confirm")).toContainText("This will be deleted after you open it.");
  await b.page.getByTestId("burn-confirm-button").click();
  await expect(feed(b).getByTestId("share-text")).toHaveText(secret);

  // C never sees the text; the share leaves C's feed (Realtime signal, or the next refetch).
  await expect(feed(c).getByTestId("burn-reveal")).toHaveCount(0, { timeout: 10_000 });
  await expect(c.page.getByText(secret)).toHaveCount(0);
  expect(await textShareStatus(secret)).toBe("claimed");
  // A claimed share leaves every network feed but its claimant's; its creator finds it in My
  // uploads, with the text and the opened state (phase 3 §17.8.7).
  await expect(feed(a).getByText(secret)).toHaveCount(0, { timeout: 10_000 });
  await a.page.goto("/uploads");
  const mine = a.page.getByTestId("my-uploads").getByTestId("share-card").filter({ hasText: secret });
  await expect(mine.getByTestId("burn-opened")).toBeVisible();
  for (const d of [a, b, c]) expect(await d.cspViolations()).toEqual([]);
});

test("burn file: B downloads after confirming, can retry, and ends it with \"I've got it\" (T-038)", async ({ browser }) => {
  const net = newNetwork();
  const a = await openDevice(browser, net.ip());
  const b = await openDevice(browser, net.ip(), { acceptDownloads: true });
  const name = `${unique("burn").replace(" ", "-")}.txt`;
  await postBurnFile(a, name, "burn me");

  const card = feed(b).getByTestId("share-card").filter({ hasText: name });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.getByRole("button", { name: `Download ${name}` }).click();
  await expect(b.page.getByTestId("burn-confirm")).toBeVisible();
  const first = b.page.waitForEvent("download");
  await b.page.getByTestId("burn-confirm-button").click();
  expect((await first).suggestedFilename()).toBe(name);

  await expect(card.getByTestId("downloads-left")).toHaveText("2 downloads left");
  await expect(card.getByTestId("burn-claimant")).toBeVisible();
  const retry = b.page.waitForEvent("download");
  await card.getByRole("button", { name: `Download ${name}` }).click(); // no second confirmation
  await retry;
  await expect(card.getByTestId("downloads-left")).toHaveText("1 download left");

  await card.getByTestId("burn-got-it").click();
  await expect(card).toHaveCount(0, { timeout: 5_000 });
  expect(await b.cspViolations()).toEqual([]);
});

test("a link viewer claims a burn share; the next viewer is told it was downloaded; the creator still downloads (D-7)", async ({ browser }) => {
  const a = await openDevice(browser, newNetwork().ip(), { acceptDownloads: true });
  const name = `${unique("linked").replace(" ", "-")}.txt`;
  await postBurnFile(a, name, "via link");
  const own = feed(a).getByTestId("share-card").filter({ hasText: name });
  await expect(own).toBeVisible({ timeout: 10_000 });
  await own.getByRole("button", { name: "Share link" }).click();
  await expect(a.page.getByTestId("burn-link-warning")).toBeVisible();
  const { url } = await createLinkInDialog(a.page);
  await a.page.keyboard.press("Escape");

  const v1 = await openViewer(browser, newNetwork().ip());
  await v1.page.goto(url);
  await v1.page.getByRole("button", { name: `Download ${name}` }).click();
  await expect(v1.page.getByTestId("burn-confirm")).toContainText("This will be deleted after you open it.");
  const download = v1.page.waitForEvent("download");
  await v1.page.getByTestId("burn-confirm-button").click();
  expect((await download).suggestedFilename()).toBe(name);
  await expect(v1.page.getByTestId("downloads-left")).toHaveText("2 downloads left");

  const v2 = await openViewer(browser, newNetwork().ip());
  await v2.page.goto(url);
  await expect(v2.page.getByTestId("viewer-state")).toHaveAttribute("data-state", "downloaded");

  // The creator's own download never claims, and still works while the viewer's grace lasts
  // (from My uploads: a claimed share is in no network feed but its claimant's).
  await a.page.goto("/uploads");
  const mineCard = a.page.getByTestId("my-uploads").getByTestId("share-card").filter({ hasText: name });
  await expect(mineCard.getByTestId("burn-opened")).toBeVisible();
  const mine = a.page.waitForEvent("download");
  await mineCard.getByRole("button", { name: `Download ${name}` }).click();
  await mine;
  await expect(a.page.getByTestId("burn-confirm")).toHaveCount(0);
  const { rows } = await adminDb().query(
    "select s.status, s.claimed_link_id from app.shares s join app.files f on f.share_id = s.id where f.original_name = $1",
    [name],
  );
  expect(rows[0]).toEqual({ status: "claimed", claimed_link_id: linkIdOf(url) });
});

test("link unfurlers and a share page left open never claim (AC-3.8, T3-12)", async ({ browser, request }) => {
  const a = await openDevice(browser, newNetwork().ip());
  const secret = unique("left open");
  await postBurnText(a, secret);
  const { url } = await createLinkFor(a, secret);
  await a.page.keyboard.press("Escape");

  for (const agent of ["Slackbot-LinkExpanding 1.0", "facebookexternalhit/1.1", "WhatsApp/2.23"]) {
    expect((await request.get(url, { headers: { "user-agent": agent } })).status()).toBe(200);
  }
  // A scanner that runs the page's script: it unlocks and polls, but never clicks.
  const scanner = await openViewer(browser, newNetwork().ip());
  await scanner.page.goto(url);
  await expect(scanner.page.getByTestId("burn-reveal")).toBeVisible();
  await scanner.page.waitForTimeout(5_000);
  await expect(scanner.page.getByText(secret)).toHaveCount(0);
  expect(await textShareStatus(secret)).toBe("active");
  const { rows } = await adminDb().query(
    "select count(*)::int as n from app.downloads d join app.text_items t on t.share_id = d.share_id where t.content = $1",
    [secret],
  );
  expect(rows[0].n).toBe(0);
});
