import { cancelAccountDeletion } from "@/lib/server/accounts/delete";
import { requireCaller } from "@/lib/server/auth/device";
import { withApi } from "@/lib/server/http/handler";

/** POST /api/v1/me/deletion/cancel (§17.5.7, P4-22): cancel this account's deletion during its grace. */
export const POST = withApi(async ({ request, env }) => {
  const caller = await requireCaller(request, env);
  await cancelAccountDeletion(caller);
  return new Response(null, { status: 204 });
});
