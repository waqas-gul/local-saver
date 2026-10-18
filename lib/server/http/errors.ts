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

/**
 * Phase 4 (P4-16): a password link, and this grant hasn't proved its current password. Only after the
 * secret or a code (or a grant) is proven; the link ID lets the code page send the browser to the prompt.
 */
export function passwordRequired(linkId: string): ApiError {
  return new ApiError(409, "PASSWORD_REQUIRED", "This link needs a password", { linkId });
}

/** The same error with response headers added (a viewer session cookie issued before the refusal). */
export function withHeaders(error: ApiError, headers: Record<string, string>): ApiError {
  return new ApiError(error.status, error.code, error.message, error.details, { ...error.headers, ...headers });
}

/**
 * Phase 4 (P4-17): a member (who can see the room) asked for an owner's action. Anyone who isn't a member gets the
 * plain 404 instead, as for a room that doesn't exist (§17.11.2).
 */
export function notOwner(): ApiError {
  return new ApiError(403, "NOT_OWNER", "Only the room's owner can do this");
}

/** Phase 4 (P4-17): an unknown invite, a wrong secret or a malformed one, all the same (§17.8.4.1). */
export function inviteUnavailable(): ApiError {
  return new ApiError(404, "INVITE_UNAVAILABLE", "This invite isn't available");
}

/** Only after the secret is proven: the invite expired, was used up or revoked, or its room was deleted. */
export function inviteExpired(): ApiError {
  return new ApiError(410, "INVITE_EXPIRED", "This invite has expired or was turned off");
}

/**
 * Burn after download (Phase 3, DEC-015): someone already downloaded this share. Only callers who
 * could have opened it get this; byYou tells the claimant that it was them.
 */
export function alreadyDownloaded(byYou: boolean): ApiError {
  return new ApiError(410, "ALREADY_DOWNLOADED", byYou ? "You've already downloaded this" : "Someone already downloaded this", { byYou });
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
