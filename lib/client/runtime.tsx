"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { deviceResponse, type DeviceDto } from "@/lib/shared/api/schemas";
import { clearMergeIntent, clearStoredDeviceId, readStoredDeviceId, storeDeviceId } from "./account-storage";
import { createApiClient, type ApiClient } from "./api-client";
import { ApiRequestError } from "./api-error";
import { usePublicConfig, type PublicConfig } from "./config";
import { redeemPendingMerge } from "./merge";
import { getQueryClient } from "./query-client";
import { PresenceStore, SessionStore } from "./stores/session";
import { getSupabaseBrowserClient, sessionIdOf } from "./supabase";
import { getTurnstileToken } from "./turnstile";

/**
 * Browser runtime: the Supabase client, the API client and the bootstrap of this device
 * (02 §4.1): anonymous sign-in (with a Turnstile token when configured), then device
 * registration. Created after mount, in the browser only.
 *
 * Phase 4 (§17.5.2): the browser may be an account. The bootstrap runs once per Auth session (not
 * once per page load): after a sign-in, sign-out or upgrade elsewhere in the app, the next mount or
 * the auth-state listener runs it again, and when the user changed it clears the query cache first,
 * so no data of one user is shown to the next. A merge still pending from the sign-in is retried
 * before registering. A revoked device is signed out (then starts again as a new anonymous user), and
 * so is a browser whose session Supabase Auth no longer has (P4-22: its account was deleted);
 * an account at its device cap gets the device_limit phase (only the device list works).
 *
 * P4-24: an account with an authenticator must confirm with it before the app loads. The server decides (403
 * MFA_REQUIRED at registration, or on any request while the app is open): the mfa phase shows the authenticator step,
 * which calls restartApp once this session is aal2. Supabase Auth ends an account's other sessions when it adds an
 * authenticator; such a session can't confirm any more, so the browser is signed out instead.
 */

export type Runtime = { supabase: SupabaseClient; api: ApiClient };

const RuntimeContext = createContext<Runtime | null>(null);

export const SIGNED_OUT_NOTICE = "This device was signed out.";

type Booted =
  | { kind: "ready"; sessionId: string | null; userId: string; anonymous: boolean; device: DeviceDto; notice: string | null }
  | { kind: "device_limit"; sessionId: string | null; userId: string }
  | { kind: "mfa_required"; sessionId: string | null; userId: string }
  | { kind: "suspended"; sessionId: string | null; userId: string };

let inflight: Promise<Booted> | undefined;
let lastBoot: Booted | undefined;
let lastUserId: string | null = null;
let pendingNotice: string | null = null;
let restartMounted: (() => void) | null = null;

/** Bootstrap again now (after a device was revoked to make room under the cap). */
export function restartApp(): void {
  restartMounted?.();
}

async function ensureSession(runtime: Runtime, config: NonNullable<PublicConfig>) {
  const { supabase } = runtime;
  const session = (await supabase.auth.getSession()).data.session;
  if (session) return session;
  const captchaToken = config.turnstileSiteKey ? await getTurnstileToken(config.turnstileSiteKey) : undefined;
  const { data, error } = await supabase.auth.signInAnonymously(captchaToken ? { options: { captchaToken } } : undefined);
  if (error || !data.session) throw new Error("Could not start a session");
  return data.session;
}

/**
 * After the API refused this browser's session (401 UNAUTHENTICATED even after a refresh): whether Supabase Auth
 * itself no longer has it. auth-js drops a session whose refresh token is refused once its access token has expired;
 * before that, Auth's /user answers that the token's user or session doesn't exist (P4-22: the account was deleted).
 * An outage answers neither, and isn't a sign-out.
 */
async function sessionGone(supabase: SupabaseClient): Promise<boolean> {
  if (!(await supabase.auth.getSession()).data.session) return true;
  const { error } = await supabase.auth.getUser();
  const code = (error as { code?: unknown } | null)?.code;
  return error?.name === "AuthSessionMissingError" || code === "user_not_found" || code === "session_not_found";
}

