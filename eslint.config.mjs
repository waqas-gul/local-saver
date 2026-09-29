import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Server-only code (secrets, database, authorization) must never reach the browser.
  // Every lib/server module also imports "server-only", which fails the build if a
  // client component imports it; this rule catches it earlier, in the editor.
  {
    files: ["lib/client/**", "lib/shared/**", "components/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/server", "@/lib/server/*", "**/lib/server/*"],
              message: "lib/server is server-only. Call it through an API route instead.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated and tool output:
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "lib/server/db/types.gen.ts",
  ]),
]);

export default eslintConfig;
