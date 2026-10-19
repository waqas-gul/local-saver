import "server-only";
import { ApiError } from "../http/errors";
import type { RiskFlag } from "./file-risk";

/**
 * File policy by audience (03 §7.4, DEC-025, Q-010 assumed). One place decides which flagged
 * files may leave the network:
 *
 * - Local shares (everyone on the network): every file is allowed; flagged files carry a badge
 *   and need a confirmation before download (Phase 1, unchanged).
 * - Remote links on a plan without executablesInRemoteLinks (Free, every user in Phase 2):
 *   executables, scripts, installers (flagged executable) and disk images are blocked until
 *   malware scanning exists (Phase 6). Archives are allowed with a warning.
 */

const REMOTE_BLOCKED: readonly string[] = ["executable", "script", "disk_image"] satisfies RiskFlag[];
// A misleading name ("invoice.pdf.exe") only blocks together with a runnable extension, which
// already blocks; reported alongside it so the message can say why.
const REMOTE_BLOCKED_COMPANIONS: readonly string[] = ["double_extension"] satisfies RiskFlag[];

export type RemoteFilePolicy = { allowed: boolean; blockedFlags: string[]; warnings: string[] };

/** Entitlements, or a stored entitlement snapshot: anything without the feature is treated as Free. */
type PolicyEntitlements = { features?: { executablesInRemoteLinks?: boolean } };

export function remoteFilePolicy(flags: readonly string[], entitlements: PolicyEntitlements): RemoteFilePolicy {
  const blocking = flags.filter((f) => REMOTE_BLOCKED.includes(f));
  if (blocking.length > 0 && entitlements.features?.executablesInRemoteLinks !== true) {
    return {
      allowed: false,
      blockedFlags: flags.filter((f) => REMOTE_BLOCKED.includes(f) || REMOTE_BLOCKED_COMPANIONS.includes(f)),
      warnings: [],
    };
  }
  return { allowed: true, blockedFlags: [], warnings: [...flags] };
}

/** 422 REMOTE_FILE_BLOCKED unless every file may be shared remotely (T-035). */
export function assertRemoteAllowed(files: readonly { riskFlags: readonly string[] }[], entitlements: PolicyEntitlements): void {
  const blocked = new Set<string>();
  for (const file of files) for (const flag of remoteFilePolicy(file.riskFlags, entitlements).blockedFlags) blocked.add(flag);
  if (blocked.size > 0) {
    throw new ApiError(422, "REMOTE_FILE_BLOCKED", "Programs, scripts, installers and disk images can't be shared by link", {
      blockedFlags: [...blocked].sort(),
    });
  }
}
