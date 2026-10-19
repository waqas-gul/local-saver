import "server-only";

/**
 * Filename sanitization (03 §7.2, T-023). Original names live only in Postgres; they never
 * appear in object keys or realtime payloads.
 */

// Control characters (C0, DEL, C1), zero-width characters, bidirectional marks, embeddings,
// overrides and isolates (used for "invoice<RLO>fdp.exe" spoofing), and the BOM.
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F؜​-‏‪-‮⁠-⁩﻿]/g;
const RESERVED_CHARS = /[/\\:*?"<>|]/g;
const WINDOWS_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const EXTENSION = /\.([A-Za-z0-9]{1,32})$/;
const MAX_BYTES = 255;

export type SanitizedFilename = { name: string; extension: string };

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateToBytes(value: string, maxBytes: number): string {
  let out = "";
  for (const char of value) {
    if (byteLength(out + char) > maxBytes) break;
    out += char;
  }
  return out;
}

export function sanitizeFilename(input: string): SanitizedFilename {
  let name = input
    .normalize("NFC")
    .replace(INVISIBLE, "")
    .replace(RESERVED_CHARS, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "");

  if (name === "") name = "file";
  if (WINDOWS_DEVICE_NAMES.test(name.split(".")[0] ?? "")) name = `_${name}`;

  const match = EXTENSION.exec(name);
  const extension = match?.[1]?.toLowerCase() ?? "";

  if (byteLength(name) > MAX_BYTES) {
    const suffix = match ? match[0] : "";
    const base = name.slice(0, name.length - suffix.length);
    name = truncateToBytes(base, MAX_BYTES - byteLength(suffix)) + suffix;
  }

  return { name, extension };
}
