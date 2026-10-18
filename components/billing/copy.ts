import { formatBytes } from "@/lib/shared/format";
import { EXPIRY_LABELS } from "@/lib/shared/plans";

/**
 * Plan copy: upgrade hints and the pricing page (phase 4 §17.6.5), kept in one place (02 §8).
 * Every string is OWNER REVIEW. Numbers come from lib/shared/plans.ts, never from here.
 */

const days = (seconds: number) => EXPIRY_LABELS[seconds] ?? `${Math.round(seconds / 86_400)} days`;

export const BILLING_COPY = {
  seePlans: "See plans",

  // Upgrade hints: what Pro would allow, from PRO_LIMITS as this build delivers it.
  hintTextSize: (maxBytes: number) => `Pro allows texts up to ${formatBytes(maxBytes)}.`,
  hintFileCount: (maxFiles: number) => `Pro allows up to ${maxFiles} files in one share.`,
  hintFileSize: (maxBytes: number) => `Pro allows files up to ${formatBytes(maxBytes)}.`,
  hintExpiry: (seconds: number) => `Pro lets shares and links last up to ${days(seconds)}.`,
  hintCodeExpiry: (seconds: number) => `Pro lets codes last up to ${days(seconds)}.`,
  hintStorage: (quotaBytes: number) => `Pro includes ${formatBytes(quotaBytes)} of storage.`,
  hintBurn: "Burn after download comes with Pro.",
  hintFeature: "This comes with Pro.",

  // The pricing page.
  pricingTitle: "Plans",
  pricingIntro: "Local sharing and links are free. Pro raises the limits.",
  free: "Free",
  pro: "Pro",
  freePrice: "Free",
  // Q-006: no prices until the owner sets them.
  pricePlaceholder: "[OWNER: price]",
  perMonth: (price: string) => `${price} a month`,
  perYear: (price: string) => `${price} a year`,
  needsAccount: "Pro needs an account.",
  rows: {
    maxFileBytes: "File size",
    maxFilesPerShare: "Files in one share",
    maxTextBytes: "Text size",
    activeStorageBytes: "Storage",
    dailyUploadBytes: "Uploads a day",
    expiry: "Shares last up to",
    linkExpiry: "Links last up to",
    codeExpiry: "Codes last up to",
    linkDownloads: "Downloads per link a day",
    devices: "Signed-in devices",
    burnAfterDownload: "Burn after download",
    extendExpiry: "Extend a share's expiry",
    linkPasswords: "Passwords on links",
    privateRooms: "Private rooms",
    customRoomNames: "Custom room names",
    multiUseInvites: "Invite links for rooms",
    roomLinks: "Read-only room links",
    transferHistory: "Transfer history",
  },
  included: "Included",
  notIncluded: "Not included",
  expiryValue: days,

  // Billing settings (phase 4 §17.7.6, §17.14). Dates come formatted from the caller.
  billingTitle: "Plan and billing",
  currentPlan: "Current plan",
  planNames: { free: "Free", pro: "Pro" } as Record<string, string>,
  sourceOverride: "Pro was added to your account by support.",
  renewsOn: (date: string) => `Renews on ${date}.`,
  endsOn: (date: string) => `Pro ends on ${date}. You can resume it before then.`,
  pastDue: (date: string) => `Your last payment failed. Update your payment method by ${date} to keep Pro.`,
  pausedOrEnded: "Your subscription isn't active.",
  subscribeMonthly: "Subscribe monthly",
  subscribeYearly: "Subscribe yearly",
  manageBilling: "Manage billing",
  manageHint: "Change your payment method, switch between monthly and yearly, cancel or see invoices.",
  anonymousBilling: "Pro needs an account. Sign in or create one first.",
  signIn: "Sign in",
  seePricing: "Compare plans",
  confirming: "Confirming your payment…",
  confirmingHint: "This page updates as soon as the payment provider confirms it.",
  confirmed: "You're on Pro. Thank you!",
  stillConfirming: "We're still confirming your payment. If you were charged, it will show here shortly; if not, contact support and mention your checkout reference.",
  errors: {
    notConfigured: "Payments aren't available yet.",
    alreadySubscribed: "This account already has a subscription. Use Manage billing to change it.",
    deletionPending: "This account is being deleted. Cancel the deletion to subscribe.",
    inProgress: "Your checkout is still being created. Try again in a moment.",
    provider: "The payment provider isn't answering. Try again later.",
    rateLimited: "Too many attempts. Try again later.",
    generic: "Something went wrong. Try again.",
  },
};
