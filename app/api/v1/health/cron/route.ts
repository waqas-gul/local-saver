import { withApi } from "@/lib/server/http/handler";
import { cronHealth } from "@/lib/server/jobs/health";

/**
 * GET /api/v1/health/cron: job health for an external uptime monitor (owner decision D-5). 200 when
 * every check is ok, 503 when any is not. State words only: no counts, keys or IDs.
 */
export const GET = withApi(async ({ env }) => {
  const health = await cronHealth(env);
  return Response.json(health, { status: health.status === "ok" ? 200 : 503 });
});
