import pg from "pg";
import { LOCAL } from "../../../scripts/local-stack.cjs";

/**
 * Shared database state for the stack projects, set once before any test runs.
 *
 * Free burn after download is a global runtime flag (Q-008), off by default. The burn tests in
 * local-burn.spec.ts and local-mobile.spec.ts need it on. When each file switched it on and off
 * for itself, parallel workers raced: one file's cleanup turned it off while another was posting,
 * and the post was refused (phase 3 §18.11). The specs now only check it (expectFreeBurnOn).
 */

const FLAG = "free_burn_after_download";

async function setFreeBurn(enabled: boolean): Promise<void> {
  const client = new pg.Client({ connectionString: LOCAL.adminDatabaseUrl });
  await client.connect();
  try {
    const { rowCount } = await client.query("update app.runtime_flags set enabled = $1 where key = $2", [enabled, FLAG]);
    if (rowCount !== 1) throw new Error(`runtime flag ${FLAG} is missing: reset the local database (pnpm db:reset)`);
  } finally {
    await client.end();
  }
}

export default async function globalSetup() {
  // playwright.config.ts records whether the local stack is running. Without it the stack projects
  // don't exist, and there is nothing to set.
  const stack = process.env.LOCAL_SAVER_E2E_STACK;
  if (!stack || stack === "none") return;
  await setFreeBurn(true);
  // Returned as the global teardown: back to the shipped default (off).
  return async () => setFreeBurn(false);
}
