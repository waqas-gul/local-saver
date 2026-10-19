import { requireCaller } from "@/lib/server/auth/device";
import { createPortal } from "@/lib/server/billing/checkout";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { emptyBody } from "@/lib/shared/api/schemas";

/** POST /api/v1/billing/portal (§17.7.6): the provider's customer portal for the caller's own customer. */
export const POST = withApi(async ({ request, env }) => {
  const caller = await requireCaller(request, env);
  await readJson(request, emptyBody);
  return createPortal(caller, env);
});
