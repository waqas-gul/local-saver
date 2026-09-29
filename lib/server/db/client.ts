import "server-only";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { getDatabaseUrl } from "../config/integrations";
import { getEnv } from "../env";
import type { DB } from "./types.gen";

/**
 * Query layer (DEC-007): Kysely over the Supavisor pooler, connecting as `app_server`.
 * Created lazily so that building or starting the app never needs a database.
 */
let db: Kysely<DB> | undefined;

export function getDb(): Kysely<DB> {
  db ??= new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: getDatabaseUrl(getEnv()),
        max: 5,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        application_name: "local-saver-web",
      }),
    }),
  });
  return db;
}

/** Tests only. */
export async function closeDb(): Promise<void> {
  await db?.destroy();
  db = undefined;
}
