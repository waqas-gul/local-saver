import "server-only";
import { sql } from "kysely";
import { getDb } from "../db/client";
import type { Env } from "../env";
import { log } from "../log";

/**
 * Job health (phase 3 §17.12, D-5): app.cron_health sums up pg_cron, the storage janitor, burn
 * finalization, reconciliation, storage drift, the egress lists and job failures. An external
 * uptime monitor polls GET /api/v1/health/cron and alerts on 503; nothing here sends alerts.
 * The egress lists are only required where local sharing fails closed without them (deployed).
 */

export type CronHealth = { status: "ok" | "degraded"; checks: Record<string, string> };

export async function cronHealth(env: Env): Promise<CronHealth> {
  try {
    const { rows } = await sql<{ health: CronHealth }>`select app.cron_health(${env.isDeployed}::boolean) as health`.execute(getDb());
    const health = rows[0]?.health;
    if (health) return health;
  } catch (error) {
    log.error("health.cron_failed", { err: error });
  }
  return { status: "degraded", checks: { database: "error" } };
}
