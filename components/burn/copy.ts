/**
 * Burn-after-download copy (phase 3 §17.9), kept in one place (02 §8).
 *
 * DEFINED: three strings come from the docs and are used as written.
 * OWNER REVIEW: every other string is provisional, plain wording so the flows work and can be
 * tested. None is final: the owner reviews each one before release (AC-3.8, phase 3 §18).
 */

export const BURN = {
  // DEFINED (03 §5.4): the confirmation before a download or Reveal claims the share.
  confirmBody: "This will be deleted after you open it.",
  // DEFINED (03 §5.4): the button that reveals a burn text, which is the claim.
  reveal: "Reveal",
  // DEFINED (phase 3 §2, CR-001): under the composer when the destination is this network.
  networkLine: "The first person on this network to open it gets it",

  // OWNER REVIEW: the composer toggle.
  toggle: "Burn after download",
  // OWNER REVIEW: under the composer when the destination is Link only (not defined, §17.9).
  linkOnlyLine: "The first person who opens the link gets it",
  // OWNER REVIEW: the badge on a burn share.
  badge: "Burn after download",
  // OWNER REVIEW: confirmation dialog title and buttons.
  confirmTitle: "Open it now?",
  confirmDownload: "Download",
  cancel: "Cancel",
  // OWNER REVIEW: the grace-loss warning 03 §5.5 asks for, shown in the confirmation.
  graceWarning: "If your device fails before it's saved, it's gone.",
  // OWNER REVIEW: the claimant's state.
  availableUntil: (time: string) => `Yours until ${time}`,
  downloadsLeft: (n: number) => (n === 1 ? "1 download left" : `${n} downloads left`),
  revealsLeft: (n: number) => (n === 1 ? "1 view left" : `${n} views left`),
  gotIt: "I've got it",
  // OWNER REVIEW: the creator's view of a claimed share.
  openedBySomeone: (time: string) => `Opened. It will be deleted at ${time}.`,
  // OWNER REVIEW: "someone else already downloaded" (09 §8 scenario 8 names the state, not the words).
  downloadedByOther: "Someone else already downloaded this.",
  downloadedByYou: "You've already opened this. It's been deleted.",
  retryLimit: "You've used every download of this.",
  // OWNER REVIEW: in the share-link dialog, for burn shares (R3-4).
  linkWarning: "Opening this link yourself counts as the one download.",
} as const;

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** A burn error from the API, in the words above; null for anything else. */
export function burnErrorText(error: unknown): string | null {
  const e = error as { code?: string; details?: { byYou?: boolean } } | null;
  if (e?.code === "ALREADY_DOWNLOADED") return e.details?.byYou ? BURN.downloadedByYou : BURN.downloadedByOther;
  if (e?.code === "BURN_RETRY_LIMIT") return BURN.retryLimit;
  return null;
}
