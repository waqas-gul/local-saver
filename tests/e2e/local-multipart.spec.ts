import { createHash } from "node:crypto";
import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { expect, test, type Page, type Response, type Route } from "@playwright/test";
import { STORAGE } from "../../scripts/local-stack.cjs";
import { newEmail, signInThroughUi } from "./support/accounts";
import { newNetwork, openDevice } from "./support/local-devices";
import { adminDb, closeAdminDb } from "./support/remote";

/**
 * Multipart uploads in a real browser (phase 4 §17.8.1, P4-14, T4-M1). A Pro account uploads a file above
 * 100 MiB; the network to storage drops mid-way; the page is reloaded; the user picks the same file again
 * and only the parts storage doesn't have are sent; the object is verified byte for byte. Cancel ends the
 * upload on the server. Storage is RustFS (local); R2 is a staging step.
 *
 * T4-M1 asks for 5 GiB: E2E_MULTIPART_LONG=1 runs the same journey with a 5 GiB file (tagged long, not in the
 * default run, which uses 120 MiB: 8 parts).
 */

test.afterAll(closeAdminDb);

const MiB = 1024 * 1024;
const PART = 16 * MiB;
const LONG = process.env.E2E_MULTIPART_LONG === "1";

let dir = "";
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "local-saver-multipart-"));
});
test.afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A file on disk (Playwright hands large files to the browser by path), with a different fill per part. */
async function makeFile(name: string, size: number): Promise<{ path: string; sha256: string }> {
  const path = join(dir, name);
  const hash = createHash("sha256");
  const out = createWriteStream(path);
  for (let offset = 0, n = 1; offset < size; offset += PART, n++) {
    const chunk = Buffer.alloc(Math.min(PART, size - offset), n % 256);
    hash.update(chunk);
    if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
  }
  await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
  return { path, sha256: hash.digest("hex") };
}

async function proPage(page: Page): Promise<string> {
  const email = newEmail("multipart");
  await signInThroughUi(page, email);
  const { rows } = await adminDb().query("select id from auth.users where email = $1", [email]);
  await adminDb().query("select app.admin_grant_override($1, 'plan', '\"pro\"', 'e2e', 'tests')", [rows[0].id]);
  await page.reload();
  // The composer offers Pro's file size once the plan is read.
  await page.getByRole("tab", { name: "Files" }).click();
  await expect(page.getByText(/Choose files \(up to 100, 5\.0 GB each\)/)).toBeVisible();
  return rows[0].id as string;
}

async function storedSha256(key: string): Promise<{ size: number; sha256: string }> {
  const s3 = new S3Client({
    region: "auto",
    endpoint: STORAGE.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: STORAGE.accessKeyId, secretAccessKey: STORAGE.secretAccessKey },
  });
  const object = await s3.send(new GetObjectCommand({ Bucket: STORAGE.bucket, Key: key }));
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: hash.digest("hex") };
}

const partNumberOf = (url: string) => Number(new URL(url).searchParams.get("partNumber"));
const isPartPut = (url: string, method: string) => method === "PUT" && url.startsWith(STORAGE.endpoint) && url.includes("partNumber=");

