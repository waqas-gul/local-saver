import { expect, type Page } from "@playwright/test";
import { newEmail, signInThroughUi } from "./accounts";
import type { SimDevice } from "./local-devices";
import { adminDb } from "./remote";

/** Private-room E2E helpers (P4-17, P4-18): a Pro owner signed in through the UI, and a room made through the UI. */

/** Signs in through the UI and makes the account Pro by operator override (as support would). */
export async function signInAsPro(page: Page, label: string): Promise<{ userId: string; overrideId: string }> {
  const email = newEmail(label);
  await signInThroughUi(page, email);
  const { rows } = await adminDb().query("select id from auth.users where email = $1", [email]);
  const granted = await adminDb().query("select app.admin_grant_override($1, 'plan', '\"pro\"', 'e2e', 'tests') as id", [rows[0].id]);
  await page.reload();
  return { userId: rows[0].id, overrideId: granted.rows[0].id };
}

export async function createRoomThroughUi(owner: SimDevice, name: string): Promise<void> {
  await owner.page.getByRole("banner").getByRole("link", { name: "Rooms" }).click();
  await expect(owner.page).toHaveURL(/\/rooms$/);
  await owner.page.getByTestId("create-room").click();
  await owner.page.getByTestId("room-name").fill(name);
  await owner.page.getByTestId("create-room-submit").click();
  await expect(owner.page).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/);
  await expect(owner.page.getByTestId("room-label")).toHaveText(name);
}
