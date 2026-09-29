import { describe, expect, it, vi } from "vitest";
import { createLogger, redact } from "@/lib/server/log";

describe("redact", () => {
  it("masks sensitive keys at any depth", () => {
    const out = redact({
      path: "/api/v1/health",
      headers: { authorization: "Bearer abc", cookie: "a=b", "x-origin-auth": "s", accept: "json" },
      nested: [{ password: "p", shortCode: "7KQ4M", ok: 1 }],
      linkSecret: "k",
      apiKey: "z",
    });
    expect(out).toEqual({
      path: "/api/v1/health",
      headers: { authorization: "[REDACTED]", cookie: "[REDACTED]", "x-origin-auth": "[REDACTED]", accept: "json" },
      nested: [{ password: "[REDACTED]", shortCode: "[REDACTED]", ok: 1 }],
      linkSecret: "[REDACTED]",
      apiKey: "[REDACTED]",
    });
  });

  it("strips URL fragments and presigned signatures from strings", () => {
    const out = redact({
      url: "https://app.example.com/s/abc#k=supersecret",
      presigned: "https://x.r2.cloudflarestorage.com/o?X-Amz-Date=1&X-Amz-Signature=deadbeef&x=1",
    }) as Record<string, string>;
    expect(out.url).toBe("https://app.example.com/s/abc#[REDACTED]");
    expect(out.presigned).not.toContain("deadbeef");
    expect(out.presigned).toContain("X-Amz-Signature=[REDACTED]");
  });

  it("serializes errors without their stack in production-style output", () => {
    const out = redact({ err: new Error("boom") }) as { err: { name: string; message: string } };
    expect(out.err).toMatchObject({ name: "Error", message: "boom" });
  });
});

describe("createLogger", () => {
  it("writes one JSON line per event and respects the level", () => {
    const write = vi.fn();
    const log = createLogger({ level: "info", write });
    log.debug("ignored");
    log.warn("origin_lock.rejected", { path: "/", secret: "x" });
    expect(write).toHaveBeenCalledTimes(1);
    const [level, line] = write.mock.calls[0]!;
    expect(level).toBe("warn");
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({ level: "warn", event: "origin_lock.rejected", path: "/", secret: "[REDACTED]" });
    expect(typeof parsed.ts).toBe("string");
  });
});
