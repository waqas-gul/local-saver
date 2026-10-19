import { createMergeIntent } from "@/lib/server/accounts/merge";
import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { emptyBody } from "@/lib/shared/api/schemas";

/**
 * POST /api/v1/account/merge-intents (§17.5.4): an anonymous browser asks for the proof it will need
 * after signing in to an existing account. The secret is in this response only.
 */
export const POST = withApi(async ({ request, env }) => {
  const caller = await requireCaller(request, env);
  await readJson(request, emptyBody);
  return Response.json(await createMergeIntent(caller, env), { status: 201 });
});
