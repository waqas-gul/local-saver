import { queryOptions } from "@tanstack/react-query";
import { inviteListResponse, linkListResponse, roomListResponse, roomMembersResponse, roomResponse, shareListResponse } from "@/lib/shared/api/schemas";
import type { ApiClient } from "../api-client";
import { queryKeys } from "./keys";

/**
 * Private rooms (phase 4 §17.14, P4-17). Server state only: Realtime on room:{id} invalidates these, and a 404 means
 * the caller is no longer in the room (the page then removes everything under ["room", id]). Nothing is persisted.
 */

function ready(api: ApiClient | null): ApiClient {
  if (!api) throw new Error("API client not ready");
  return api;
}

export const roomsQuery = (api: ApiClient | null) =>
  queryOptions({
    queryKey: queryKeys.rooms(),
    queryFn: () => ready(api).request("GET", "/api/v1/rooms", { schema: roomListResponse }),
    enabled: api !== null,
  });

export const roomQuery = (api: ApiClient | null, roomId: string) =>
  queryOptions({
    queryKey: queryKeys.room(roomId),
    queryFn: async () => (await ready(api).request("GET", `/api/v1/rooms/${roomId}`, { schema: roomResponse })).room,
    enabled: api !== null,
  });

export const roomSharesQuery = (api: ApiClient | null, roomId: string, enabled = true) =>
  queryOptions({
    queryKey: queryKeys.roomShares(roomId),
    queryFn: () => ready(api).request("GET", `/api/v1/rooms/${roomId}/shares`, { schema: shareListResponse }),
    enabled: api !== null && enabled,
  });

export const roomMembersQuery = (api: ApiClient | null, roomId: string, enabled = true) =>
  queryOptions({
    queryKey: queryKeys.roomMembers(roomId),
    queryFn: async () => (await ready(api).request("GET", `/api/v1/rooms/${roomId}/members`, { schema: roomMembersResponse })).members,
    enabled: api !== null && enabled,
  });

/**
 * The owner's open invites, links and QR pairing codes (never their secrets: a new invite's URL lives only in its
 * dialog's state). A pairing code leaves this list when it is used, revoked or expires.
 */
export const roomInvitesQuery = (api: ApiClient | null, roomId: string, enabled = true) =>
  queryOptions({
    queryKey: queryKeys.roomInvites(roomId),
    queryFn: async () => (await ready(api).request("GET", `/api/v1/rooms/${roomId}/invites`, { schema: inviteListResponse })).invites,
    enabled: api !== null && enabled,
  });

/** P4-19: the owner's read-only room links: state and expiry only, never a secret or URL. */
export const roomLinksQuery = (api: ApiClient | null, roomId: string, enabled = true) =>
  queryOptions({
    queryKey: queryKeys.roomLinks(roomId),
    queryFn: async () => (await ready(api).request("GET", `/api/v1/rooms/${roomId}/links`, { schema: linkListResponse })).links,
    enabled: api !== null && enabled,
  });
