import "server-only";
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
  return withStandardHeaders(Response.json(errorBody(error, requestId), { status: error.status }), requestId);
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
        if (!isJsonContentType(request.headers.get("content-type"))) {
          throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Requests must use Content-Type: application/json");
        }
      }

      const result = await handler({ request, requestId, env, ctx });
      const response = result instanceof Response ? result : Response.json(result);
      return withStandardHeaders(response, requestId);
    } catch (error) {
      if (error instanceof ApiError) return errorResponse(error, requestId);
      log.error("api.unhandled_error", { requestId, path: new URL(request.url).pathname, err: error });
      return errorResponse(new ApiError(500, "INTERNAL_ERROR", "Something went wrong"), requestId);
    }
  };
}
