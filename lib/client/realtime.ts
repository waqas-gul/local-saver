"use client";

import { useQueryClient } from "@tanstack/react-query";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { queryKeys } from "./queries/keys";
import { useRuntime } from "./runtime";
import { PresenceStore, useSession } from "./stores/session";
import type { PresenceMember } from "./stores/presence";

/**
 * Supabase Realtime as a signal source only (DEC-034, 02 §5): handlers invalidate or
 * refetch queries by ID and never put payload data into the cache. Presence updates the
 * Zustand roster. Channels are private; the server decides who may join (T-015, T-016).
 */

const HIDDEN_DISCONNECT_MS = 5 * 60_000; // 02 §5.3: disconnect after 5 minutes hidden

type Signal = { type?: string; shareId?: string; status?: string; spaceId?: string };

/** False after the tab has been hidden for 5 minutes; true again when it is visible. */
function useTabActive(): boolean {
  const [active, setActive] = useState(true);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") timer = setTimeout(() => setActive(false), HIDDEN_DISCONNECT_MS);
      else setActive(true);
    };
    document.addEventListener("visibilitychange", onChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onChange);
    };
  }, []);
  return active;
}

function rosterOf(channel: RealtimeChannel): PresenceMember[] {
  const members = new Map<string, PresenceMember>();
  for (const entries of Object.values(channel.presenceState<PresenceMember>())) {
    for (const entry of entries) {
      if (typeof entry.deviceId === "string") {
        members.set(entry.deviceId, { deviceId: entry.deviceId, label: String(entry.label ?? ""), platform: String(entry.platform ?? "") });
      }
    }
  }
  return [...members.values()];
}

export function useRealtimeBridge(spaceIds: readonly string[]): void {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const presence = PresenceStore.useStoreApi();
  const userId = useSession((s) => s.userId);
  const device = useSession((s) => s.device);
  const active = useTabActive();
  const spaceKey = [...spaceIds].sort().join(",");

  useEffect(() => {
    if (!runtime || !userId || !device || !active) return;
    const { supabase } = runtime;
    const channels: RealtimeChannel[] = [];
    let cancelled = false;

    const onShareSignal = (signal: Signal, scope: "net" | "user") => {
      if (scope === "net") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.local() });
        if (signal.shareId && signal.status === "pending_upload") presence.getState().markIncoming(signal.shareId);
        else if (signal.shareId) presence.getState().clearIncoming(signal.shareId);
      } else {
        void queryClient.invalidateQueries({ queryKey: queryKeys.myShares() });
      }
      if (signal.shareId) void queryClient.invalidateQueries({ queryKey: queryKeys.share(signal.shareId) });
    };

    void (async () => {
      await supabase.realtime.setAuth();
      if (cancelled) return;

      const user = supabase
        .channel(`user:${userId}`, { config: { private: true } })
        .on("broadcast", { event: "share.changed" }, ({ payload }) => onShareSignal(payload as Signal, "user"))
        .subscribe((status) => {
          // Broadcast is at-most-once: catch up on every (re)subscribe (02 §5.3).
          if (status === "SUBSCRIBED") void queryClient.invalidateQueries({ queryKey: queryKeys.myShares() });
        });
      channels.push(user);

      for (const spaceId of spaceKey ? spaceKey.split(",") : []) {
        presence.getState().setConnection("connecting");
        const net = supabase.channel(`net:${spaceId}`, { config: { private: true, presence: { key: device.id } } });
        net
          .on("broadcast", { event: "share.changed" }, ({ payload }) => onShareSignal(payload as Signal, "net"))
          .on("broadcast", { event: "network.changed" }, () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.network() });
          })
          .on("presence", { event: "sync" }, () => presence.getState().setMembers(rosterOf(net)))
          .subscribe((status) => {
            if (status === "SUBSCRIBED") {
              presence.getState().setConnection("live");
              void net.track({ deviceId: device.id, label: device.label, platform: device.platform });
              void queryClient.invalidateQueries({ queryKey: queryKeys.local() });
            } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
              presence.getState().setConnection("error");
            }
          });
        channels.push(net);
      }
    })();

    return () => {
      cancelled = true;
      for (const channel of channels) void supabase.removeChannel(channel);
      presence.getState().reset();
    };
  }, [runtime, userId, device, active, spaceKey, queryClient, presence]);

  // Coming back to the tab: re-observe (the network may have changed while hidden).
  useEffect(() => {
    if (active) void queryClient.invalidateQueries({ queryKey: queryKeys.network() });
  }, [active, queryClient]);
}
