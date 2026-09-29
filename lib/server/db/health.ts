import "server-only";
import { sql } from "kysely";
import { getEnv } from "../env";
import { log } from "../log";
import { getDb } from "./client";

export type DatabaseStatus = "ok" | "error" | "not_configured";

const TIMEOUT_MS = 2_000;

/** Readiness probe for /api/v1/health?ready=1. Never throws; never exposes connection details. */
export async function checkDatabase(): Promise<DatabaseStatus> {
  if (!getEnv().DATABASE_URL) return "not_configured";
  try {
    await Promise.race([
      sql`select 1`.execute(getDb()),
      new Promise((_, reject) => setTimeout(() => reject(new Error("database health check timed out")), TIMEOUT_MS)),
    ]);
    return "ok";
  } catch (error) {
    log.error("health.database_unreachable", { err: error });
    return "error";
  }
}
