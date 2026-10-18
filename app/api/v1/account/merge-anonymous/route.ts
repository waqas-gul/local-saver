import { redeemMerge } from "@/lib/server/accounts/merge";
import { requirePrincipal } from "@/lib/server/auth/session";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { mergeAnonymousBody } from "@/lib/shared/api/schemas";

/**
 * POST /api/v1/account/merge-anonymous (§17.5.4): after signing in, the same browser brings its
 * anonymous data into the account. Token of the account, X-Device-Id of the anonymous device (it
 * isn't the account's yet, so this is not requireCaller), and the intent's secret.
 */
export const POST = withApi(async ({ request, env }) => {
  const principal = await requirePrincipal(request, env);
  const body = await readJson(request, mergeAnonymousBody);
  return await redeemMerge(principal, request, body, env);
});
