/** Error thrown by client-side API calls for non-2xx responses (body shape: 02 §6.1). */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: unknown,
    /** From Retry-After on 429 (DEC-034 rule 8: wait, don't retry blindly). */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}
