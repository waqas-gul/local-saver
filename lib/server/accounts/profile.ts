import "server-only";
import { sql } from "kysely";
import type { MeResponse } from "@/lib/shared/api/schemas";
import { audit } from "../audit/log";
import type { Caller } from "../auth/device";
import { assertAccount, mfaEnrolled } from "../auth/session";
import { getDb } from "../db/client";
import { cleanLabel } from "../devices/labels";
import { resolveEntitlements } from "../entitlements/resolve";
import { ApiError } from "../http/errors";
import { enforceRateLimit } from "../ratelimit/limits";

/**
 * The caller's account (§17.5.5): GET /me and PATCH /me/profile. A permanent user's profile is
 * created on first sight (app.ensure_profile). Email changes go through Supabase Auth itself
 * (updateUser, confirmed on both addresses); the app only shows the result.
 */

/** "s•••@example.com": enough to recognise, not to read off a screen. */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  return `${email[0]}•••${email.slice(at)}`;
}

type ProfileRow = { user_id: string | null; display_name: string | null; deletion_scheduled_for: Date | null };

async function ensureProfile(userId: string): Promise<ProfileRow | null> {
  const { rows } = await sql<ProfileRow>`
    select p.user_id, p.display_name, p.deletion_scheduled_for from app.ensure_profile(${userId}::uuid) p
  `.execute(getDb());
  return rows[0]?.user_id ? rows[0] : null;
}

async function describe(caller: Caller, profile: ProfileRow | null): Promise<MeResponse> {
  const { principal } = caller;
  return {
    user: {
      id: principal.userId,
      anonymous: principal.isAnonymous,
      email: maskEmail(principal.email),
      displayName: profile?.display_name ?? null,
    },
    methods: principal.providers,
    mfa: { enrolled: await mfaEnrolled(principal.userId), aal: principal.aal },
    plan: (await resolveEntitlements(principal)).plan,
    deletion: profile?.deletion_scheduled_for ? { scheduledFor: new Date(profile.deletion_scheduled_for).toISOString() } : null,
  };
}

export async function getMe(caller: Caller): Promise<MeResponse> {
  await enforceRateLimit("me", caller.device.id);
  const profile = caller.principal.isAnonymous ? null : await ensureProfile(caller.principal.userId);
  return describe(caller, profile);
}

export async function updateProfile(caller: Caller, displayName: string | null): Promise<MeResponse> {
  assertAccount(caller.principal);
  const cleaned = displayName === null ? null : cleanLabel(displayName, 60);
  if (cleaned === "") {
    throw new ApiError(400, "VALIDATION_FAILED", "Request body failed validation", [{ path: "displayName", code: "too_small" }]);
  }
  await enforceRateLimit("updateProfile", caller.principal.userId);
  const profile = await ensureProfile(caller.principal.userId);
  if (!profile) throw new ApiError(403, "ACCOUNT_REQUIRED", "Sign in to an account first");
  const db = getDb();
  const updated = await db
    .updateTable("app.profiles")
    .set({ display_name: cleaned, updated_at: sql`now()` })
    .where("user_id", "=", caller.principal.userId)
    .returning(["user_id", "display_name", "deletion_scheduled_for"])
    .executeTakeFirstOrThrow();
  await audit(db, {
    action: "profile.updated",
    actorUserId: caller.principal.userId,
    actorDeviceId: caller.device.id,
    networkSpaceId: null,
    targetType: "user",
    targetId: caller.principal.userId,
    // Never the value itself.
    metadata: { displayName: cleaned === null ? "removed" : "set" },
  });
  return describe(caller, updated);
}
