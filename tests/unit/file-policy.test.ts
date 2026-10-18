import { describe, expect, it } from "vitest";
import { resolveEntitlements } from "@/lib/server/entitlements/resolve";
import { assertRemoteAllowed, remoteFilePolicy } from "@/lib/server/security/file-policy";
import { riskFlags } from "@/lib/server/security/file-risk";

/** Remote-link file policy (03 §7.4, Q-010 assumed, T-035 unit part). */

// Resolution is asynchronous since Phase 4 (P4-01); anonymous users are Free without a database read.
const free = await resolveEntitlements({ userId: "u", isAnonymous: true });
const noContent = { executable: false, script: false, archive: false };
const flagsFor = (name: string) => riskFlags({ name, extension: name.split(".").pop() ?? "" }, noContent);

describe("remote file policy for Free links", () => {
  it("blocks executables, scripts, installers and disk images", () => {
    for (const name of ["setup.exe", "run.bat", "install.ps1", "app.apk", "package.msi", "Installer.pkg", "disk.iso", "mac.dmg", "tool.jar"]) {
      expect(remoteFilePolicy(flagsFor(name), free).allowed, name).toBe(false);
    }
  });

  it("allows archives with a warning", () => {
    const policy = remoteFilePolicy(flagsFor("photos.zip"), free);
    expect(policy).toEqual({ allowed: true, blockedFlags: [], warnings: ["archive"] });
  });

  it("allows ordinary files without warnings", () => {
    expect(remoteFilePolicy(flagsFor("report.pdf"), free)).toEqual({ allowed: true, blockedFlags: [], warnings: [] });
  });

  it("names the flags that block a file", () => {
    expect(remoteFilePolicy(["executable", "double_extension"], free).blockedFlags).toEqual(["executable", "double_extension"]);
  });

  it("refuses a share with any blocked file (422 REMOTE_FILE_BLOCKED)", () => {
    expect(() => assertRemoteAllowed([{ riskFlags: [] }, { riskFlags: ["script"] }], free)).toThrowError(
      expect.objectContaining({ status: 422, code: "REMOTE_FILE_BLOCKED" }),
    );
    expect(() => assertRemoteAllowed([{ riskFlags: ["archive"] }], free)).not.toThrow();
  });

  it("would allow them for a plan with executablesInRemoteLinks (Pro, Phase 4)", () => {
    const pro = { ...free, features: { ...free.features, executablesInRemoteLinks: true } };
    expect(remoteFilePolicy(["executable"], pro)).toEqual({ allowed: true, blockedFlags: [], warnings: ["executable"] });
  });
});
