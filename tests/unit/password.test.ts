import { scryptSync } from "node:crypto";
import { describe, expect, it, vi, type Mock } from "vitest";
import { ApiError } from "@/lib/server/http/errors";
import {
  HashSlots,
  hashLinkPassword,
  hashSlots,
  MAX_CONCURRENT_HASHES,
  passwordLengthOk,
  runPasswordAttempt,
  SCRYPT_PARAMS,
  verifyLinkPasswordHash,
} from "@/lib/server/links/password";
import { isCommonPassword } from "@/lib/shared/link-password";

/**
 * Link passwords (phase 4 §17.8.3, T4-P8): the hash format and parameters, the input rules, the order of
 * an attempt (every limit before the hash) and the per-process cap on concurrent hashes. D4-24 chose
 * scrypt (N = 2^17, r = 8, p = 1): the plan's no-dependency option (deviation DV4-70).
 */

const PHC = /^\$scrypt\$ln=17,r=8,p=1\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("hash format and parameters (T4-P8)", () => {
  it("stores a PHC string: scrypt, N = 2^17, r = 8, p = 1, a 16-byte salt and a 32-byte hash", { timeout: 20_000 }, async () => {
    expect(SCRYPT_PARAMS).toEqual({ ln: 17, r: 8, p: 1 });
    const stored = await hashLinkPassword("correct horse");
    const match = PHC.exec(stored);
    expect(match, stored).not.toBeNull();
    const salt = Buffer.from(match![1]!, "base64");
    const hash = Buffer.from(match![2]!, "base64");
    expect(salt).toHaveLength(16);
    expect(hash).toHaveLength(32);
    // Recomputed independently: the parameters in the string are the ones used.
    const expected = scryptSync("correct horse", salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
    expect(hash.equals(expected)).toBe(true);
  });

  it("never stores the password, and salts every hash", { timeout: 20_000 }, async () => {
    const [a, b] = await Promise.all([hashLinkPassword("same password"), hashLinkPassword("same password")]);
    expect(a).not.toBe(b);
    expect(a).not.toContain("same password");
    expect(a.length).toBeLessThanOrEqual(512);
  });

  it("verifies the right password and refuses a wrong one", { timeout: 20_000 }, async () => {
    const stored = await hashLinkPassword("tr0ub4dor&3");
    expect(await verifyLinkPasswordHash("tr0ub4dor&3", stored)).toBe(true);
    expect(await verifyLinkPasswordHash("tr0ub4dor&4", stored)).toBe(false);
    expect(await verifyLinkPasswordHash("TR0UB4DOR&3", stored)).toBe(false);
  });

  it("normalizes to NFC before hashing, so the same visible password matches however it was typed", { timeout: 20_000 }, async () => {
    const composed = "café-au-lait";
    const decomposed = "café-au-lait";
    expect(composed).not.toBe(decomposed);
    const stored = await hashLinkPassword(decomposed);
    expect(await verifyLinkPasswordHash(composed, stored)).toBe(true);
  });

  it("refuses a stored value that isn't exactly this format, without hashing a weaker one", async () => {
    const weak = "$scrypt$ln=10,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    for (const stored of ["", "plain text", weak, "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA", weak.replace("ln=10", "ln=99")]) {
      expect(await verifyLinkPasswordHash("anything at all", stored)).toBe(false);
    }
  });
});

describe("input rules (phase 4 §17.8.3)", () => {
  it("8 to 128 characters, counted after NFC normalization, as characters rather than UTF-16 units", () => {
    expect(passwordLengthOk("a".repeat(7))).toBe(false);
    expect(passwordLengthOk("a".repeat(8))).toBe(true);
    expect(passwordLengthOk("a".repeat(128))).toBe(true);
    expect(passwordLengthOk("a".repeat(129))).toBe(false);
    // 8 emoji are 8 characters (16 UTF-16 units); 7 decomposed "é" are 7 characters after NFC.
    expect(passwordLengthOk("\u{1F511}".repeat(8))).toBe(true);
    expect(passwordLengthOk("é".repeat(7))).toBe(false);
    expect(passwordLengthOk("\u{1F511}".repeat(129))).toBe(false);
  });

  it("refuses to set a password outside the rules: 422 PASSWORD_INVALID, nothing echoed", async () => {
    for (const password of ["short", "x".repeat(129)]) {
      const error = await hashLinkPassword(password).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 422, code: "PASSWORD_INVALID", details: { minLength: 8, maxLength: 128 } });
      expect(JSON.stringify((error as ApiError).details) + (error as ApiError).message).not.toContain(password);
    }
  });

  it("warns (never refuses) about very common passwords, from a short bundled list", () => {
    expect(isCommonPassword("password")).toBe(true);
    expect(isCommonPassword("Password1")).toBe(true);
    expect(isCommonPassword("12345678")).toBe(true);
    expect(isCommonPassword("  QWERTY123 ")).toBe(true);
    expect(isCommonPassword("violet-harbour-71")).toBe(false);
  });
});

