import { expect, test } from "@playwright/test";
import { fitsScreen, newNetwork, openDevice, postText, unique, type SimDevice } from "./support/local-devices";
import { closeAdminDb, linkIdOf, openViewer, thirdPartyRequests } from "./support/remote";
import { createRoomThroughUi, signInAsPro } from "./support/rooms";

/**
 * Read-only room links in real browsers (phase 4 §17.8.5, §17.14; P4-19). A Pro owner makes a link to a room from its
 * settings, with the DEFINED warning; a browser with no app session on another network opens it and sees the room's
 * posts (and later ones), never the room's name or who posted, and downloads a file; turning the link off ends it on
 * that browser's next request. The dialog and the share page fit a 320 px phone; no CSP violations, no third parties.
 */

test.afterAll(closeAdminDb);

async function openRoomLinks(owner: SimDevice) {
  await owner.page.getByTestId("room-settings-open").click();
  await owner.page.getByTestId("open-room-links").click();
  const dialog = owner.page.getByTestId("room-link-dialog");
  await expect(dialog.getByTestId("room-link-warning")).toHaveText("Anyone with this link can see everything posted to this room until it expires.");
  return dialog;
}

test("a room link: the owner makes it, a stranger on another network reads the room live, and it ends when turned off", async ({ browser }) => {
  test.setTimeout(150_000);
  const owner = await openDevice(browser, newNetwork().ip());
  await signInAsPro(owner.page, "roomlink-owner");
  const name = unique("Reading room");
  await createRoomThroughUi(owner, name);
  const first = unique("first room note");
  await postText(owner, first);
  await owner.page.getByRole("tab", { name: "Files" }).click();
  await owner.page.getByTestId("composer-files").setInputFiles([{ name: "agenda.txt", mimeType: "text/plain", buffer: Buffer.from("item one") }]);
  const uploaded = owner.page.waitForResponse((r) => /\/complete$/.test(r.url()) && r.status() === 200);
  await owner.page.getByTestId("composer-submit").click();
  await uploaded;

  const dialog = await openRoomLinks(owner);
  const created = owner.page.waitForResponse((r) => /\/api\/v1\/rooms\/[^/]+\/links$/.test(r.url()) && r.request().method() === "POST");
  await dialog.getByTestId("room-link-create").click();
  expect((await created).status()).toBe(201);
  const url = await dialog.getByTestId("room-link-url").inputValue();
  expect(url).toMatch(/\/s\/[A-Za-z0-9_-]{16}#k=[A-Za-z0-9_-]{43}$/);
  await expect(dialog.getByTestId("room-link-row")).toHaveCount(1);
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // A stranger, no app session, another network.
  const viewer = await openViewer(browser, newNetwork().ip());
  await viewer.page.goto(url);
  const room = viewer.page.getByTestId("room-viewer");
  await expect(room.getByText(first)).toBeVisible();
  await expect(room.getByText("agenda.txt")).toBeVisible();
  expect(new URL(viewer.page.url()).hash).toBe("");
  await expect(viewer.page.getByText(name)).toHaveCount(0);
  const download = viewer.page.waitForEvent("download");
  await room.getByRole("button", { name: "Download agenda.txt" }).click();
  expect((await download).suggestedFilename()).toBe("agenda.txt");

  // A later post shows on the viewer's next fetch (polled; a reload uses this browser's grant).
  const later = unique("posted after the link");
  await owner.page.getByRole("tab", { name: "Text" }).click();
  await postText(owner, later);
  await viewer.page.reload();
  await expect(viewer.page.getByTestId("room-viewer").getByText(later)).toBeVisible();

  // Turning the link off ends it for the viewer.
  const again = await openRoomLinks(owner);
  const revoked = owner.page.waitForResponse((r) => r.url().endsWith(`/api/v1/links/${linkIdOf(url)}`) && r.request().method() === "DELETE");
  await again.getByRole("button", { name: "Turn off" }).click();
  expect((await revoked).status()).toBe(204);
  await viewer.page.reload();
  await expect(viewer.page.getByTestId("viewer-state")).toHaveAttribute("data-state", "expired");

  expect(await owner.cspViolations()).toEqual([]);
  expect(await viewer.cspViolations()).toEqual([]);
  expect(thirdPartyRequests(viewer)).toEqual([]);
});

test("the room-link dialog and the room's share page fit a 320 px phone", async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await openDevice(browser, newNetwork().ip(), { viewport: { width: 320, height: 720 } });
  await signInAsPro(owner.page, "roomlink-phone");
  await createRoomThroughUi(owner, unique("Phone room"));
  await postText(owner, unique("a note for phones"));
  const dialog = await openRoomLinks(owner);
  expect(await fitsScreen(owner.page)).toBe(true);
  await dialog.getByTestId("room-link-create").click();
  const url = await dialog.getByTestId("room-link-url").inputValue();
  await expect(dialog.getByTestId("share-qr")).toBeVisible();
  expect(await fitsScreen(owner.page)).toBe(true);

  const phone = await openViewer(browser, newNetwork().ip(), { viewport: { width: 320, height: 720 } });
  await phone.page.goto(url);
  await expect(phone.page.getByTestId("room-share")).toHaveCount(1);
  expect(await fitsScreen(phone.page)).toBe(true);
  expect(await phone.cspViolations()).toEqual([]);
  expect(await owner.cspViolations()).toEqual([]);
});
