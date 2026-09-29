/**
 * Runs once when a Next.js server instance starts, before it serves requests.
 * A misconfigured environment stops the process (AC-0.10); in particular a production
 * build refuses to start with ALLOW_TEST_CLIENT_IP set. See lib/server/boot.ts.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateEnvironmentOrExit } = await import("@/lib/server/boot");
    validateEnvironmentOrExit();
  }
}
