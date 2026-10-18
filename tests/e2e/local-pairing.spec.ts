import { expect, test } from "@playwright/test";
import { fitsScreen, newNetwork, openDevice, unique } from "./support/local-devices";
import { adminDb, closeAdminDb, decodeShownQr } from "./support/remote";
import { createRoomThroughUi, signInAsPro } from "./support/rooms";

/**
 * QR pairing in real browsers (phase 4 §17.8.4.1, P4-18; T4-R15's automated half). The owner shows a QR code; a phone
 * on another network reads it (the drawn modules decoded, as a camera would), sees the room's name and that the code
 * is for scanning in person, and joins only on Join. The owner's dialog learns at once that the code was used, and
 * nobody else can use it. Closing the dialog turns an unused code off. A downgraded owner can still pair people in
 * (D4-16). The dialog fits a 320 px phone; no CSP violations. A real phone's camera remains a manual check.
 */

test.afterAll(closeAdminDb);

const roomMembers = async (name: string) =>
  (await adminDb().query("select count(*)::int as n from app.room_members m join app.rooms r on r.id = m.room_id where r.label = $1 and m.removed_at is null", [name])).rows[0].n;

test("pairing across networks: show the code, read it on a phone, confirm, join; the code then works for nobody else", async ({ browser }) => {
  test.setTimeout(150_000);
  const owner = await openDevice(browser, newNetwork().ip());
  await signInAsPro(owner.page, "pair-owner");
  const name = unique("Kitchen");
  await createRoomThroughUi(owner, name);

  const created = owner.page.waitForResponse((r) => /\/api\/v1\/rooms\/[^/]+\/invites$/.test(r.url()) && r.request().method() === "POST");
  await owner.page.getByTestId("room-pair").click();
  expect((await created).status()).toBe(201);
  const dialog = owner.page.getByTestId("pairing-dialog");
  await expect(dialog.getByTestId("share-qr")).toBeVisible();
  await expect(dialog.getByTestId("pairing-room")).toHaveText(`Scan to join ${name}`);
  await expect(dialog.getByTestId("pairing-countdown")).toHaveText(/^Expires in (10:00|9:\d\d)$/);
  const url = await decodeShownQr(owner.page);
  expect(url).toMatch(/\/j\/[A-Za-z0-9_-]{16}#k=[A-Za-z0-9_-]{43}$/);
  const secret = new URL(url).hash.replace(/^#k=/, "");
  expect(await dialog.innerHTML()).not.toContain(secret); // only in the drawn modules
  expect(await dialog.locator("input, textarea, a").count()).toBe(0);

  // A phone on mobile data reads it: the room's name, the in-person hint, and nothing joined before the tap.
  const phone = await openDevice(browser, newNetwork().ip(), { viewport: { width: 390, height: 844 } });
  await phone.page.goto(url);
  await expect(phone.page.getByTestId("invite-room")).toHaveText(`You're invited to join ${name}.`);
  await expect(phone.page.getByTestId("invite-pairing-hint")).toBeVisible();
  expect(new URL(phone.page.url()).hash).toBe("");
  expect(await roomMembers(name)).toBe(1);
  const inviteId = new URL(url).pathname.split("/").pop();
  expect((await adminDb().query("select use_count from app.room_invites where id = $1", [inviteId])).rows[0].use_count).toBe(0);
  await phone.page.getByTestId("invite-join").click();
  await expect(phone.page).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);
  await expect(phone.page.getByTestId("room-label")).toHaveText(name);
  await expect(phone.page.getByTestId("room-member-count")).toHaveText("2 members");
  await expect(phone.page.getByTestId("room-leave")).toBeVisible();
  await expect(phone.page.getByTestId("room-pair")).toHaveCount(0); // codes are the owner's (E20)

  // The owner's dialog learns it was used (the room's channel), and drops the QR code.
  await expect(dialog.getByTestId("pairing-used")).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByTestId("share-qr")).toHaveCount(0);
  await expect(owner.page.getByTestId("member-list").getByTestId("member-row")).toHaveCount(2);

  // Someone else opening the same code (a photo of the screen) can't join.
  const other = await openDevice(browser, newNetwork().ip());
  await other.page.goto(url);
  await expect(other.page.getByTestId("invite-error")).toHaveText("This invite has expired, was used up, or was turned off. Ask for a new one.");
  await expect(other.page.getByTestId("invite-join")).toHaveCount(0);
  expect(await roomMembers(name)).toBe(2);

  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  for (const device of [owner, phone, other]) expect(await device.cspViolations()).toEqual([]);
});

test("closing the QR dialog turns the code off; a downgraded owner still pairs (D4-16); the dialog fits a 320 px phone", async ({ browser }) => {
  test.setTimeout(150_000);
  const owner = await openDevice(browser, newNetwork().ip(), { viewport: { width: 320, height: 720 } });
  const { overrideId } = await signInAsPro(owner.page, "pair-phone");
  const name = unique("Hallway");
  await createRoomThroughUi(owner, name);
  expect(await fitsScreen(owner.page)).toBe(true);

  await owner.page.getByTestId("room-pair").click();
  const dialog = owner.page.getByTestId("pairing-dialog");
  await expect(dialog.getByTestId("share-qr")).toBeVisible();
  await expect(dialog.getByTestId("share-qr")).toBeInViewport({ ratio: 1 });
  expect(await fitsScreen(owner.page)).toBe(true);
  const url = await decodeShownQr(owner.page);
  const revoked = owner.page.waitForResponse((r) => /\/api\/v1\/invites\/[A-Za-z0-9_-]{16}$/.test(r.url()) && r.request().method() === "DELETE");
  await dialog.getByRole("button", { name: "Done" }).click();
  expect((await revoked).status()).toBe(204);

  const late = await openDevice(browser, newNetwork().ip());
  await late.page.goto(url);
  await expect(late.page.getByTestId("invite-error")).toHaveText("This invite has expired, was used up, or was turned off. Ask for a new one.");
  expect(await roomMembers(name)).toBe(1);

  // Downgraded: invite links say they need Pro; the QR code still works.
  await adminDb().query("select app.admin_revoke_override($1, 'e2e', 'tests')", [overrideId]);
  await owner.page.reload();
  await owner.page.getByTestId("room-invite").click();
  await expect(owner.page.getByTestId("invite-dialog").getByTestId("upgrade-hint")).toBeVisible();
  await owner.page.getByTestId("invite-dialog").getByRole("button", { name: "Cancel" }).click();
  await owner.page.getByTestId("room-pair").click();
  await expect(dialog.getByTestId("share-qr")).toBeVisible();
  const downgradedUrl = await decodeShownQr(owner.page);
  await late.page.goto(downgradedUrl);
  await late.page.getByTestId("invite-join").click();
  await expect(late.page.getByTestId("room-label")).toHaveText(name);
  await expect(dialog.getByTestId("pairing-used")).toBeVisible({ timeout: 10_000 });
  expect(await fitsScreen(owner.page)).toBe(true);
  for (const device of [owner, late]) expect(await device.cspViolations()).toEqual([]);
});
