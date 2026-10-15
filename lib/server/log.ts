import "server-only";

/**
 * Application logger (DEC-029): one JSON line per event, with redaction.
 * Redaction rules follow 03 §14. Kept instead of pino (phase 0 DV-7, phase 1 DV1-7).
 */

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACTED = "[REDACTED]";

const SENSITIVE_KEY =
  /secret|password|passwd|passcode|token|authorization|cookie|x-origin-auth|api[-_]?key|short[-_]?code|signature|pepper|private[-_]?key|nonce/i;
const MAX_DEPTH = 6;

function scrubString(value: string): string {
  return value
    .replace(/(X-Amz-(?:Signature|Credential|Security-Token)=)[^&\s#]*/gi, `$1${REDACTED}`)
    .replace(/(https?:\/\/[^\s#]*)#\S*/gi, `$1#${REDACTED}`);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (typeof value === "string") return scrubString(value);
  if (value instanceof Error) return { name: value.name, message: scrubString(value.message) };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

type Writer = (level: Level, line: string) => void;

export type Logger = Record<Level, (event: string, fields?: Record<string, unknown>) => void>;

const defaultWriter: Writer = (level, line) => {
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
};

export function createLogger(options: { level?: Level; write?: Writer } = {}): Logger {
  const threshold = ORDER[options.level ?? "info"];
  const write = options.write ?? defaultWriter;
  const emit = (level: Level) => (event: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[level] < threshold) return;
    const entry = { ts: new Date().toISOString(), level, event, ...(redact(fields) as object) };
    write(level, JSON.stringify(entry));
  };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

function levelFromEnv(): Level {
  const value = process.env.LOG_LEVEL;
  return value === "debug" || value === "info" || value === "warn" || value === "error" ? value : "info";
}

/** Process-wide logger. Reads LOG_LEVEL directly so logging works even when the env is invalid. */
export const log = createLogger({ level: levelFromEnv() });