test("a lost connection, a reload and the same file again: only the missing parts go, and the file arrives whole (T4-M1)", async ({ browser }) => {
  test.setTimeout(LONG ? 3_600_000 : 180_000);
  const size = LONG ? 5 * 1024 * MiB : 120 * MiB;
  const file = await makeFile(LONG ? "five-gib.bin" : "big.bin", size);
  const device = await openDevice(browser, newNetwork().ip());
  const { page } = device;
  const userId = await proPage(page);

  // Storage gets three parts, then the connection to it drops.
  const before = new Set<number>();
  let letThrough = 3;
  const stored = (response: Response) => {
    if (isPartPut(response.url(), response.request().method()) && response.status() === 200) before.add(partNumberOf(response.url()));
  };
  page.on("response", stored);
  await page.context().route(`${STORAGE.endpoint}/**`, async (route) => {
    const request = route.request();
    if (!isPartPut(request.url(), request.method())) return route.continue();
    if (letThrough > 0) {
      letThrough--;
      return route.continue();
    }
    return route.abort("internetdisconnected");
  });
  await page.getByTestId("composer-files").setInputFiles(file.path);
  await page.getByTestId("composer-submit").click();
  // Parts pass through the interception above, which is slow on a busy machine: wait as long as it takes.
  await expect.poll(() => before.size, { timeout: 60_000 }).toBe(3);
  await expect(page.getByTestId("upload-cancel")).toBeVisible();

  // Reload while the parts are failing: the browser forgets the file.
  page.off("response", stored);
  await page.context().unroute(`${STORAGE.endpoint}/**`);
  const after: number[] = [];
  page.on("request", (request) => {
    if (isPartPut(request.url(), request.method())) after.push(partNumberOf(request.url()));
  });
  await page.reload();
  await expect(page.getByText("Choose the file again to finish")).toBeVisible();
  const finished = page.waitForResponse((r) => /\/files\/[^/]+\/complete$/.test(r.url()) && r.status() === 200, { timeout: LONG ? 3_000_000 : 120_000 });
  await page.getByTestId("upload-pick").setInputFiles(file.path);
  await finished;
  await expect(page.getByText(/^Shared · /)).toBeVisible();

  // Only what storage lacked was sent after the reload.
  for (const n of before) expect(after, `part ${n} was sent again`).not.toContain(n);
  const partCount = Math.ceil(size / PART);
  expect(new Set([...before, ...after]).size).toBe(partCount);

  const { rows } = await adminDb().query(
    "select f.object_key, f.upload_status, f.size_bytes from app.files f join app.shares s on s.id = f.share_id where s.created_by_user_id = $1",
    [userId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ upload_status: "verified", size_bytes: String(size) });
  expect(await storedSha256(rows[0].object_key)).toEqual({ size, sha256: file.sha256 });
  expect(await device.cspViolations()).toEqual([]);
});

test("Cancel ends a large upload on the server: the share fails and the janitor is asked to abort it", async ({ browser }) => {
  test.skip(LONG, "covered by the default run");
  const file = await makeFile("cancel.bin", 120 * MiB);
  const device = await openDevice(browser, newNetwork().ip());
  const { page } = device;
  const userId = await proPage(page);
  // Hold the parts so the upload is still going when Cancel is pressed.
  const held: Route[] = [];
  await page.context().route(`${STORAGE.endpoint}/**`, async (route) => {
    if (isPartPut(route.request().url(), route.request().method())) return void held.push(route);
    return route.continue();
  });
  await page.getByTestId("composer-files").setInputFiles(file.path);
  await page.getByTestId("composer-submit").click();
  // Playwright buffers each held part's body before the handler runs: slow on a busy machine.
  await expect.poll(() => held.length, { timeout: 60_000 }).toBeGreaterThan(0);
  const aborted = page.waitForResponse((r) => r.url().endsWith("/multipart/abort") && r.status() === 204);
  await page.getByTestId("upload-cancel").click();
  await aborted;
  await expect(page.getByText("Cancelled.")).toBeVisible();
  for (const route of held) await route.abort().catch(() => {});

  const { rows } = await adminDb().query(
    `select s.status, f.rejection_reason, od.reason, od.multipart_upload_id = f.multipart_upload_id as same_upload
       from app.shares s join app.files f on f.share_id = s.id join app.object_deletions od on od.source_file_id = f.id
      where s.created_by_user_id = $1`,
    [userId],
  );
  expect(rows).toEqual([{ status: "failed", rejection_reason: "cancelled", reason: "multipart_abort", same_upload: true }]);
  expect(await device.cspViolations()).toEqual([]);
});
