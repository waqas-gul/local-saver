import "server-only";

/**
 * Risky file flags (03 §7.4). Local shares allow these files with a warning badge and a
 * confirmation before download; remote-link rules arrive in Phase 2.
 * Detection uses the extension and the magic bytes.
 */

export type RiskFlag = "executable" | "script" | "archive" | "double_extension" | "disk_image";

const EXECUTABLE = new Set([
  "exe", "msi", "msp", "dll", "scr", "com", "pif", "cpl", "apk", "jar", "appx", "msix", "deb", "rpm",
]);
const SCRIPT = new Set([
  "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "lnk", "reg", "sh", "command", "scpt",
]);
const ARCHIVE = new Set(["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "cab"]);
const DISK_IMAGE = new Set(["iso", "img", "dmg", "vhd", "vhdx"]);

export type ContentSignals = { executable: boolean; script: boolean; archive: boolean };

export function riskFlags(file: { name: string; extension: string }, content: ContentSignals): RiskFlag[] {
  const ext = file.extension.toLowerCase();
  const executable = EXECUTABLE.has(ext) || content.executable;
  const script = SCRIPT.has(ext) || content.script;

  // "report.pdf.exe": a second, document-looking extension in front of a runnable one.
  const segments = file.name.split(".");
  const doubleExtension =
    (EXECUTABLE.has(ext) || SCRIPT.has(ext)) &&
    segments.length >= 3 &&
    /^[A-Za-z0-9]{2,5}$/.test(segments[segments.length - 2] ?? "");

  const flags: RiskFlag[] = [];
  if (executable) flags.push("executable");
  if (script) flags.push("script");
  if (ARCHIVE.has(ext) || content.archive) flags.push("archive");
  if (doubleExtension) flags.push("double_extension");
  if (DISK_IMAGE.has(ext)) flags.push("disk_image");
  return flags;
}
