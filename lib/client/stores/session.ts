"use client";

import { createStore, type StoreApi } from "zustand/vanilla";
import type { DeviceDto } from "@/lib/shared/api/schemas";
import { createStoreContext } from "./context";
import { createPresenceStore, type PresenceState } from "./presence";
import { createUploadsStore, type UploadsState } from "./uploads";

/**
 * This browser's identity while the app runs: bootstrap phase, user ID and device.
 * Client-only state (DEC-034); the device ID is also kept in localStorage.
 *
 * Phase 4 (§17.5.2, §17.5.6): whether the user is anonymous or an account, the device_limit phase
 * (an account at its device cap: only the device list works) and a one-time notice ("This device
 * was signed out"). P4-24: the mfa phase, an account session that must confirm with its authenticator before the app
 * loads.
 */

export type SessionPhase = "starting" | "ready" | "device_limit" | "mfa" | "error" | "not_configured";

export type SessionState = {
  phase: SessionPhase;
  userId: string | null;
  /** False for a permanent account. */
  anonymous: boolean;
  device: DeviceDto | null;
  error: string | null;
  notice: string | null;
  ready: (userId: string, device: DeviceDto, anonymous?: boolean, notice?: string | null) => void;
  deviceLimit: (userId: string) => void;
  mfaRequired: (userId: string) => void;
  setDevice: (device: DeviceDto) => void;
  fail: (phase: "error" | "not_configured", error?: string) => void;
  /** Another user or session took over this browser: back to "starting" until it is bootstrapped again. */
  reset: () => void;
  dismissNotice: () => void;
};

export function createSessionStore(): StoreApi<SessionState> {
  return createStore<SessionState>()((set) => ({
    phase: "starting",
    userId: null,
    anonymous: true,
    device: null,
    error: null,
    notice: null,
    ready: (userId, device, anonymous = true, notice = null) =>
      set((s) => ({ phase: "ready", userId, device, anonymous, error: null, notice: notice ?? s.notice })),
    deviceLimit: (userId) => set({ phase: "device_limit", userId, anonymous: false, device: null, error: null }),
    mfaRequired: (userId) => set({ phase: "mfa", userId, anonymous: false, device: null, error: null }),
    setDevice: (device) => set({ device }),
    fail: (phase, error) => set({ phase, error: error ?? null }),
    reset: () => set({ phase: "starting", userId: null, anonymous: true, device: null, error: null }),
    dismissNotice: () => set({ notice: null }),
  }));
}

export const SessionStore = createStoreContext<SessionState>("useSession", createSessionStore);
export const UploadsStore = createStoreContext<UploadsState>("useUploads", createUploadsStore);
export const PresenceStore = createStoreContext<PresenceState>("usePresence", createPresenceStore);

export const useSession = SessionStore.useSelector;
export const useUploads = UploadsStore.useSelector;
export const usePresence = PresenceStore.useSelector;
