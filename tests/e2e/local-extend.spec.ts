import { expect, test, type Page } from "@playwright/test";
import { LOCAL } from "../../scripts/local-stack.cjs";
import { newEmail, signInThroughUi } from "./support/accounts";
import { fitsScreen, newNetwork, openDevice, overlaps, postText, textLineBoxes, unique } from "./support/local-devices";
import { adminDb, closeAdminDb } from "./support/remote";

/**
 * Extend in a real browser (phase 4 §17.8.2, §17.14, P4-15). A Pro creator keeps a text longer in place and
 * another device on the network sees the new expiry (Realtime, then a refetch); the dialog fits a phone.
 * A file share whose object must move to a longer-lived class shows "Extending…" until the real
 * storage-janitor has copied it, then its new expiry, and downloads come from the copy. Non-creators and
 * Free creators are never offered Extend.
 */

test.afterAll(closeAdminDb);

async function signInAsPro(page: Page, label: string): Promise<string> {
  const email = newEmail(label);
  await signInThroughUi(page, email);
  const { rows } = await adminDb().query("select id from auth.users where email = $1", [email]);
  await adminDb().query("select app.admin_grant_override($1, 'plan', '\"pro\"', 'e2e', 'tests')", [rows[0].id]);
  await page.reload();
  return rows[0].id as string;
}

const cardOf = (page: Page, text: string) => page.getByTestId("share-card").filter({ hasText: text });

test("a Pro creator extends a text in place; another device on the network sees it; nobody else is offered Extend", async ({ browser }) => {
  const network = newNetwork();
  const phone = { viewport: { width: 320, height: 720 } };
  const creator = await openDevice(browser, network.ip(), phone);
  await signInAsPro(creator.page, "extend");
  const neighbour = await openDevice(browser, network.ip());
  const text = unique("keep me");
  await postText(creator, text);
  await expect(cardOf(creator.page, text).getByText("Expires in 24 h")).toBeVisible();
  await expect(cardOf(neighbour.page, text).getByText("Expires in 24 h")).toBeVisible();
  await expect(cardOf(neighbour.page, text).getByRole("button", { name: "Extend" })).toHaveCount(0);

  // A Free (anonymous) creator isn't offered Extend on their own share either.
  const own = unique("free share");
  await postText(neighbour, own);
  await expect(cardOf(neighbour.page, own).getByRole("button", { name: "Delete" })).toBeVisible();
  await expect(cardOf(neighbour.page, own).getByRole("button", { name: "Extend" })).toHaveCount(0);

  await cardOf(creator.page, text).getByRole("button", { name: "Extend" }).click();
  const dialog = creator.page.getByTestId("extend-dialog");
  await expect(dialog.getByRole("radiogroup")).toBeVisible();
  // At phone width the dialog fits and its title clears the close button.
  await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  expect(await fitsScreen(creator.page)).toBe(true);
  const close = await dialog.getByRole("button", { name: "Close" }).boundingBox();
  for (const line of await textLineBoxes(dialog.getByRole("heading"))) expect(overlaps(line, close!)).toBe(false);
  // 1 hour would shorten it: not offered.
  await expect(dialog.getByLabel(/^1 hour from now/)).toHaveCount(0);

  await dialog.getByLabel(/^7 days from now/).check();
  const extended = creator.page.waitForResponse((r) => r.url().endsWith("/extend") && r.status() === 200);
  await dialog.getByTestId("extend-confirm").click();
  await extended;
  await expect(dialog).toBeHidden();
  await expect(cardOf(creator.page, text).getByText("Expires in 7 days")).toBeVisible();
  await expect(cardOf(neighbour.page, text).getByText("Expires in 7 days")).toBeVisible({ timeout: 15_000 });
  expect(await creator.cspViolations()).toEqual([]);
});

test("a file share extended by copy shows Extending… until the janitor has copied it, then 30 days; the download comes from the copy", async ({ browser }) => {
  test.setTimeout(150_000);
  const device = await openDevice(browser, newNetwork().ip());
  const { page } = device;
  const userId = await signInAsPro(page, "extend-copy");
  const name = `${unique("keep").replace(" ", "-")}.txt`;
  await page.getByRole("tab", { name: "Files" }).click();
  await page.getByTestId("composer-files").setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from("extend me by copy") });
  const completed = page.waitForResponse((r) => /\/complete$/.test(r.url()) && r.status() === 200);
  await page.getByTestId("composer-submit").click();
  await completed;
  const card = cardOf(page, name);
  await expect(card.getByText("Expires in 24 h")).toBeVisible();

  await card.getByRole("button", { name: "Extend" }).click();
  const dialog = page.getByTestId("extend-dialog");
  await dialog.getByLabel(/^30 days from now/).check();
  const accepted = page.waitForResponse((r) => r.url().endsWith("/extend") && r.status() === 202);
  await dialog.getByTestId("extend-confirm").click();
  await accepted;
  await expect(dialog.getByTestId("extend-pending")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card.getByTestId("extension-pending")).toBeVisible();
  await expect(card.getByRole("button", { name: "Extend" })).toHaveCount(0);
  await expect(card.getByText("Expires in 24 h")).toBeVisible();

  // The file's upload URL is live 15 more minutes and its copy waits for it: end that wait, then ask the
  // janitor to run (pg_cron would within a minute).
  await adminDb().query(
    "update app.files f set upload_url_expires_at = now() - interval '10 minutes' from app.shares s where s.id = f.share_id and s.created_by_user_id = $1",
    [userId],
  );
  await adminDb().query(
    "update app.share_extension_files e set not_before = now() from app.shares s where s.id = e.share_id and s.created_by_user_id = $1 and e.status = 'pending'",
    [userId],
  );
  const triggered = await fetch(LOCAL.janitorUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${LOCAL.janitorTriggerSecret}`, "content-type": "application/json" },
    body: JSON.stringify({ mode: "delete" }),
  });
  expect(triggered.status).toBe(202);
  await expect(card.getByTestId("extension-pending")).toBeHidden({ timeout: 90_000 });
  await expect(card.getByText("Expires in 30 days")).toBeVisible();
  const { rows } = await adminDb().query(
    "select f.object_key from app.files f join app.shares s on s.id = f.share_id where s.created_by_user_id = $1",
    [userId],
  );
  expect(rows[0].object_key).toMatch(/^d30\//);

  const downloadPromise = page.waitForEvent("download");
  await card.getByRole("button", { name: `Download ${name}` }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(name);
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  expect(Buffer.concat(chunks).toString()).toBe("extend me by copy");
  expect(await device.cspViolations()).toEqual([]);
});
