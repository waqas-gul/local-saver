/**
 * TanStack Query key contracts (DEC-034 rule 11, 02 §3.3). Every caller builds keys here.
 * Keys under "local", "share" and "preview" belong to the current network and are removed
 * when it changes (rule 3). The creator's own links ("me") and a link viewer's content ("link")
 * don't depend on the network.
 */
export const queryKeys = {
  network: () => ["network", "current"] as const,
  local: () => ["local"] as const,
  localFeed: (spaceIds: readonly string[]) => ["local", "feed", [...spaceIds].sort()] as const,
  shares: () => ["share"] as const,
  share: (shareId: string) => ["share", shareId] as const,
  previews: () => ["preview"] as const,
  preview: (fileId: string) => ["preview", fileId] as const,
  myShares: () => ["me", "shares"] as const,
  /** Phase 3: what this device may use (burn after download); not network-scoped. */
  entitlements: () => ["me", "entitlements"] as const,
  /** Phase 4A: this browser's user (GET /me) and the account's devices. */
  account: () => ["me", "account"] as const,
  devices: () => ["me", "devices"] as const,
  /** Phase 2: the creator's links for one share (never their secrets). */
  shareLinks: (shareId: string) => ["me", "links", shareId] as const,
  /** Phase 2: everything a link viewer holds for one link (removed on 404/410, rule 4). */
  link: (linkId: string) => ["link", linkId] as const,
  linkContent: (linkId: string) => ["link", linkId, "content"] as const,
  linkPreview: (linkId: string, fileId: string) => ["link", linkId, "preview", fileId] as const,
  /**
   * Phase 4 (P4-17): private rooms, from any network, so never removed on a network change. Everything under
   * ["room", id] goes when the caller leaves the room or is removed (membership.changed, or a 404).
   */
  rooms: () => ["rooms"] as const,
  roomsAll: () => ["room"] as const,
  room: (roomId: string) => ["room", roomId] as const,
  roomShares: (roomId: string) => ["room", roomId, "shares"] as const,
  roomMembers: (roomId: string) => ["room", roomId, "members"] as const,
  roomInvites: (roomId: string) => ["room", roomId, "invites"] as const,
  /** P4-19: the owner's read-only links to the room (never their secrets). */
  roomLinks: (roomId: string) => ["room", roomId, "links"] as const,
  /** P4-20: the caller's transfer history (Pro), by the page's URL filters; from any network. */
  history: () => ["history"] as const,
  historyShares: (filters: { status: string | null; kind: string | null }) => ["history", "shares", filters] as const,
  historyDownloads: (filters: { shareId: string | null }) => ["history", "downloads", filters] as const,
};

/** Query keys that hold content from the current network (removed on network change). */
export const NETWORK_SCOPED_KEYS = [queryKeys.local(), queryKeys.shares(), queryKeys.previews()];
