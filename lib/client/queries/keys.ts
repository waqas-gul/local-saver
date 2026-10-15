/**
 * TanStack Query key contracts (DEC-034 rule 11, 02 §3.3). Every caller builds keys here.
 * Keys under "local", "share" and "preview" belong to the current network and are removed
 * when it changes (rule 3).
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
};

/** Query keys that hold content from the current network (removed on network change). */
export const NETWORK_SCOPED_KEYS = [queryKeys.local(), queryKeys.shares(), queryKeys.previews()];
