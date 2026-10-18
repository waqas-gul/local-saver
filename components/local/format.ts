/** Display formatting for sizes and times (plain functions, no locale data loaded). */

// Sizes are shared with lib/client (upload errors) and the pricing page since Phase 4B.
export { formatBytes } from "@/lib/shared/format";

export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function expiresIn(iso: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  if (seconds <= 0) return "Expired";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `Expires in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Expires in ${hours} h`;
  return `Expires in ${Math.round(hours / 24)} days`;
}
