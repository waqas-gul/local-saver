import type { DownloadActorKind, DownloadEvent, ShareEndReason } from "@/lib/shared/api/schemas";

/**
 * Transfer history strings (phase 4 §17.14, P4-20). OWNER REVIEW: every string. History says what happened, never
 * who (D4-20): actor kinds only.
 */
export const HISTORY_COPY = {
  title: "Transfer history",
  link: "Transfer history",
  intro: (days: number) => `What you've shared over the last ${days} days and what happened to it. It says what, never who.`,
  introNoPlan: "What you've shared and what happened to it. It says what, never who.",
  notInPlan: "Transfer history comes with Pro.",
  unavailable: "Transfer history isn't available on your plan.",
  loadFailed: "Couldn't load your history. Try again in a moment.",
  loading: "Loading…",
  older: "Show older",
  tabs: { shares: "Shares", downloads: "Downloads" },
  statusLabel: "Show",
  status: { all: "All", active: "Active", ended: "Ended" },
  kindLabel: "Kind",
  kind: { all: "All", files: "Files", text: "Texts" },
  emptyShares: "Nothing shared in this period.",
  emptyDownloads: "Nothing has been downloaded in this period.",

  // A share.
  untitledText: "Text",
  untitledFiles: "Files",
  untitledRoom: "a room",
  scope: { network: "On a network", link_only: "Link only", room: (label: string) => `In ${label}` },
  files: (count: number) => (count === 1 ? "1 file" : `${count} files`),
  uploading: "Uploading",
  availableUntil: (date: string) => `Available until ${date}`,
  available: "Available",
  claimed: "Downloaded, burn after download",
  ended: {
    expired: (date: string) => `Expired ${date}`,
    consumed: (date: string) => `Downloaded and gone ${date} (burn after download)`,
    deleted_by_creator: (date: string) => `Deleted by you ${date}`,
    deleted_by_owner: (date: string) => `Removed by the room's owner ${date}`,
    blocked: (date: string) => `Taken down ${date}`,
    upload_failed: () => "The upload didn't finish",
    room_deleted: (date: string) => `Ended when its room was deleted ${date}`,
    account_deleted: (date: string) => `Ended with the account ${date}`,
  } satisfies Record<ShareEndReason, (date: string) => string>,
  showDownloads: "Downloads",

  // A download record.
  event: {
    url_issued: "Download",
    preview_issued: "Preview",
    burn_claimed: "Download (burn after download)",
    burn_retry: "Download again (burn after download)",
    text_revealed: "Text revealed",
  } satisfies Record<DownloadEvent, string>,
  actor: {
    creator: "You",
    network_device: "Someone on the network",
    room_member: "A room member",
    link_viewer: "Someone with a link",
  } satisfies Record<DownloadActorKind, string>,
  viaShareLink: "Someone with a share link",
  viaRoomLink: "Someone with the room's read-only link",
  yourLink: (id: string) => `Your link ${id}`,
  oneShare: "Downloads of one share",
  allDownloads: "Show all downloads",
} as const;
