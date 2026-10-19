import "server-only";
import { IntegrationNotConfiguredError } from "../config/integrations";
import { getEnv, type Env } from "../env";
import { log } from "../log";
import { isRequestId, newRequestId } from "../security/ids";
import { ApiError, errorBody } from "./errors";
import { isAllowedOrigin, isJsonContentType, isMutation } from "./origin";

/**
 * Wrapper for /api/v1 route handlers (DEC-008, 02 §6.1). Every response gets
 * Cache-Control: no-store and X-Request-Id. Mutations must be JSON from an allowed Origin.
 * Handlers stay thin: parse input, call one service, return a DTO.
 */

export type ApiContext<Ctx> = {
  request: Request;
  requestId: string;
  env: Env;
  ctx: Ctx;
};

type HandlerResult = Response | Record<string, unknown> | unknown[];

function withStandardHeaders(response: Response, requestId: string): Response {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Request-Id", requestId);
  return response;
}

function errorResponse(error: ApiError, requestId: string): Response {
  const response = Response.json(errorBody(error, requestId), { status: error.status });
  for (const [name, value] of Object.entries(error.headers ?? {})) response.headers.set(name, value);
  return withStandardHeaders(response, requestId);
}

/**
 * The caller's own user went away while its request ran (P4-21): a merge moved the anonymous user's things to an
 * account and deleted it, or the account was deleted. A write naming that user then fails its foreign key to
 * auth.users and rolls back. The answer is the one the caller's next request gets (its device is gone), not a 500.
 */
function isCallerGone(error: unknown): boolean {
  const pg = error as { code?: unknown; constraint?: unknown; detail?: unknown };
  return (
    pg.code === "23503" &&
    typeof pg.constraint === "string" &&
    pg.constraint.endsWith("_user_id_fkey") &&
    typeof pg.detail === "string" &&
    pg.detail.includes('is not present in table "users"')
  );
}

/** A DELETE without a body has nothing to declare; anything with a body must be JSON (DV1-13). */
function hasBody(request: Request): boolean {
  if (request.method !== "DELETE") return true;
  const length = request.headers.get("content-length");
  return request.headers.has("content-type") || request.headers.has("transfer-encoding") || (length !== null && length !== "0");
}

export function withApi<Ctx = unknown>(handler: (input: ApiContext<Ctx>) => Promise<HandlerResult>) {
  return async function apiRoute(request: Request, ctx: Ctx): Promise<Response> {
    const incoming = request.headers.get("x-request-id");
    const requestId = incoming && isRequestId(incoming) ? incoming : newRequestId();

    try {
      const env = getEnv();

      if (isMutation(request.method)) {
        if (!isAllowedOrigin(request.headers.get("origin"), env.allowedOrigins)) {
          throw new ApiError(403, "FORBIDDEN_ORIGIN", "Request origin is not allowed");
        }
        if (hasBody(request) && !isJsonContentType(request.headers.get("content-type"))) {
          throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Requests must use Content-Type: application/json");
        }
      }

      const result = await handler({ request, requestId, env, ctx });
      const response = result instanceof Response ? result : Response.json(result);
      return withStandardHeaders(response, requestId);
    } catch (error) {
      if (error instanceof ApiError) return errorResponse(error, requestId);
      if (error instanceof IntegrationNotConfiguredError) {
        log.error("api.not_configured", { requestId, integration: error.integration, missing: error.missing });
        return errorResponse(new ApiError(503, "SERVICE_NOT_CONFIGURED", "This service is not available"), requestId);
      }
      if (isCallerGone(error)) {
        log.warn("api.caller_gone", { requestId, path: new URL(request.url).pathname });
        return errorResponse(new ApiError(401, "DEVICE_UNKNOWN", "Unknown device"), requestId);
      }
      log.error("api.unhandled_error", { requestId, path: new URL(request.url).pathname, err: error });
      return errorResponse(new ApiError(500, "INTERNAL_ERROR", "Something went wrong"), requestId);
    }
  };
}
