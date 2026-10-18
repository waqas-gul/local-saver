import { updateProfile } from "@/lib/server/accounts/profile";
import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { updateProfileBody } from "@/lib/shared/api/schemas";

/** PATCH /api/v1/me/profile (§17.5.5): an account's display name. Anonymous users get 403 ACCOUNT_REQUIRED. */
export const PATCH = withApi(async ({ request, env }) => {
  const caller = await requireCaller(request, env);
  const body = await readJson(request, updateProfileBody);
  return await updateProfile(caller, body.displayName);
});
