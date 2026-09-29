import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDb } from "@/lib/server/db/client";
import { checkDatabase } from "@/lib/server/db/health";
import { resetEnvCache } from "@/lib/server/env";

describe("checkDatabase", () => {
  afterEach(async () => {
    await closeDb();
    resetEnvCache();
  });

  it("reports not_configured without DATABASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", "");
    resetEnvCache();
    await expect(checkDatabase()).resolves.toBe("not_configured");
  });

  it("reports error (and never throws) when the database is unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Port 1 on loopback refuses connections immediately.
    vi.stubEnv("DATABASE_URL", "postgresql://app_server:unused@127.0.0.1:1/postgres");
    resetEnvCache();
    await expect(checkDatabase()).resolves.toBe("error");
  });
});
