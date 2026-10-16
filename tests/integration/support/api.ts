import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { inject } from "vitest";

/** Helpers for API integration tests: simulated networks, devices and admin database access. */

export const stack = () => inject("stack");

/** Response bodies are asserted field by field, so tests read them loosely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export type ApiResponse<T = Json> = { status: number; headers: Headers; body: T; text: string };

export type ApiOptions = {
  token?: string;
  deviceId?: string;
  ip?: string | null;
  body?: unknown;
  /** Defaults to the app origin; null sends no Origin header. */
  origin?: string | null;
  headers?: Record<string, string>;
  rawBody?: string;
};

export async function api<T = Json>(method: string, path: string, options: ApiOptions = {}): Promise<ApiResponse<T>> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.deviceId) headers.set("x-device-id", options.deviceId);
  if (options.ip) headers.set("x-test-client-ip", options.ip);
  if (method !== "GET" && method !== "HEAD" && options.origin !== null) {
    headers.set("origin", options.origin ?? stack().origin);
  }
  let body: string | undefined = options.rawBody;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  const response = await fetch(`${stack().origin}${path}`, { method, headers, body });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, headers: response.headers, body: parsed as T, text };
}

/** A random IPv6 /64 per call, so repeated runs never share a network (no presence build-up). */
export function newNetwork() {
  const a = randomBytes(2).toString("hex");
  const b = randomBytes(2).toString("hex");
  let host = 0;
  return {
    prefix: `2001:db8:${a}:${b}::/64`,
    ip: () => `2001:db8:${a}:${b}::${(++host).toString(16)}`,
  };
}

