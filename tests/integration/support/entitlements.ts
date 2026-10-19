import { createAccount, signInByCode } from "./accounts";
import { adminDb, Device, newNetwork } from "./api";

/**
 * Plan fixtures for Phase 4B (§17.19 "Pro.grant"). Pro comes from rows only an operator or billing
 * writes, so tests write them as the database superuser: an override through the operator function
 * (as support would), or a subscription row (as billing will, 4C).
 */

export const KIB = 1024;
export const MIB = 1024 * KIB;
export const GIB = 1024 * MIB;
export const DAY = 86_400;

/** A permanent account and one signed-in browser of it, registered and observed on `ip`. */
export async function accountDevice(ip: string | null = newNetwork().ip(), options: { observe?: boolean } = {}) {
  const account = await createAccount();
  const device = await Device.attach(await signInByCode(account.email), ip, options);
  return { ...account, device };
}

/** An operator override (app.admin_grant_override); returns its ID. Pro by default. */
export async function grantOverride(userId: string, key = "plan", value: unknown = "pro", expiresAt: Date | null = null): Promise<string> {
  const { rows } = await adminDb().query("select app.admin_grant_override($1, $2, $3::jsonb, 'integration test', 'tests', $4) as id", [
    userId,
    key,
    JSON.stringify(value),
    expiresAt,
  ]);
  return rows[0].id as string;
}

export async function revokeOverride(id: string): Promise<void> {
  await adminDb().query("select app.admin_revoke_override($1, 'integration test', 'tests')", [id]);
}

/** A Pro account by override, with one browser. `downgrade()` revokes the override (Pro → Free). */
export async function proDevice(ip: string | null = newNetwork().ip()) {
  const account = await accountDevice(ip);
  const overrideId = await grantOverride(account.userId);
  return { ...account, overrideId, downgrade: () => revokeOverride(overrideId) };
}

/** A subscription row as billing will write it (4C). Times are relative to the database's clock. */
export async function subscribe(
  userId: string,
  status: string,
  options: { periodEndSeconds?: number | null; graceSeconds?: number | null; cancelAtPeriodEnd?: boolean } = {},
): Promise<void> {
  await adminDb().query(
    `insert into app.subscriptions (provider, provider_subscription_id, provider_customer_id, subject_type, subject_id, plan,
                                    billing_interval, status, current_period_end, cancel_at_period_end, grace_until, provider_updated_at)
     values ('fake', gen_random_uuid()::text, 'cus_test', 'user', $1, 'pro', 'month', $2,
             case when $3::int is null then null else now() + make_interval(secs => $3::int) end, $5,
             case when $4::int is null then null else now() + make_interval(secs => $4::int) end, now())`,
    [userId, status, options.periodEndSeconds === undefined ? 30 * DAY : options.periodEndSeconds, options.graceSeconds ?? null, options.cancelAtPeriodEnd ?? false],
  );
}

/** Set a fixed-window counter for the current window, as earlier requests would have. */
export async function setCounter(key: string, window: string, value: number): Promise<void> {
  await adminDb().query(
    `insert into app.rate_counters (key, window_start, value, expires_at)
     values ($1, date_bin($2::interval, now(), timestamptz '2000-01-01 00:00:00+00'), $3,
             date_bin($2::interval, now(), timestamptz '2000-01-01 00:00:00+00') + $2::interval)
     on conflict (key, window_start) do update set value = excluded.value`,
    [key, window, value],
  );
}

export async function counter(key: string, window: string): Promise<number> {
  const { rows } = await adminDb().query(
    "select value from app.rate_counters where key = $1 and window_start = date_bin($2::interval, now(), timestamptz '2000-01-01 00:00:00+00')",
    [key, window],
  );
  return Number(rows[0]?.value ?? 0);
}

/** Pretend the user already stores `bytes` (committed), as Phase 1 tests do for the quota. */
export async function setStorageUsed(userId: string, bytes: number): Promise<void> {
  await adminDb().query(
    `insert into app.storage_usage (subject_type, subject_id, bytes_committed, files_committed) values ('user', $1, $2, 1)
     on conflict (subject_type, subject_id) do update set bytes_committed = excluded.bytes_committed`,
    [userId, bytes],
  );
}

export function fileInit(files: { name?: string; size: number; type?: string }[], extra: Record<string, unknown> = {}) {
  return {
    destination: "network",
    ...extra,
    files: files.map((f, i) => ({ name: f.name ?? `f${i}.bin`, size: f.size, type: f.type ?? "application/octet-stream" })),
  };
}