async function boot(runtime: Runtime, config: NonNullable<PublicConfig>, retried = false): Promise<Booted> {
  const session = await ensureSession(runtime, config);
  const sessionId = sessionIdOf(session.access_token);
  const userId = session.user.id;
  const anonymous = session.user.is_anonymous === true;
  if (lastUserId !== null && lastUserId !== userId) getQueryClient().clear();
  lastUserId = userId;

  if (!anonymous) {
    const merge = await redeemPendingMerge(runtime.api);
    if (merge?.kind === "device_limit") return { kind: "device_limit", sessionId, userId };
  }
  try {
    const { device } = await runtime.api.request("POST", "/api/v1/devices", { body: {}, schema: deviceResponse });
    storeDeviceId(device.id);
    const notice = pendingNotice;
    pendingNotice = null;
    return { kind: "ready", sessionId, userId, anonymous, device, notice };
  } catch (error) {
    if (error instanceof ApiRequestError) {
      if (error.code === "DEVICE_LIMIT") return { kind: "device_limit", sessionId, userId };
      if (error.code === "USER_SUSPENDED") return { kind: "suspended", sessionId, userId };
      if (error.code === "DEVICE_REVOKED" && !retried) {
        // Revoked from another device: this browser starts again as a new anonymous user.
        pendingNotice = SIGNED_OUT_NOTICE;
        await signOutLocally(runtime);
        return boot(runtime, config, true);
      }
      if (error.code === "UNAUTHENTICATED" && !retried && (await sessionGone(runtime.supabase))) {
        // The session is gone on the server (P4-22: the account was deleted): start again without it.
        pendingNotice = SIGNED_OUT_NOTICE;
        await signOutLocally(runtime);
        return boot(runtime, config, true);
      }
      if (error.code === "MFA_REQUIRED") {
        // P4-24: Auth ended this session when the account added an authenticator: it can't confirm, so start again.
        if (!retried && (await sessionGone(runtime.supabase))) {
          pendingNotice = SIGNED_OUT_NOTICE;
          await signOutLocally(runtime);
          return boot(runtime, config, true);
        }
        return { kind: "mfa_required", sessionId, userId };
      }
    }
    throw error;
  }
}

/** Once per Auth session, even if React mounts twice in development or the app remounts after /login. */
function bootstrap(runtime: Runtime, config: NonNullable<PublicConfig>): Promise<Booted> {
  inflight ??= (async () => {
    const current = sessionIdOf((await runtime.supabase.auth.getSession()).data.session?.access_token);
    if (lastBoot && current !== null && lastBoot.sessionId === current) return lastBoot;
    const booted = await boot(runtime, config);
    lastBoot = booted;
    return booted;
  })().finally(() => {
    inflight = undefined;
  });
  return inflight;
}

/** Forget this browser's account locally (the server side is the caller's job). */
async function signOutLocally(runtime: Runtime): Promise<void> {
  clearStoredDeviceId();
  clearMergeIntent();
  lastBoot = undefined;
  await runtime.supabase.auth.signOut({ scope: "local" });
}

/**
 * Sign out (§17.5.2): revoke this browser's device first, which also ends its Auth session on the
 * server, so it neither counts against the device cap nor keeps a refresh token. Then a new
 * anonymous session starts, as on a first visit.
 */
export async function signOut(runtime: Runtime, deviceId: string | null): Promise<void> {
  if (deviceId) {
    try {
      await runtime.api.request("DELETE", `/api/v1/me/devices/${deviceId}`);
    } catch {
      // Already revoked, or offline: the local sign-out below still happens.
    }
  }
  await signOutLocally(runtime);
}

let recovering: Promise<boolean> | undefined;

/**
 * Register again now, which rebinds this browser's device to its current session (C4-2). Used when
 * the server answers DEVICE_UNKNOWN: the same user got a new session (an upgrade, an email change)
 * and a request ran before the auth-state listener re-registered. One registration at a time.
 */
