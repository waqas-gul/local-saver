import "server-only";
import { randomUUID } from "node:crypto";
import { randomToken } from "./crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function newRequestId(): string {
  return randomUUID();
}

/** True only for a canonical UUID, so a client-supplied value can never inject anything into logs or headers. */
export function isRequestId(value: string): boolean {
  return UUID.test(value);
}

/** Random base64url ID for identifiers placed in URLs (96-bit by default, 04 §1). */
export function randomId(bytes = 12): string {
  return randomToken(bytes);
}
