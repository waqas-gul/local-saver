import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileAuthorized } from "@/lib/server/billing/reconcile";
import { resetEnvCache } from "@/lib/server/env";
import { ApiError } from "@/lib/server/http/errors";
import { withWebhook } from "@/lib/server/http/webhook";
import { isRequestId } from "@/lib/server/security/ids";

/**
 * The billing trust boundaries (phase 4 §17.7.2, §17.7.5, §17.22): the webhook pipeline is only for
 * the provider and the internal reconcile route; only the sync module writes subscription state; only
 * the billing module talks to a provider adapter.
 */

const ROOT = process.cwd();

function files(dir: string, test: (path: string) => boolean): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...files(full, test));
    else if (test(full)) found.push(relative(ROOT, full).split(sep).join("/"));
  }
  return found;
}

const sources = [...files(join(ROOT, "app"), (p) => /\.tsx?$/.test(p)), ...files(join(ROOT, "lib"), (p) => /\.tsx?$/.test(p)), ...files(join(ROOT, "components"), (p) => /\.tsx?$/.test(p))];

describe("withWebhook", () => {
  afterEach(() => resetEnvCache());

  it("needs no Origin or JSON content type: the route authenticates its caller itself", async () => {
    const handler = withWebhook(async ({ request }) => ({ length: (await request.text()).length }));
    const response = await handler(new Request("http://localhost:3000/api/v1/billing/webhook", { method: "POST", body: "raw=bytes" }), undefined);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ length: 9 });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(isRequestId(response.headers.get("x-request-id") ?? "")).toBe(true);
  });

  it("answers errors with the standard body, and unexpected ones without details", async () => {
    const refused = withWebhook(async () => {
      throw new ApiError(400, "WEBHOOK_SIGNATURE_INVALID", "Webhook signature is invalid");
    });
    const bad = await refused(new Request("http://localhost:3000/x", { method: "POST" }), undefined);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatchObject({ code: "WEBHOOK_SIGNATURE_INVALID" });
    const crashing = withWebhook(async () => {
      throw new Error("secret detail");
    });
    const failed = await crashing(new Request("http://localhost:3000/x", { method: "POST" }), undefined);
    expect(failed.status).toBe(500);
    const text = await failed.text();
    expect(text).toContain("INTERNAL_ERROR");
    expect(text).not.toContain("secret detail");
  });

  it("is used by exactly the provider's webhook and the internal reconcile route, which don't use withApi", () => {
    const routes = files(join(ROOT, "app", "api"), (p) => p.endsWith("route.ts"));
    const webhookRoutes = routes.filter((r) => /=\s*withWebhook\b/.test(readFileSync(join(ROOT, r), "utf8")));
    expect(webhookRoutes.sort()).toEqual(["app/api/v1/billing/webhook/route.ts", "app/api/v1/internal/billing/reconcile/route.ts"]);
    for (const route of routes) {
      const source = readFileSync(join(ROOT, route), "utf8");
      const usesApi = /=\s*withApi\b/.test(source);
      expect(usesApi !== webhookRoutes.includes(route), `${route} uses exactly one wrapper`).toBe(true);
    }
  });
});

describe("billing authority", () => {
  it("only the sync module writes subscription state (apply_subscription_state)", () => {
    const callers = sources.filter((p) => readFileSync(join(ROOT, p), "utf8").includes("apply_subscription_state"));
    expect(callers).toEqual(["lib/server/billing/sync.ts"]);
  });

  it("only the billing module reaches a provider adapter", () => {
    const imports = /from\s+["'][^"']*\/providers\/[^"']*["']/;
    const importers = sources.filter((p) => imports.test(readFileSync(join(ROOT, p), "utf8")) && !p.startsWith("lib/server/billing/providers/"));
    expect(importers).toEqual(["lib/server/billing/provider.ts"]);
  });

  it("no browser code imports the billing server modules", () => {
    const client = sources.filter((p) => p.startsWith("components/") || p.startsWith("lib/client/") || p.startsWith("lib/shared/"));
    expect(client.filter((p) => /lib\/server\/billing/.test(readFileSync(join(ROOT, p), "utf8")))).toEqual([]);
  });
});

describe("reconcileAuthorized", () => {
  const CURRENT = "billing-reconcile-secret-long-enough-000000001";
  const PREVIOUS = "billing-reconcile-secret-long-enough-000000000";

  it("accepts the current and the previous bearer secret", () => {
    expect(reconcileAuthorized(`Bearer ${CURRENT}`, [CURRENT, PREVIOUS])).toBe(true);
    expect(reconcileAuthorized(`Bearer ${PREVIOUS}`, [CURRENT, PREVIOUS])).toBe(true);
  });

  it("refuses anything else, including a session token and an unconfigured route", () => {
    for (const header of [null, "", CURRENT, `Basic ${CURRENT}`, `Bearer ${CURRENT}x`, "Bearer eyJhbGciOiJFUzI1NiJ9.e30.sig", "Bearer "]) {
      expect(reconcileAuthorized(header, [CURRENT, PREVIOUS]), String(header)).toBe(false);
    }
    expect(reconcileAuthorized(`Bearer ${CURRENT}`, [])).toBe(false);
  });
});
