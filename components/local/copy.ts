import type { NetworkStatus } from "@/lib/shared/api/schemas";

/**
 * UI copy for local mode, kept in one place (02 §8). The audience line, the first-visit
 * notice and the status texts need the owner's approval (AC-1.12).
 */

/** Stated where the user posts, before posting (DEC-033); shown only there. */
export const AUDIENCE = "Visible to everyone on this network";

/** The status bar on an ok network. */
export function networkLine(devicesHere: number): string {
  const devices = devicesHere === 1 ? "1 device" : `${devicesHere} devices`;
  return `This network · ${devices} here now`;
}

export const NOTICE = {
  title: "Everyone on this network can see what you post",
  body: "Anything you post here is visible to every device connected to the same Wi-Fi or network, including guests. They can see and download it until it expires. Don't post anything private.",
  confirm: "Got it",
};

/** The fallback where local mode is off (Phase 2): link-only posts, shared by link, QR code or code. */
const FALLBACK = "You can still share by link, QR code or share code: post as Link only below.";

export function statusCopy(status: NetworkStatus, reason: string | null): { title: string; body: string } | null {
  switch (status) {
    case "ok":
      return null;
    case "shared_egress":
    case "too_large":
      return {
        title: "Local sharing is off on this network",
        body: `It looks like a mobile, VPN, relay or very large shared network, where other people may share your internet address. ${FALLBACK}`,
      };
    case "blocked":
      return { title: "Local sharing is off on this network", body: `Local sharing has been turned off for this network. ${FALLBACK}` };
    case "unavailable":
      if (reason === "disabled") {
        return { title: "Local sharing is paused", body: `Local sharing is paused right now. ${FALLBACK}` };
      }
      if (reason === "classification_unavailable") {
        return { title: "Local sharing is paused", body: `Local sharing is paused while our network checks are being updated. ${FALLBACK}` };
      }
      return {
        title: "Local sharing is off",
        body: `We can't tell which network you're on right now, so local sharing is off. ${FALLBACK}`,
      };
  }
}

export const RISK_LABELS: Record<string, string> = {
  executable: "Program",
  script: "Script",
  archive: "Archive",
  double_extension: "Misleading name",
  disk_image: "Disk image",
};

export const RISK_WARNING = {
  title: "Download this file?",
  body: "Anyone on this network could have posted this. Only open it if you know who sent it and trust it.",
  confirm: "Download anyway",
};
