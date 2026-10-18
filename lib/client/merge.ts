import { mergeAnonymousResponse, mergeIntentResponse, type MergeAnonymousResponse } from "@/lib/shared/api/schemas";
import { clearMergeIntent, readMergeIntent, storeMergeIntent } from "./account-storage";
import type { ApiClient } from "./api-client";
import { ApiRequestError } from "./api-error";

/**
 * The browser side of the merge (phase 4 §17.5.4). Before signing in to an existing account, the
 * anonymous session asks for an intent and keeps it here; after signing in, this browser redeems it
 * with the account's token and its own device ID (the api client sends both). The intent stays for
 * 24 hours, so a merge that couldn't finish (the device cap, a lost connection) is retried at the
 * next start (RISK-043).
 */

export type MergeOutcome =
  | { kind: "merged"; merged: MergeAnonymousResponse["merged"] }
  /** The account is at its device cap: revoke a device, then it is retried. */
  | { kind: "device_limit" }
  /** Expired, already used for another account, or refused for good: nothing will move. */
  | { kind: "gone"; code: string }
  /** Not now (offline, a server error): kept for the next start. */
  | { kind: "retry" };

/** Before signing in: make the proof while the anonymous session is still this browser's. */
export async function prepareMerge(api: ApiClient): Promise<"ready" | "nothing_to_merge"> {
  try {
    storeMergeIntent(await api.request("POST", "/api/v1/account/merge-intents", { body: {}, schema: mergeIntentResponse }));
    return "ready";
  } catch (error) {
    // No device yet (this browser never started the app): there is nothing to bring along.
    if (error instanceof ApiRequestError && (error.code === "DEVICE_REQUIRED" || error.code === "DEVICE_UNKNOWN")) {
      clearMergeIntent();
      return "nothing_to_merge";
    }
    throw error;
  }
}

/** After signing in: bring this browser's anonymous data into the account, if a merge is pending. */
export async function redeemPendingMerge(api: ApiClient): Promise<MergeOutcome | null> {
  const intent = readMergeIntent();
  if (!intent) return null;
  try {
    const result = await api.request("POST", "/api/v1/account/merge-anonymous", {
      body: { intentId: intent.intentId, secret: intent.secret },
      schema: mergeAnonymousResponse,
    });
    clearMergeIntent();
    return { kind: "merged", merged: result.merged };
  } catch (error) {
    if (!(error instanceof ApiRequestError)) return { kind: "retry" };
    if (error.code === "DEVICE_LIMIT") return { kind: "device_limit" };
    // Still anonymous (the sign-in didn't finish), or the account must confirm with its authenticator first (P4-24):
    // keep it for when it does.
    if (error.code === "ACCOUNT_REQUIRED" || error.code === "MFA_REQUIRED" || error.status >= 500 || error.status === 429) {
      return { kind: "retry" };
    }
    clearMergeIntent();
    return { kind: "gone", code: error.code };
  }
}
