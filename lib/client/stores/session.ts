"use client";

import { createStore, type StoreApi } from "zustand/vanilla";
import type { DeviceDto } from "@/lib/shared/api/schemas";
import { createStoreContext } from "./context";
import { createPresenceStore, type PresenceState } from "./presence";
import { createUploadsStore, type UploadsState } from "./uploads";

/**
 * This browser's identity while the app runs: bootstrap phase, user ID and device.
 * Client-only state (DEC-034); the device ID is also kept in localStorage.
 */

export type SessionPhase = "starting" | "ready" | "error" | "not_configured";

export type SessionState = {
  phase: SessionPhase;
  userId: string | null;
  device: DeviceDto | null;
  error: string | null;
  ready: (userId: string, device: DeviceDto) => void;
  setDevice: (device: DeviceDto) => void;
  fail: (phase: "error" | "not_configured", error?: string) => void;
};

export function createSessionStore(): StoreApi<SessionState> {
  return createStore<SessionState>()((set) => ({
    phase: "starting",
    userId: null,
    device: null,
    error: null,
    ready: (userId, device) => set({ phase: "ready", userId, device, error: null }),
    setDevice: (device) => set({ device }),
    fail: (phase, error) => set({ phase, error: error ?? null }),
  }));
}

export const SessionStore = createStoreContext<SessionState>("useSession", createSessionStore);
export const UploadsStore = createStoreContext<UploadsState>("useUploads", createUploadsStore);
export const PresenceStore = createStoreContext<PresenceState>("usePresence", createPresenceStore);

export const useSession = SessionStore.useSelector;
export const useUploads = UploadsStore.useSelector;
export const usePresence = PresenceStore.useSelector;
