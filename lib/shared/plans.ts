/**
 * Free plan numbers (07 §1). Isomorphic: the UI uses them as hints, the server enforces them
 * through lib/server/entitlements/plans.ts. Values marked (assumed) are the documented
 * recommendations for open questions Q-007 and Q-030 (phase 1 §17.2) and Q-027 (phase 2 §17.2).
 */

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;
const MINUTE = 60;
const HOUR = 3600;
const DAY = 24 * HOUR;

export const FREE_LIMITS = {
  maxFileBytes: 100 * MB,
  maxFilesPerShare: 20, // (assumed) Q-007
  maxTextBytes: 100 * KB, // (assumed) Q-007
  activeStorageBytes: 2 * GB, // (assumed) Q-007
  dailyUploadBytes: 2 * GB, // (assumed) Q-007
  dailyUploadBytesPerNetwork: 10 * GB, // (assumed) Q-007
  localExpiryOptionsSeconds: [HOUR, DAY, 7 * DAY], // (assumed) Q-030
  localDefaultExpirySeconds: DAY, // (assumed) Q-030
  maxPreviewBytes: 20 * MB, // 03 §6
  historyRetentionDays: 30, // tombstones only; Free has no history (07 §1)
  // Remote links (Phase 2). A link never outlives its share; omitted, it lasts as long as the share.
  linkExpiryOptionsSeconds: [HOUR, DAY, 7 * DAY],
  shortCodeExpiryOptionsSeconds: [10 * MINUTE, HOUR, DAY], // DEC-014: Free codes ≤ 24 h
  shortCodeDefaultExpirySeconds: HOUR,
  shortCodeMaxTtlSeconds: DAY,
  linkDailyUrlIssuances: 500, // (assumed) Q-027: download and preview URLs per link per day
} as const;

export const EXPIRY_LABELS: Record<number, string> = {
  [10 * MINUTE]: "10 minutes",
  [HOUR]: "1 hour",
  [DAY]: "24 hours",
  [7 * DAY]: "7 days",
};