export async function signInAnonymously(): Promise<{ userId: string; accessToken: string; client: SupabaseClient }> {
  const client = createClient(stack().supabaseUrl, stack().publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInAnonymously();
  if (error || !data.session || !data.user) throw new Error(`anonymous sign-in failed: ${error?.message}`);
  await client.realtime.setAuth(data.session.access_token);
  return { userId: data.user.id, accessToken: data.session.access_token, client };
}

export class Device {
  private constructor(
    readonly userId: string,
    readonly token: string,
    readonly deviceId: string,
    readonly label: string,
    public ip: string | null,
    /** The signed-in Supabase client, for Realtime tests. */
    readonly supabase: SupabaseClient,
  ) {}

  /** Anonymous sign-in, device registration and a first observe, like the app's bootstrap. */
  static async create(ip: string | null, options: { observe?: boolean } = {}): Promise<Device> {
    const session = await signInAnonymously();
    const registered = await api("POST", "/api/v1/devices", { token: session.accessToken, ip, body: {} });
    if (registered.status !== 200) throw new Error(`device registration failed: ${registered.status} ${registered.text}`);
    const device = new Device(
      session.userId,
      session.accessToken,
      registered.body.device.id,
      registered.body.device.label,
      ip,
      session.client,
    );
    if (options.observe !== false) await device.observe();
    return device;
  }

  call<T = Json>(method: string, path: string, body?: unknown, extra: Omit<ApiOptions, "token" | "deviceId" | "ip" | "body"> = {}) {
    return api<T>(method, path, { ...extra, token: this.token, deviceId: this.deviceId, ip: this.ip, body });
  }

  async observe() {
    const response = await this.call("POST", "/api/v1/network/observe", {});
    if (response.status !== 200) throw new Error(`observe failed: ${response.status} ${response.text}`);
    return response.body as { status: string; reason: string | null; spaceIds: string[]; devicesHere: number };
  }

  async moveTo(ip: string | null) {
    this.ip = ip;
    return this.observe();
  }

  async postText(
    content = `note ${randomBytes(4).toString("hex")}`,
    expiresIn?: number,
    destination: "network" | "link_only" = "network",
  ) {
    const response = await this.call("POST", "/api/v1/texts", { destination, content, ...(expiresIn ? { expiresIn } : {}) });
    if (response.status !== 201) throw new Error(`text post failed: ${response.status} ${response.text}`);
    return response.body.share as { id: string; scope: string; text: { content: string; version: number } };
  }

  /** A share link (creator only). Returns the link with its one-time URL and optional code. */
  async createLink(shareId: string, body: { expiresIn?: number; shortCode?: { expiresIn?: number } } = {}) {
    const response = await this.call("POST", `/api/v1/shares/${shareId}/links`, body);
    if (response.status !== 201) throw new Error(`link creation failed: ${response.status} ${response.text}`);
    const link = response.body.link as LinkCreated;
    return { ...link, secret: new URL(link.url).hash.replace(/^#k=/, "") };
  }

  async feedIds(): Promise<string[]> {
    const response = await this.call("GET", "/api/v1/local/shares");
    if (response.status !== 200) throw new Error(`feed failed: ${response.status} ${response.text}`);
    return (response.body.shares as { id: string }[]).map((s) => s.id);
  }

  async myShareIds(): Promise<string[]> {
    const response = await this.call("GET", "/api/v1/me/shares");
    if (response.status !== 200) throw new Error(`my uploads failed: ${response.status} ${response.text}`);
    return (response.body.shares as { id: string }[]).map((s) => s.id);
  }

  /** Init → PUT to storage → complete. Returns the completed share. */
  async uploadFile(
    name: string,
    bytes: Uint8Array,
    type = "application/octet-stream",
    declaredSize = bytes.length,
    destination: "network" | "link_only" = "network",
  ) {
    const init = await this.call("POST", "/api/v1/shares", {
      destination,
      files: [{ name, size: declaredSize, type }],
    });
    if (init.status !== 201) throw new Error(`upload init failed: ${init.status} ${init.text}`);
    const upload = init.body.uploads[0] as { fileId: string; url: string; headers: Record<string, string> };
    const put = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: Buffer.from(bytes) });
    if (!put.ok) throw new Error(`PUT failed: ${put.status}`);
    const complete = await this.call("POST", `/api/v1/shares/${init.body.share.id}/files/${upload.fileId}/complete`, {});
    return { init, upload, complete };
  }
}

export type LinkCreated = {
  id: string;
  url: string;
  createdAt: string;
  expiresAt: string;
  shortCode: { code: string; expiresAt: string } | null;
};

/**
 * A link viewer (Phase 2): a browser with no Supabase session, only the link-session cookie
 * the server sets. Its cookie jar holds exactly that cookie.
 */
export class Viewer {
  cookie: string | null = null;

  constructor(public ip: string | null = newNetwork().ip()) {}

  async call<T = Json>(method: string, path: string, body?: unknown, extra: Omit<ApiOptions, "ip" | "body"> = {}) {
    const headers: Record<string, string> = { ...extra.headers };
    if (this.cookie) headers.cookie = this.cookie;
    const response = await api<T>(method, path, { ...extra, headers, ip: this.ip, body });
    const set = response.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0] ?? null;
    return response;
  }

  unlock(linkId: string, secret: string) {
    return this.call("POST", `/api/v1/links/${linkId}/unlock`, { secret });
  }

  content(linkId: string) {
    return this.call("GET", `/api/v1/links/${linkId}/content`);
  }

  fileUrl(linkId: string, fileId: string, kind: "download-url" | "preview-url" = "download-url") {
    return this.call("POST", `/api/v1/links/${linkId}/files/${fileId}/${kind}`, {});
  }

  resolve(code: string, turnstileToken?: string) {
    return this.call("POST", "/api/v1/codes/resolve", { code, ...(turnstileToken ? { turnstileToken } : {}) });
  }
}

/** A Turnstile token the integration server's siteverify stand-in accepts once. */
export const turnstilePass = () => `pass-${randomBytes(8).toString("hex")}`;

let pool: pg.Pool | undefined;

/** Superuser connection for fixtures and assertions (never used by the app). */
export function adminDb(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: stack().adminDatabaseUrl, max: 4 });
  return pool;
}

export async function closeAdminDb() {
  await pool?.end();
  pool = undefined;
}

export async function setFlag(key: string, enabled: boolean) {
  await adminDb().query("update app.runtime_flags set enabled = $2 where key = $1", [key, enabled]);
}

export async function setLargeNetworkCap(value: number) {
  await adminDb().query(`update app.runtime_flags set value = jsonb_build_object('value', $1::int) where key = 'network_large_cap'`, [value]);
}

export const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from(Buffer.from("not really a png, but the magic bytes match")),
]);
