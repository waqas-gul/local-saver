import { requestAccountDeletion } from "@/lib/server/accounts/delete";
import { getMe } from "@/lib/server/accounts/profile";
import { requireCaller } from "@/lib/server/auth/device";
import { withApi } from "@/lib/server/http/handler";

/** GET /api/v1/me (phase 4 §17.5.5): this browser's user, anonymous or an account. */
export const GET = withApi(async ({ request, env }) => {
  const caller = await requireCaller(request, env);
  return await getMe(caller);
});

/**
 * DELETE /api/v1/me (§17.5.7, P4-22): schedule this account's deletion after the grace. Needs a recent sign-in (and
 * aal2 with an authenticator). The body, if any, is ignored: the grace and the date are the server's.
 */
export const DELETE = withApi(async ({ request, env }) => {
  const caller = await requireCaller(request, env);
  return Response.json(await requestAccountDeletion(caller, env), { status: 202 });
});
