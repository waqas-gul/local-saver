import "server-only";

/**
 * API error model (02 §6.1):
 * { "error": { "code": "SHARE_EXPIRED", "message": "…", "requestId": "…" } }
 * Resources outside the caller's scope return 404, not 403.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /** Extra response headers, for example Retry-After on 429. */
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The one body for "doesn't exist" and "not yours" (03 §4.9): reveals nothing. */
export function notFound(): ApiError {
  return new ApiError(404, "NOT_FOUND", "Not found");
}

export type ErrorBody = {
  error: { code: string; message: string; requestId: string; details?: unknown };
};

export function errorBody(error: ApiError, requestId: string): ErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}
