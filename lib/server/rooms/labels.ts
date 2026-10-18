import "server-only";
import { ApiError } from "../http/errors";
import { cleanLabel } from "../devices/labels";

/**
 * Room names (phase 4 §17.8.4). Without a custom name (Pro, E18), a room gets a generated one, like device labels
 * ("Calm Harbor"). A custom name is cleaned as display names are (NFC, no invisible or bidi characters, single
 * spaces) and must keep 1–60 characters; the database checks the same.
 */

const ADJECTIVES = [
  "Amber", "Bright", "Calm", "Cosy", "Crisp", "Gentle", "Golden", "Green", "Hidden", "Lively", "Lucky", "Mellow",
  "Misty", "Quiet", "Silver", "Sunny", "Snug", "Swift", "Velvet", "Warm",
];
const PLACES = [
  "Bay", "Brook", "Canyon", "Cove", "Dune", "Forest", "Garden", "Glade", "Grove", "Harbor", "Haven", "Island",
  "Lagoon", "Meadow", "Orchard", "Prairie", "Ridge", "Summit", "Valley", "Willow",
];

export const ROOM_NAME_MAX_LENGTH = 60;

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))] as T;
}

export function generateRoomLabel(random: () => number = Math.random): string {
  return `${pick(ADJECTIVES, random)} ${pick(PLACES, random)}`;
}

/** A custom room name as stored, or 400 when nothing is left after cleaning. Never logged. */
export function roomLabelFrom(name: string): string {
  const label = cleanLabel(name, ROOM_NAME_MAX_LENGTH);
  if (label === "") throw new ApiError(400, "VALIDATION_FAILED", "Request body failed validation", [{ path: "name", code: "too_small" }]);
  return label;
}