function recoverDevice(runtime: Runtime, session: ReturnType<typeof SessionStore.useStoreApi>): Promise<boolean> {
  recovering ??= (async () => {
    try {
      const { device } = await runtime.api.request("POST", "/api/v1/devices", { body: {}, schema: deviceResponse });
      storeDeviceId(device.id);
      session.getState().setDevice(device);
      return true;
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "UNAUTHENTICATED" && (await sessionGone(runtime.supabase))) {
        // The account was deleted while the app was open (P4-22): sign out here; the auth-state listener starts again.
        pendingNotice = SIGNED_OUT_NOTICE;
        await signOutLocally(runtime);
      }
      return false;
    }
  })().finally(() => {
    recovering = undefined;
  });
  return recovering;
}

function createRuntime(config: NonNullable<PublicConfig>, session: ReturnType<typeof SessionStore.useStoreApi>): Runtime {
  const supabase = getSupabaseBrowserClient(config);
  const runtime: Runtime = {
    supabase,
    api: createApiClient({
      auth: {
        getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
        refreshAccessToken: async () => (await supabase.auth.refreshSession()).data.session?.access_token ?? null,
      },
      getDeviceId: () => session.getState().device?.id ?? readStoredDeviceId(),
      onDeviceRevoked: () => {
        if (pendingNotice) return;
        pendingNotice = SIGNED_OUT_NOTICE;
        void signOutLocally(runtime);
      },
      recoverDevice: () => recoverDevice(runtime, session),
      // P4-24: an authenticator was added elsewhere while this app was open: bootstrap again, which shows its step.
      onMfaRequired: () => {
        if (session.getState().phase === "ready") restartApp();
      },
    }),
  };
  return runtime;
}

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const config = usePublicConfig();
  const session = SessionStore.useStoreApi();
  const presence = PresenceStore.useStoreApi();
  // Browser only: the server renders the "Connecting…" state with no runtime, and so does
  // the first client render until bootstrap finishes, so hydration matches.
  const [runtime] = useState<Runtime | null>(() =>
    typeof window === "undefined" || !config ? null : createRuntime(config, session),
  );

  useEffect(() => {
    if (!config || !runtime) {
      session.getState().fail("not_configured");
      return;
    }
    let cancelled = false;
    const run = () =>
      bootstrap(runtime, config)
        .then((booted) => {
          if (cancelled) return;
          if (booted.kind === "ready") session.getState().ready(booted.userId, booted.device, booted.anonymous, booted.notice);
          else if (booted.kind === "device_limit") session.getState().deviceLimit(booted.userId);
          else if (booted.kind === "mfa_required") session.getState().mfaRequired(booted.userId);
          else session.getState().fail("error", "This account is suspended.");
        })
        .catch(() => !cancelled && session.getState().fail("error", "We couldn't start the app. Check your connection and reload."));
    void run();
    const restart = () => {
      if (cancelled) return;
      lastBoot = undefined;
      presence.getState().reset();
      session.getState().reset();
      void run();
    };
    restartMounted = restart;
    // The same user in a new session (an upgrade or an email change issues one): only the device
    // binding must follow, so register again without resetting the page or its data.
    const rebind = () => {
      if (cancelled) return;
      lastBoot = undefined;
      void run();
    };

    // Another user or session in this browser (sign-in, sign-out, upgrade, revocation): start
    // again. Token refreshes keep the session, so they change nothing.
    const { data } = runtime.supabase.auth.onAuthStateChange((event, next) => {
      if (event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED") return;
      const nextId = sessionIdOf(next?.access_token);
      if (nextId !== null && lastBoot?.sessionId === nextId) return;
      const sameUser = event !== "SIGNED_OUT" && next?.user?.id !== undefined && next.user.id === lastBoot?.userId;
      // Supabase runs this callback inside its own lock: no Auth calls until it returns.
      setTimeout(sameUser ? rebind : restart, 0);
    });
    return () => {
      cancelled = true;
      if (restartMounted === restart) restartMounted = null;
      data.subscription.unsubscribe();
    };
  }, [config, runtime, session, presence]);

  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

export function useRuntime(): Runtime | null {
  return useContext(RuntimeContext);
}
