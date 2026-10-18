import { expect, test } from "@playwright/test";
import { feed, fitsScreen, newNetwork, openDevice, postText, unique, type SimDevice } from "./support/local-devices";
import { adminDb, closeAdminDb } from "./support/remote";
import { createRoomThroughUi, signInAsPro } from "./support/rooms";

/**
 * Private rooms in real browsers (phase 4 §17.8.4, §17.14, P4-17). A Pro owner creates a room and makes an invite
 * link; a browser on another network opens it, sees the room's name, and joins only when it confirms; both post and
 * see each other's posts live; nothing reaches the owner's network. Removal reaches the removed browser at once. A
 * browser without Pro isn't offered room creation. No CSP violations; the room page fits a phone.
 */

test.afterAll(closeAdminDb);

async function inviteUrl(owner: SimDevice): Promise<string> {
  await owner.page.getByTestId("room-invite").click();
  const dialog = owner.page.getByTestId("invite-dialog");
  await expect(dialog.getByTestId("invite-warning")).toBeVisible();
  const created = owner.page.waitForResponse((r) => /\/api\/v1\/rooms\/[^/]+\/invites$/.test(r.url()) && r.request().method() === "POST");
  await dialog.getByTestId("invite-create").click();
  expect((await created).status()).toBe(201);
  const url = await dialog.getByTestId("invite-url").inputValue();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  return url;
}

test("a room across networks: invite, confirm, post both ways live, and nothing on the owner's network", async ({ browser }) => {
  test.setTimeout(150_000);
  const home = newNetwork();
  const owner = await openDevice(browser, home.ip());
  const neighbour = await openDevice(browser, home.ip());
  await signInAsPro(owner.page, "room-owner");
  const name = unique("Family");
  await createRoomThroughUi(owner, name);
  const url = await inviteUrl(owner);
  expect(url).toMatch(/\/j\/[A-Za-z0-9_-]{16}#k=[A-Za-z0-9_-]{43}$/);

  // Another network: the invite shows the room's name and waits for a click; the secret leaves the address bar.
  const guest = await openDevice(browser, newNetwork().ip());
  await guest.page.goto(url);
  await expect(guest.page.getByTestId("invite-room")).toHaveText(`You're invited to join ${name}.`);
  expect(new URL(guest.page.url()).hash).toBe("");
  const { rows: before } = await adminDb().query("select count(*)::int as n from app.room_members m join app.rooms r on r.id = m.room_id where r.label = $1", [name]);
  expect(before[0].n).toBe(1);
  await guest.page.getByTestId("invite-join").click();
  await expect(guest.page).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);
  await expect(guest.page.getByTestId("room-label")).toHaveText(name);
  await expect(guest.page.getByTestId("room-member-count")).toHaveText("2 members");
  await expect(guest.page.getByTestId("audience-line")).toContainText(`Everyone in ${name}`);

  // Both ways, live (Realtime on room:{id} invalidates; the API serves the content).
  const fromGuest = unique("from the guest");
  await postText(guest, fromGuest);
  await expect(owner.page.getByTestId("room-feed").getByText(fromGuest)).toBeVisible({ timeout: 10_000 });
  const fromOwner = unique("from the owner");
  await postText(owner, fromOwner);
  await expect(guest.page.getByTestId("room-feed").getByText(fromOwner)).toBeVisible({ timeout: 10_000 });
  await expect(owner.page.getByTestId("member-list").getByTestId("member-row")).toHaveCount(2);

  // The owner's network never sees room posts (G-R1), not even on the owner's own "This network" page.
  await expect(feed(neighbour)).toBeVisible();
  await neighbour.page.reload();
  await expect(feed(neighbour)).toBeVisible();
  await expect(feed(neighbour).getByText(fromOwner)).toHaveCount(0);
  await expect(feed(neighbour).getByText(fromGuest)).toHaveCount(0);

  // Removal: the guest's page learns at once that it is out (membership.changed, then the API's 404).
  await owner.page.getByRole("button", { name: /^Remove / }).click();
  await owner.page.getByTestId("confirm-remove").click();
  await expect(guest.page.getByTestId("room-gone")).toBeVisible({ timeout: 10_000 });
  await expect(guest.page.getByText(fromOwner)).toHaveCount(0);

  for (const device of [owner, guest, neighbour]) expect(await device.cspViolations()).toEqual([]);
});

test("without Pro, rooms can be joined but not created; the room page fits a phone", async ({ browser }) => {
  test.setTimeout(120_000);
  const visitor = await openDevice(browser, newNetwork().ip());
  await visitor.page.goto("/rooms");
  await expect(visitor.page.getByTestId("rooms-page")).toBeVisible();
  await expect(visitor.page.getByTestId("upgrade-hint")).toBeVisible();
  await expect(visitor.page.getByTestId("create-room")).toHaveCount(0);

  const owner = await openDevice(browser, newNetwork().ip());
  await signInAsPro(owner.page, "room-phone");
  const name = unique("Phone room");
  await createRoomThroughUi(owner, name);
  const url = await inviteUrl(owner);

  const phone = await openDevice(browser, newNetwork().ip(), { viewport: { width: 320, height: 720 } });
  await phone.page.goto(url);
  await phone.page.getByTestId("invite-join").click();
  await expect(phone.page.getByTestId("room-label")).toHaveText(name);
  await expect(phone.page.getByRole("banner").getByRole("link", { name: "Rooms" })).toBeInViewport();
  expect(await fitsScreen(phone.page)).toBe(true);
  await phone.page.getByTestId("room-leave").click();
  await phone.page.getByTestId("confirm-leave").click();
  await expect(phone.page).toHaveURL(/\/rooms$/);
  await expect(phone.page.getByTestId("room-row")).toHaveCount(0);
  expect(await phone.cspViolations()).toEqual([]);
});
