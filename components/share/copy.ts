import type { ReportCategory } from "@/lib/shared/api/schemas";

/**
 * UI copy for remote sharing (Phase 2), kept in one place (02 §8). Like the Phase 1 copy, it
 * needs the owner's review before release.
 */

/** Under the composer when the destination is Link only (DEC-033). */
export const LINK_ONLY_AUDIENCE = "Not visible on any network. Only people you send the link, QR code or share code to can open it.";

/** Where the creator makes a link (03 §4.1). */
export const LINK_WARNING = "Anyone with this link can open this share until the link expires. You can turn the link off at any time.";

/** Next to the QR code (03 §4.3). */
export const QR_WARNING = "Anyone who scans this can open the share.";

export const CODE_HINT = "Share codes work at the code page on any device, until they expire.";

/** Files that may not leave the network on Free (Q-010, assumed). */
export const REMOTE_BLOCKED =
  "Programs, scripts, installers and disk images can't be shared by link. You can still post them to this network.";

/** Before a link viewer downloads an archive (03 §7.4). */
export const REMOTE_RISK_WARNING = {
  title: "Download this archive?",
  body: "Archives can contain programs. Only open it if you know who sent this link and trust them.",
  confirm: "Download anyway",
};

export const VIEWER_STATES = {
  incomplete: {
    title: "This link isn't complete",
    body: "The link may have been cut off when it was copied. Ask the sender for the full link, or enter a share code instead.",
  },
  unavailable: {
    title: "This link isn't available",
    body: "Check that you have the whole link, or ask the sender for a new one.",
  },
  expired: { title: "This link has ended", body: "It has expired, or the sender turned it off." },
  paused: { title: "Sharing by link is paused", body: "Please try again later." },
  limited: { title: "Too many attempts", body: "Wait a few minutes and try again." },
  failed: { title: "Something went wrong", body: "Check your connection and try again." },
} as const;

export const REPORT_CATEGORY_LABELS: Record<ReportCategory, string> = {
  malware: "Malware or a harmful file",
  phishing: "Phishing or a scam",
  illegal: "Illegal content",
  child_safety: "Child sexual abuse material",
  copyright: "Copyright infringement",
  harassment: "Harassment or threats",
  spam: "Spam",
  other: "Something else",
};
