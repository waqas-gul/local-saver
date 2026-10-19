import { billingProvider } from "@/lib/server/billing/provider";
import { handleBillingWebhook } from "@/lib/server/billing/webhook";
import { readLimited } from "@/lib/server/http/body";
import { ApiError } from "@/lib/server/http/errors";
import { WEBHOOK_MAX_BYTES, withWebhook } from "@/lib/server/http/webhook";

/**
 * POST /api/v1/billing/webhook (phase 4 §17.7.5): the billing provider's signed events. No session,
 * Origin or JSON content type: the signature over the raw body is the only authentication. 400 for a
 * bad signature (nothing stored), 200 once the event is stored (processed, ignored, rejected or a
 * duplicate), 500 when processing failed and the provider should retry.
 */
export const POST = withWebhook(async ({ request, env }) => {
  const provider = billingProvider(env);
  const rawBody = await readLimited(request, WEBHOOK_MAX_BYTES);
  const result = await handleBillingWebhook(provider, rawBody, request.headers, new Date());
  if (result.status === 500) throw new ApiError(500, "WEBHOOK_PROCESSING_FAILED", "Processing failed; retry later");
  return { received: true };
});
