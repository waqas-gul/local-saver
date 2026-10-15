"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { deviceResponse, type DeviceDto } from "@/lib/shared/api/schemas";
import { createApiClient, type ApiClient } from "./api-client";
import { usePublicConfig, type PublicConfig } from "./config";
import { SessionStore } from "./stores/session";
import { getSupabaseBrowserClient } from "./supabase";
import { getTurnstileToken } from "./turnstile";

/**
 * Browser runtime: the Supabase client, the API client and the bootstrap of this device
 * (02 §4.1): anonymous sign-in (with a Turnstile token when configured), then device
 * registration. Created after mount, in the browser only.
 */

export type Runtime = { supabase: SupabaseClient; api: ApiClient };

const RuntimeContext = createContext<Runtime | null>(null);
const DEVICE_KEY = "local-saver.device-id";

function readStoredDeviceId(): string | null {
  try {
    return window.localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;
  }
}

function storeDeviceId(id: string): void {
  try {
    window.localStorage.setItem(DEVICE_KEY, id);
  } catch {
    // private mode: the device is re-registered next time
  }
}

let bootstrapping: Promise<{ userId: string; device: DeviceDto }> | undefined;

/** Once per page load, even if React mounts twice in development. */
function bootstrap(runtime: Runtime, config: NonNullable<PublicConfig>) {
  bootstrapping ??= (async () => {
    const { supabase, api } = runtime;
    let session = (await supabase.auth.getSession()).data.session;
    if (!session) {
      const captchaToken = config.turnstileSiteKey ? await getTurnstileToken(config.turnstileSiteKey) : undefined;
      const { data, error } = await supabase.auth.signInAnonymously(captchaToken ? { options: { captchaToken } } : undefined);
      if (error || !data.session) throw new Error("Could not start a session");
      session = data.session;
    }
    const { device } = await api.request("POST", "/api/v1/devices", { body: {}, schema: deviceResponse });
    storeDeviceId(device.id);
    return { userId: session.user.id, device };
  })();
  bootstrapping.catch(() => {
    bootstrapping = undefined;
  });
  return bootstrapping;
}

function createRuntime(config: NonNullable<PublicConfig>, session: ReturnType<typeof SessionStore.useStoreApi>): Runtime {
  const supabase = getSupabaseBrowserClient(config);
  const api = createApiClient({
    auth: {
      getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
      refreshAccessToken: async () => (await supabase.auth.refreshSession()).data.session?.access_token ?? null,
    },
    getDeviceId: () => session.getState().device?.id ?? readStoredDeviceId(),
  });
  return { supabase, api };
}

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const config = usePublicConfig();
  const session = SessionStore.useStoreApi();
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
    bootstrap(runtime, config)
      .then(({ userId, device }) => !cancelled && session.getState().ready(userId, device))
      .catch(() => !cancelled && session.getState().fail("error", "We couldn't start the app. Check your connection and reload."));
    return () => {
      cancelled = true;
    };
  }, [config, runtime, session]);

  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

export function useRuntime(): Runtime | null {
  return useContext(RuntimeContext);
}
