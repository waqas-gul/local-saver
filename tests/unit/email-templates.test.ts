import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCOUNT_COPY } from "@/components/account/copy";

/**
 * Supabase Auth's emails (phase 4 §17.5.8, P4-23): the templates in supabase/templates and how
 * supabase/config.toml uses them. The same files go to staging and production (infra/email/README.md),
 * so what is checked here is what every environment sends. Delivery itself: tests/integration/email.test.ts.
 */

const ROOT = join(__dirname, "..", "..");
const CONFIG = readFileSync(join(ROOT, "supabase", "config.toml"), "utf8");

type Template = { kind: string; subject: string; path: string; body: string };

function templates(): Template[] {
  const found: Template[] = [];
  for (const match of CONFIG.matchAll(/^\[auth\.email\.template\.(\w+)\]\r?\n((?:(?!\[).*\r?\n?)*)/gm)) {
    const block = match[2] ?? "";
    const subject = block.match(/^subject\s*=\s*"(.*)"/m)?.[1] ?? "";
    const path = block.match(/^content_path\s*=\s*"(.*)"/m)?.[1] ?? "";
    found.push({ kind: match[1] ?? "", subject, path, body: existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), "utf8") : "" });
  }
  return found;
}

const ALL = templates();
const byKind = (kind: string) => ALL.find((t) => t.kind === kind)!;
/** The emails that carry a code the person types into the page that asked for it. */
const WITH_CODE = ["magic_link", "confirmation", "email_change", "reauthentication"];
/** Of those, the ones Supabase also gives a link for (reauthentication has only a code). */
const WITH_LINK = ["magic_link", "confirmation", "email_change"];

function setting(name: string): string {
  const value = CONFIG.match(new RegExp(`^${name}\\s*=\\s*"?([^"\\r\\n]+)"?`, "m"))?.[1];
  if (!value) throw new Error(`${name} missing from config.toml`);
  return value.trim();
}

describe("Auth's email templates (P4-23)", () => {
  it("every email Auth sends a person without an operator is ours, and every template file is used", () => {
    expect(ALL.map((t) => t.kind).sort()).toEqual(["confirmation", "email_change", "magic_link", "reauthentication", "recovery"]);
    for (const t of ALL) {
      expect(t.body, `${t.kind}: ${t.path}`).not.toBe("");
      expect(t.subject, t.kind).toMatch(/Local Saver/);
    }
    const used = ALL.map((t) => t.path.replace("./supabase/templates/", "")).sort();
    expect(readdirSync(join(ROOT, "supabase", "templates")).sort()).toEqual(used);
  });

  it("codes are in the body only: never in a subject, where lock screens show them", () => {
    for (const kind of WITH_CODE) expect(byKind(kind).body.match(/\{\{\s*\.Token\s*\}\}/g), kind).toHaveLength(1);
    for (const t of ALL) expect(t.subject, t.kind).not.toContain("{{");
  });

  it("a link never points at Supabase's verify URL itself: it opens this app, which asks for a click first", () => {
    // A mail scanner that opens Supabase's link uses up the sign-in token, and the code with it (P4-23).
    for (const kind of WITH_LINK) {
      const hrefs = [...byKind(kind).body.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
      expect(hrefs, kind).toEqual(["{{ .RedirectTo }}#confirm={{ .ConfirmationURL }}"]);
    }
    for (const t of ALL) {
      expect(t.body, t.kind).not.toMatch(/\.TokenHash|\.TokenNew|\.SiteURL\s*\}\}\/auth/);
      expect(t.body.match(/\.ConfirmationURL/g)?.length ?? 0, t.kind).toBe(WITH_LINK.includes(t.kind) ? 1 : 0);
    }
  });

  it("a password-reset email carries nothing to sign in with: the app has no passwords (D4-2)", () => {
    const recovery = byKind("recovery").body;
    expect(recovery).not.toMatch(/\.Token|\.ConfirmationURL|\.TokenHash/);
    expect([...recovery.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(["{{ .SiteURL }}/login"]);
  });

  it("plain HTML: nothing loaded from anywhere, no tracking, no notes for the recipient to find", () => {
    for (const t of ALL) {
      expect(t.body, t.kind).not.toMatch(/<(img|script|link|iframe|object|embed|form|style|video|audio|svg)\b|\bsrc=|url\(|@import/i);
      // Every address comes from Auth's variables; none is written into a template.
      expect(t.body, t.kind).not.toMatch(/https?:\/\//i);
      // An HTML comment reaches the recipient's mail; notes for us are template comments, which Auth drops.
      expect(t.body, t.kind).not.toContain("<!--");
      expect(t.body.startsWith("{{- /*"), t.kind).toBe(true);
      expect(t.body, t.kind).toMatch(/<!doctype html>\s*<html lang="en">/i);
    }
  });

  it("the lifetime the emails and the login page state is the one Auth enforces", () => {
    // Changing otp_expiry means changing these words too (and the hosted setting, infra/email/README.md).
    expect(Number(setting("otp_expiry"))).toBe(3600);
    for (const kind of WITH_CODE) expect(byKind(kind).body, kind).toContain("It expires in 1 hour.");
    expect(ACCOUNT_COPY.codeSent("a@b.co")).toContain("It expires in 1 hour.");
    expect(Number(setting("otp_length"))).toBe(6);
  });

  it("the local sender looks like production's: a name, and an address no one receives", () => {
    const local = CONFIG.match(/^\[local_smtp\]\r?\n((?:(?!\[).*\r?\n?)*)/m)?.[1] ?? "";
    expect(local).toMatch(/^sender_name = "Local Saver"$/m);
    expect(local).toMatch(/^admin_email = "no-reply@local-saver\.test"$/m);
  });
});
