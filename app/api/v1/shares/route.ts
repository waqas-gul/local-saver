import { requireCaller } from "@/lib/server/auth/device";
import { readJson } from "@/lib/server/http/body";
import { withApi } from "@/lib/server/http/handler";
import { currentNetwork } from "@/lib/server/network/current";
import { createFileShare, readIdempotencyKey } from "@/lib/server/shares/create";
import { createFileShareBody } from "@/lib/shared/api/schemas";

/** POST /api/v1/shares: create a file share on this network and get presigned uploads (04 §8.5). */
export const POST = withApi(async ({ request, env }) => {
  const caller = await requireCaller(request, env);
  const idempotencyKey = readIdempotencyKey(request);
  const body = await readJson(request, createFileShareBody, { maxBytes: 256 * 1024 });
  const network = await currentNetwork(request, env);
  const result = await createFileShare(caller, network, body, env, idempotencyKey);
  return Response.json(result, { status: 201 });
});
