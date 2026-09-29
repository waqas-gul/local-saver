import "server-only";
import type { z } from "zod";
import { ApiError } from "./errors";

const DEFAULT_MAX_BYTES = 64 * 1024;

/**
 * Read and validate a JSON body. Validation errors list paths and rules only,
 * never the submitted values.
 */
export async function readJson<T extends z.ZodType>(
  request: Request,
  schema: T,
  options: { maxBytes?: number } = {},
): Promise<z.infer<T>> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");

  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body is not valid JSON");
  }

  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code }));
    throw new ApiError(400, "VALIDATION_FAILED", "Request body failed validation", details);
  }
  return result.data;
}
