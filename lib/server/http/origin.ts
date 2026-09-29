import "server-only";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isMutation(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/** CSRF defence for mutations (02 §6.1): the Origin header must exactly match an allowed origin. */
export function isAllowedOrigin(originHeader: string | null, allowedOrigins: readonly string[]): boolean {
  return originHeader !== null && allowedOrigins.includes(originHeader);
}

/** Mutations must send JSON: blocks HTML form posts, which can't set this content type. */
export function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  return contentType.split(";")[0]?.trim().toLowerCase() === "application/json";
}
