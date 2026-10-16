"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { ApiRequestError } from "@/lib/client/api-error";
import { queryKeys } from "@/lib/client/queries/keys";
import { useRuntime } from "@/lib/client/runtime";
import { downloadUrlResponse, revealResponse, shareResponse, type ShareDto } from "@/lib/shared/api/schemas";
import type { ShareActions } from "./share-card";

/**
 * Wires a share card to the API. Mutations invalidate queries; nothing is cached by hand.
 * Burn after download (Phase 3): a revealed text is returned to the card's own state and never
 * enters the query cache; a 410 means the share is gone for this device, so the lists refresh.
 */
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
    const onGone = (error: unknown) => {
      if (error instanceof ApiRequestError && (error.status === 410 || error.status === 404)) {
        queryClient.removeQueries({ queryKey: queryKeys.share(share.id) });
        refresh();
      }
      throw error;
    };
    return {
      download: async (file, options) => {
        if (!api) return;
        const { url } = await api
          .request("POST", `/api/v1/files/${file.id}/download-url`, {
            body: options?.confirm ? { confirm: true } : {},
            schema: downloadUrlResponse,
          })
          .catch(onGone);
        // A burn claim changes what this card shows (downloads left, the claim): refetch.
        if (share.burn) refresh();
        // Content-Disposition: attachment (signed at upload), so this downloads in place.
        window.location.assign(url);
      },
      reveal: async () => {
        if (!api) throw new Error("not ready");
        const result = await api
          .request("POST", `/api/v1/shares/${share.id}/reveal`, { body: { confirm: true }, schema: revealResponse })
          .catch(onGone);
        refresh();
        return { content: result.text.content, left: result.burn.left, availableUntil: result.burn.availableUntil };
      },
      confirmReceived: async () => {
        if (!api) return;
        await api.request("POST", `/api/v1/shares/${share.id}/confirm-received`, { body: {} }).catch(onGone);
        queryClient.removeQueries({ queryKey: queryKeys.share(share.id) });
        refresh();
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
  }, [runtime, queryClient, share.id, share.burn]);
}
