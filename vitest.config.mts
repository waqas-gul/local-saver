import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Forward slashes so the alias also works on Windows.
const root = fileURLToPath(new URL(".", import.meta.url)).replace(/\\/g, "/");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@\//, replacement: root },
      // `server-only` throws outside the React Server Components build.
      // Tests import server modules directly, so it becomes a no-op here.
      { find: /^server-only$/, replacement: `${root}tests/stubs/server-only.ts` },
    ],
  },
  test: {
    // Keep secrets and developer .env files out of test runs.
    env: { APP_ENV: "test" },
    restoreMocks: true,
    unstubEnvs: true,
    coverage: {
      provider: "v8",
      include: ["lib/**", "components/**", "proxy.ts", "app/**/route.ts"],
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "component",
          environment: "jsdom",
          include: ["tests/component/**/*.test.tsx"],
          setupFiles: ["tests/component/setup.ts"],
        },
      },
      {
        // API integration against a real `next start` server and the local stack (DV1-12).
        // Needs `pnpm build` and `pnpm stack:start` first.
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/integration/support/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
