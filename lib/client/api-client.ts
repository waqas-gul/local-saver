import type { z } from "zod";
import { errorResponse } from "@/lib/shared/api/schemas";
import { ApiRequestError } from "./api-error";

/**
 * Browser API client for /api/v1 (02 §6.1). Sends the Supabase access token as a bearer
 * header and this browser's device ID. Responses are parsed with the shared zod contracts
 * before they reach the TanStack Query cache. An expired token gets one refresh and retry.
 */

export type AuthTokens = {
  getAccessToken(): Promise<string | null>;
  refreshAccessToken(): Promise<string | null>;
};

export type RequestOptions<T> = {
  body?: unknown;
  schema?: z.ZodType<T>;
  headers?: Record<string, string>;
};

export type ApiClient = {
  request<T = unknown>(method: string, path: string, options?: RequestOptions<T>): Promise<T>;
};

async function toError(response: Response): Promise<ApiRequestError> {
  const retryAfter = Number(response.headers.get("retry-after"));
  const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined;
  try {
    const parsed = errorResponse.safeParse(await response.json());
    if (parsed.success) {
      const { code, message, requestId, details } = parsed.data.error;
      return new ApiRequestError(response.status, code, message, requestId, details, retryAfterSeconds);
    }
  } catch {
    // not JSON
  }
  return new ApiRequestError(response.status, `HTTP_${response.status}`, "Request failed", undefined, undefined, retryAfterSeconds);
}

export function createApiClient(deps: {
  auth: AuthTokens;
  getDeviceId: () => string | null;
  /** Phase 4 (§17.5.6): this device was revoked from another one; the runtime signs it out. */
  onDeviceRevoked?: () => void;
  /**
   * Phase 4 (C4-2): the server knows this device under another Auth session of the same user (an
   * upgrade or an email change issues a new one). Registers again, which rebinds it; true to retry.
   */
  recoverDevice?: () => Promise<boolean>;
  /** P4-24: this session must confirm with the account's authenticator (403 MFA_REQUIRED); the runtime shows that step. */
  onMfaRequired?: () => void;
  fetch?: typeof fetch;
}): ApiClient {
  const fetcher = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));

  function send(method: string, path: string, options: RequestOptions<unknown>, token: string | null) {
    const headers = new Headers(options.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    const deviceId = deps.getDeviceId();
    if (deviceId) headers.set("x-device-id", deviceId);
    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }
    return fetcher(path, { method, headers, body, cache: "no-store", credentials: "same-origin" });
  }

  return {
    async request<T>(method: string, path: string, options: RequestOptions<T> = {}): Promise<T> {
      let response = await send(method, path, options, await deps.auth.getAccessToken());
      if (response.status === 401) {
        const error = await toError(response.clone());
        if (error.code === "UNAUTHENTICATED") {
          response = await send(method, path, options, await deps.auth.refreshAccessToken());
        } else if (error.code === "DEVICE_UNKNOWN" && deps.recoverDevice && (await deps.recoverDevice())) {
          response = await send(method, path, options, await deps.auth.getAccessToken());
        }
      }
      if (!response.ok) {
        const error = await toError(response);
        if (error.code === "DEVICE_REVOKED") deps.onDeviceRevoked?.();
        if (error.code === "MFA_REQUIRED") deps.onMfaRequired?.();
        throw error;
      }
      if (response.status === 204) return undefined as T;
      const data: unknown = await response.json();
      return options.schema ? options.schema.parse(data) : (data as T);
    },
  };
}
