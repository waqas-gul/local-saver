"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { ApiRequestError } from "@/lib/client/api-error";
import { queryKeys } from "@/lib/client/queries/keys";
import { useRuntime } from "@/lib/client/runtime";
import { downloadUrlResponse, shareResponse, type ShareDto } from "@/lib/shared/api/schemas";
import type { ShareActions } from "./share-card";

/** Wires a share card to the API. Mutations invalidate queries; nothing is cached by hand. */
export function useShareActions(share: ShareDto): ShareActions {
  const runtime = useRuntime();
  const queryClient = useQueryClient();

  return useMemo<ShareActions>(() => {
    const api = runtime?.api;
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.local() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.myShares() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.share(share.id) });
    };
    return {
      download: async (file) => {
        if (!api) return;
        const { url } = await api.request("POST", `/api/v1/files/${file.id}/download-url`, {
          body: {},
          schema: downloadUrlResponse,
        });
        // Content-Disposition: attachment (signed at upload), so this downloads in place.
        window.location.assign(url);
      },
      remove: async () => {
        if (!api) return;
        await api.request("DELETE", `/api/v1/shares/${share.id}`);
        queryClient.removeQueries({ queryKey: queryKeys.share(share.id) });
        refresh();
      },
      saveText: async (content, version) => {
        if (!api) return "ok";
        try {
          await api.request("PATCH", `/api/v1/shares/${share.id}/text`, { body: { content, version }, schema: shareResponse });
          refresh();
          return "ok";
        } catch (error) {
          if (error instanceof ApiRequestError && error.code === "VERSION_CONFLICT") return "conflict";
          throw error;
        }
      },
      reload: refresh,
    };
  }, [runtime, queryClient, share.id]);
}
