import { checkDatabase } from "@/lib/server/db/health";
import { withApi } from "@/lib/server/http/handler";

/**
 * GET /api/v1/health          liveness: the process is up (no dependencies)
 * GET /api/v1/health?ready=1  readiness: also checks the database, when one is configured
 */
export const GET = withApi(async ({ request }) => {
  const ready = new URL(request.url).searchParams.get("ready") === "1";
  const time = new Date().toISOString();
  if (!ready) return { status: "ok", time };

  const database = await checkDatabase();
  if (database === "error") {
    return Response.json({ status: "degraded", time, checks: { database } }, { status: 503 });
  }
  return { status: "ok", time, checks: { database } };
});
