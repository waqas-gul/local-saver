import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { uploadHeaders } from "@/lib/server/shares/create";
import { retentionClassFor } from "@/lib/server/storage/keys";
import { FREE_LIMITS } from "@/lib/shared/plans";

/**
 * The R2 configuration in infra/r2 (applied per 08 §6) must match the code. This checks the
 * files only; that R2 applies them is staging evidence (AC-1.8, SP-02).
 */

const read = (name: string) => JSON.parse(readFileSync(`infra/r2/${name}`, "utf8"));
const DAY = 86_400;

describe("lifecycle backstop (infra/r2/lifecycle.json, 04 §8.2)", () => {
  const rules: { ID: string; Status: string; Filter: { Prefix: string }; Expiration?: { Days: number }; AbortIncompleteMultipartUpload?: { DaysAfterInitiation: number } }[] =
    read("lifecycle.json").Rules;
  const expiring = rules.filter((r) => r.Status === "Enabled" && r.Expiration);

  it("has one backstop per retention class, outliving the longest share it holds", () => {
    for (const [prefix, longest] of [["d7/", 7 * DAY], ["d30/", 30 * DAY], ["d90/", 90 * DAY]] as const) {
      const rule = expiring.find((r) => r.Filter.Prefix === prefix);
      expect(rule, prefix).toBeDefined();
      expect(rule!.Expiration!.Days * DAY).toBeGreaterThan(longest);
      expect(`${retentionClassFor(longest)}/`).toBe(prefix);
    }
  });

  it("covers every Free expiry option with a class that has a backstop", () => {
    for (const seconds of FREE_LIMITS.localExpiryOptionsSeconds) {
      expect(expiring.some((r) => r.Filter.Prefix === `${retentionClassFor(seconds)}/`)).toBe(true);
    }
  });

  it("never expires workspace objects or the whole bucket", () => {
    expect(expiring.map((r) => r.Filter.Prefix).sort()).toEqual(["d30/", "d7/", "d90/"]);
    expect(rules.find((r) => r.AbortIncompleteMultipartUpload)?.AbortIncompleteMultipartUpload?.DaysAfterInitiation).toBe(1);
  });
});

describe("bucket CORS (infra/r2/cors.*.json, 08 §6)", () => {
  for (const file of ["cors.staging.json", "cors.production.json"]) {
    it(`${file} allows exactly the signed upload headers, safe methods and https origins`, () => {
      const [rule] = read(file).CORSRules;
      const signed = Object.keys(uploadHeaders("a.txt", "text/plain")).sort();
      expect([...rule.AllowedHeaders].sort()).toEqual(signed);
      expect([...rule.AllowedMethods].sort()).toEqual(["GET", "HEAD", "PUT"]);
      for (const origin of rule.AllowedOrigins) expect(origin).toMatch(/^https:\/\/[^*]+$/);
    });
  }
});
