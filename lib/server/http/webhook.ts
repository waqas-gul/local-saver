import "server-only";
import { IntegrationNotConfiguredError } from "../config/integrations";
import { getEnv, type Env } from "../env";
import { log } from "../log";
import { isRequestId, newRequestId } from "../security/ids";
import { ApiError, errorBody } from "./errors";

/**
 * The second request pipeline (phase 4 §17.7.5, C4-9): for callers that aren't browsers, the billing
 * provider's webhook and the internal reconcile route. Unlike withApi it checks no Origin and needs no
 * JSON content type, because these callers send neither; each route authenticates its caller itself
 * (a signature over the raw body, or a bearer secret) before doing anything. Never for user routes:
 * tests/unit/webhook-routes.test.ts allows it in exactly those two routes. The origin lock in
 * proxy.ts still applies (the provider calls the public hostname through Cloudflare).
 * Every response gets Cache-Control: no-store and X-Request-Id, and errors use the standard body.
 */

export type WebhookContext<Ctx> = {
  request: Request;
  requestId: string;
  env: Env;
  ctx: Ctx;
};

/** Webhook bodies are read raw, up to this size (§17.7.5 step 2). */
export const WEBHOOK_MAX_BYTES = 256 * 1024;

function finish(response: Response, requestId: string): Response {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Request-Id", requestId);
  return response;
}

export function withWebhook<Ctx = unknown>(handler: (input: WebhookContext<Ctx>) => Promise<Response | Record<string, unknown>>) {
  return async function webhookRoute(request: Request, ctx: Ctx): Promise<Response> {
    const incoming = request.headers.get("x-request-id");
    const requestId = incoming && isRequestId(incoming) ? incoming : newRequestId();
    try {
      const result = await handler({ request, requestId, env: getEnv(), ctx });
      return finish(result instanceof Response ? result : Response.json(result), requestId);
    } catch (error) {
      let apiError: ApiError;
      if (error instanceof ApiError) {
        apiError = error;
      } else if (error instanceof IntegrationNotConfiguredError) {
        log.error("webhook.not_configured", { requestId, integration: error.integration, missing: error.missing });
        apiError = new ApiError(503, "SERVICE_NOT_CONFIGURED", "This service is not available");
      } else {
        log.error("webhook.unhandled_error", { requestId, path: new URL(request.url).pathname, err: error });
        apiError = new ApiError(500, "INTERNAL_ERROR", "Something went wrong");
      }
      const response = Response.json(errorBody(apiError, requestId), { status: apiError.status });
      for (const [name, value] of Object.entries(apiError.headers ?? {})) response.headers.set(name, value);
      return finish(response, requestId);
    }
  };
}
