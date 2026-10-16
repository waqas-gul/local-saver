import { createReport } from "@/lib/server/abuse/reports";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { createReportBody } from "@/lib/shared/api/schemas";

/** POST /api/v1/reports: report a share the caller can see, as a device or a link viewer (03 §7.6). */
export const POST = withApi(async ({ request, env }) => {
  const body = await readJson(request, createReportBody, { maxBytes: 16 * 1024 });
  return Response.json({ report: await createReport(request, env, body) }, { status: 201 });
});
