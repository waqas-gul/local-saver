/**
 * What this browser keeps for its account (phase 4 §17.5): the device ID it registered (Phase 1)
 * and, between "create a merge intent" and "redeem it", the intent and its one-time secret.
 * localStorage only, like the Supabase session itself; private mode loses them, which only means
 * a new device row or a merge that has to be started again.
 */

const DEVICE_KEY = "local-saver.device-id";
const MERGE_KEY = "local-saver.merge-intent";

export type StoredMergeIntent = { intentId: string; secret: string; expiresAt: string };

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // private mode: nothing is kept
  }
}

export const readStoredDeviceId = () => read(DEVICE_KEY);
export const storeDeviceId = (id: string) => write(DEVICE_KEY, id);
export const clearStoredDeviceId = () => write(DEVICE_KEY, null);

/** The pending merge (≤ 24 h). Expired or malformed entries read as none. */
export function readMergeIntent(now = Date.now()): StoredMergeIntent | null {
  const raw = read(MERGE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredMergeIntent>;
    if (typeof value.intentId !== "string" || typeof value.secret !== "string" || typeof value.expiresAt !== "string") return null;
    if (Date.parse(value.expiresAt) <= now) {
      write(MERGE_KEY, null);
      return null;
    }
    return { intentId: value.intentId, secret: value.secret, expiresAt: value.expiresAt };
  } catch {
    return null;
  }
}

export const storeMergeIntent = (intent: StoredMergeIntent) => write(MERGE_KEY, JSON.stringify(intent));
export const clearMergeIntent = () => write(MERGE_KEY, null);
