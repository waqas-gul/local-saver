import "server-only";
import type { z } from "zod";
import { ApiError } from "./errors";

const DEFAULT_MAX_BYTES = 64 * 1024;

/**
 * Read the body as UTF-8, counting bytes as they arrive: a chunked body without
 * Content-Length is cut off as soon as it passes the limit instead of being buffered whole.
 * Webhooks (withWebhook) use it for the raw body their signature covers.
 */
export async function readLimited(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read and validate a JSON body. Validation errors list paths and rules only,
 * never the submitted values.
 */
export async function readJson<T extends z.ZodType>(
  request: Request,
  schema: T,
  options: { maxBytes?: number } = {},
): Promise<z.infer<T>> {
  const text = await readLimited(request, options.maxBytes ?? DEFAULT_MAX_BYTES);

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