describe("an attempt's order: nothing is hashed until every limit has passed (T4-P8)", () => {
  const steps = (overrides: Partial<Record<"admit" | "compare" | "verified" | "failed" | "release", Mock>> = {}) => ({
    admit: vi.fn(async () => "slot"),
    compare: vi.fn(async () => true),
    verified: vi.fn(async () => {}),
    failed: vi.fn(async () => {
      throw new ApiError(403, "PASSWORD_INCORRECT", "wrong");
    }),
    release: vi.fn(async () => {}),
    ...overrides,
  });

  it("a refused admission (lock, limit, Turnstile) never reaches the hash", async () => {
    const s = steps({ admit: vi.fn(async () => Promise.reject(new ApiError(423, "LINK_LOCKED", "locked"))) });
    await expect(runPasswordAttempt(s)).rejects.toMatchObject({ code: "LINK_LOCKED" });
    expect(s.compare).not.toHaveBeenCalled();
    expect(s.verified).not.toHaveBeenCalled();
    expect(s.failed).not.toHaveBeenCalled();
  });

  it("a wrong password is recorded after the hash; a right one marks the grant verified", async () => {
    const wrong = steps({ compare: vi.fn(async () => false) });
    await expect(runPasswordAttempt(wrong)).rejects.toMatchObject({ code: "PASSWORD_INCORRECT" });
    expect(wrong.admit.mock.invocationCallOrder[0]).toBeLessThan(wrong.compare.mock.invocationCallOrder[0]!);
    expect(wrong.failed).toHaveBeenCalledWith("slot");
    expect(wrong.verified).not.toHaveBeenCalled();

    const right = steps();
    await runPasswordAttempt(right);
    expect(right.verified).toHaveBeenCalledWith("slot");
    expect(right.failed).not.toHaveBeenCalled();
  });

  it("a hash that never ran (the server was busy) gives the reserved attempt back instead of counting a failure", async () => {
    const busy = steps({ compare: vi.fn(async () => Promise.reject(new ApiError(503, "SERVER_BUSY", "busy"))) });
    await expect(runPasswordAttempt(busy)).rejects.toMatchObject({ code: "SERVER_BUSY" });
    expect(busy.release).toHaveBeenCalledWith("slot");
    expect(busy.failed).not.toHaveBeenCalled();
  });
});

describe("the per-process cap on concurrent hashes (T4-P8)", () => {
  it("runs at most `limit` tasks at once and queues the rest in order", async () => {
    const slots = new HashSlots(4, 32);
    const gates = Array.from({ length: 10 }, deferred);
    const started: number[] = [];
    let peak = 0;
    const runs = gates.map((gate, i) =>
      slots.run(async () => {
        started.push(i);
        peak = Math.max(peak, slots.active);
        await gate.promise;
        return i;
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(slots.active).toBe(4);
    expect(slots.waiting).toBe(6);
    expect(started).toEqual([0, 1, 2, 3]);
    for (const gate of gates) gate.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBe(4);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(slots.active).toBe(0);
  });

  it("refuses beyond the queue with 503 SERVER_BUSY and Retry-After, and frees a slot when a task throws", async () => {
    const slots = new HashSlots(1, 1);
    const gate = deferred();
    const first = slots.run(() => gate.promise);
    const second = slots.run(async () => "queued");
    const refused = await slots.run(async () => "never").catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 503, code: "SERVER_BUSY", headers: { "Retry-After": "1" } });
    gate.resolve();
    await first;
    expect(await second).toBe("queued");
    await expect(slots.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await slots.run(async () => "free again")).toBe("free again");
  });

  it("the module's real hashes go through a cap of 4", { timeout: 30_000 }, async () => {
    expect(MAX_CONCURRENT_HASHES).toBe(4);
    let peak = 0;
    const watch = setInterval(() => (peak = Math.max(peak, hashSlots.active)), 1);
    try {
      await Promise.all(Array.from({ length: 6 }, (_, i) => hashLinkPassword(`password number ${i}`)));
    } finally {
      clearInterval(watch);
    }
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(4);
    expect(hashSlots.active).toBe(0);
  });
});
