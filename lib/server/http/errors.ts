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

/**
 * Link viewers (03 §4.2): an unknown link, a wrong secret and a missing grant all get this same
 * 404, so nothing about a link is revealed before its secret is proven (T-030).
 */
export function linkUnavailable(): ApiError {
  return new ApiError(404, "LINK_UNAVAILABLE", "This link isn't available");
}

/** Only after the secret (or a grant) is proven: the link was revoked, expired or its share ended. */
export function linkExpired(): ApiError {
  return new ApiError(410, "LINK_EXPIRED", "This link has expired or was turned off");
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
