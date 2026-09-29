import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/db/health", () => ({ checkDatabase: vi.fn() }));

import { GET } from "@/app/api/v1/health/route";
import { checkDatabase } from "@/lib/server/db/health";
import { resetEnvCache } from "@/lib/server/env";

const check = vi.mocked(checkDatabase);

async function call(path: string) {
  const response = await GET(new Request(`http://localhost:3000${path}`), undefined);
  return { response, body: await response.json() };
}

describe("GET /api/v1/health", () => {
  afterEach(() => resetEnvCache());

  it("reports liveness without touching the database", async () => {
    const { response, body } = await call("/api/v1/health");
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "ok" });
    expect(body.checks).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("reports readiness including the database", async () => {
    check.mockResolvedValueOnce("ok");
    const { response, body } = await call("/api/v1/health?ready=1");
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "ok", checks: { database: "ok" } });
  });

  it("does not fail readiness when the database is not configured yet (Phase 0)", async () => {
    check.mockResolvedValueOnce("not_configured");
    const { response, body } = await call("/api/v1/health?ready=1");
    expect(response.status).toBe(200);
    expect(body.checks.database).toBe("not_configured");
  });

  it("returns 503 when a configured database is unreachable", async () => {
    check.mockResolvedValueOnce("error");
    const { response, body } = await call("/api/v1/health?ready=1");
    expect(response.status).toBe(503);
    expect(body).toMatchObject({ status: "degraded", checks: { database: "error" } });
  });

  it("exposes no configuration values", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://app_server:hunter2@db.example.com:5432/postgres");
    resetEnvCache();
    check.mockResolvedValueOnce("ok");
    const { body } = await call("/api/v1/health?ready=1");
    expect(JSON.stringify(body)).not.toMatch(/hunter2|db\.example\.com/);
  });
});
