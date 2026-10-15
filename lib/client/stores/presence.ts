"use client";

import { createStore, type StoreApi } from "zustand/vanilla";

/**
 * Temporary state of the current network view (DEC-034): the Presence roster for
 * "N devices here now", the realtime connection, and shares being uploaded by others
 * (from ID-only signals; their content is fetched once they are active).
 */

export type PresenceMember = { deviceId: string; label: string; platform: string };
export type RealtimeConnection = "idle" | "connecting" | "live" | "error";

export type PresenceState = {
  members: PresenceMember[];
  connection: RealtimeConnection;
  incoming: string[];
  setMembers: (members: PresenceMember[]) => void;
  setConnection: (connection: RealtimeConnection) => void;
  markIncoming: (shareId: string) => void;
  clearIncoming: (shareId: string) => void;
  reset: () => void;
};

export function createPresenceStore(): StoreApi<PresenceState> {
  return createStore<PresenceState>()((set) => ({
    members: [],
    connection: "idle",
    incoming: [],
    setMembers: (members) => set({ members }),
    setConnection: (connection) => set({ connection }),
    markIncoming: (shareId) => set((s) => (s.incoming.includes(shareId) ? s : { incoming: [...s.incoming, shareId] })),
    clearIncoming: (shareId) => set((s) => ({ incoming: s.incoming.filter((id) => id !== shareId) })),
    reset: () => set({ members: [], connection: "idle", incoming: [] }),
  }));
}
