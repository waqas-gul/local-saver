import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/server/env";
import { register } from "@/instrumentation";

describe("instrumentation register (boot-time validation, AC-0.10)", () => {
  afterEach(() => resetEnvCache());

  it("accepts a valid environment", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await expect(register()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits a production process that has ALLOW_TEST_CLIENT_IP set", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_TEST_CLIENT_IP", "1");
    resetEnvCache();
    await register();
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.mock.calls.flat().join("\n")).toMatch(/ALLOW_TEST_CLIENT_IP/);
  });

  it("does nothing outside the Node.js runtime", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_TEST_CLIENT_IP", "1");
    resetEnvCache();
    await register();
    expect(exit).not.toHaveBeenCalled();
  });
});
