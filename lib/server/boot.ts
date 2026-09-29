import "server-only";
import { getEnv } from "./env";

/**
 * Boot-time environment check (AC-0.10), called from instrumentation.ts in the Node.js runtime.
 *
 * An error thrown from instrumentation's register() does not stop Next.js 16: the server
 * keeps running and answers every request with 500 (verified 2026-09-23). So a
 * misconfigured process exits instead of serving anything.
 */
export function validateEnvironmentOrExit(): void {
  try {
    getEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid environment configuration");
    console.error("Refusing to start: fix the environment configuration and restart.");
    process.exit(1);
  }
}
