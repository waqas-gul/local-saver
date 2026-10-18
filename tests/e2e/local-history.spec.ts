import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { feed, fitsScreen, newNetwork, openDevice, postText, unique } from "./support/local-devices";
import { closeAdminDb } from "./support/remote";
import { signInAsPro } from "./support/rooms";

/**
 * Transfer history in real browsers (phase 4 §17.8.6, §17.14; P4-20). A Pro account reaches it from My uploads, sees
 * its shares and, for one of them, a neighbour's download by actor kind only; the view and filters live in the URL
 * (a reload keeps them); the page fits a 320 px phone. A browser without Pro gets the Pro hint. No CSP violations.
 */

test.afterAll(closeAdminDb);

test("a Pro account sees its shares and what happened to them, from My uploads, with the filters in the URL", async ({ browser }) => {
  test.setTimeout(150_000);
  const net = newNetwork();
  const owner = await openDevice(browser, net.ip());
  await signInAsPro(owner.page, "history-owner");
  const neighbour = await openDevice(browser, net.ip());

  const note = unique("history note");
  await postText(owner, note);
  const name = `${randomBytes(3).toString("hex")}-minutes.txt`;
  await owner.page.getByRole("tab", { name: "Files" }).click();
  await owner.page.getByTestId("composer-files").setInputFiles([{ name, mimeType: "text/plain", buffer: Buffer.from("minutes") }]);
  const uploaded = owner.page.waitForResponse((r) => /\/complete$/.test(r.url()) && r.status() === 200);
  await owner.page.getByTestId("composer-submit").click();
  await uploaded;

  const downloaded = neighbour.page.waitForEvent("download");
  await feed(neighbour).getByRole("button", { name: `Download ${name}` }).click();
  await downloaded;

  await owner.page.getByRole("banner").getByRole("link", { name: "My uploads" }).click();
  await owner.page.getByTestId("history-link").click();
  await expect(owner.page).toHaveURL(/\/history$/);
  const history = owner.page.getByTestId("history");
  await expect(history).toContainText("over the last 365 days");
  const rows = owner.page.getByTestId("history-share");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText(name);
  await expect(rows.nth(1)).toContainText("Text");

  await owner.page.getByTestId("history-status-ended").click();
  await expect(owner.page).toHaveURL(/\/history\?status=ended$/);
  await expect(history).toContainText("Nothing shared in this period.");
  await owner.page.getByTestId("history-status-all").click();
  await expect(rows).toHaveCount(2);

  await rows.first().getByTestId("history-share-downloads").click();
  await expect(owner.page).toHaveURL(/\/history\?view=downloads&shareId=[0-9a-f-]{36}$/);
  const download = owner.page.getByTestId("history-download");
  await expect(download).toHaveCount(1);
  await expect(download).toContainText(`Download · ${name}`);
  await expect(download.getByTestId("history-download-who")).toContainText("Someone on the network");
  await owner.page.reload();
  await expect(owner.page.getByTestId("history-download")).toHaveCount(1);
  await expect(owner.page.getByTestId("history-all-downloads")).toBeVisible();

  // Phone width: both views fit.
  await owner.page.setViewportSize({ width: 320, height: 720 });
  expect(await fitsScreen(owner.page)).toBe(true);
  await owner.page.getByTestId("history-tab-shares").click();
  await expect(rows).toHaveCount(2);
  expect(await fitsScreen(owner.page)).toBe(true);
  expect(await owner.cspViolations()).toEqual([]);
});

test("a browser without Pro gets the Pro hint on a 320 px phone", async ({ browser }) => {
  const visitor = await openDevice(browser, newNetwork().ip(), { viewport: { width: 320, height: 720 } });
  await visitor.page.getByRole("banner").getByRole("link", { name: "My uploads" }).click();
  await visitor.page.getByTestId("history-link").click();
  const hint = visitor.page.getByTestId("upgrade-hint");
  await expect(hint).toContainText("Transfer history comes with Pro.");
  await expect(hint.getByRole("link", { name: "See plans" })).toHaveAttribute("href", "/pricing");
  await expect(visitor.page.getByTestId("history-share")).toHaveCount(0);
  expect(await fitsScreen(visitor.page)).toBe(true);
  expect(await visitor.cspViolations()).toEqual([]);
});
