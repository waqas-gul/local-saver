import "server-only";

/**
 * Magic-byte detection on the first bytes of an uploaded object (03 §7.3, T-025).
 * Covers the fixed set the product needs: preview-safe raster images, executables,
 * scripts and archives (DV1-7: no general-purpose detection library).
 */

export const SNIFF_BYTES = 4100;

export type SniffResult = {
  mime: string | null;
  rasterImage: boolean;
  executable: boolean;
  script: boolean;
  archive: boolean;
};

function hasBytes(data: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (data.length < offset + signature.length) return false;
  return signature.every((byte, i) => data[offset + i] === byte);
}

function hasText(data: Uint8Array, text: string, offset = 0): boolean {
  return hasBytes(data, Array.from(text, (c) => c.charCodeAt(0)), offset);
}

const RASTER: { mime: string; test: (d: Uint8Array) => boolean }[] = [
  { mime: "image/jpeg", test: (d) => hasBytes(d, [0xff, 0xd8, 0xff]) },
  { mime: "image/png", test: (d) => hasBytes(d, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mime: "image/gif", test: (d) => hasText(d, "GIF87a") || hasText(d, "GIF89a") },
  { mime: "image/webp", test: (d) => hasText(d, "RIFF") && hasText(d, "WEBP", 8) },
  { mime: "image/avif", test: (d) => hasText(d, "ftyp", 4) && (hasText(d, "avif", 8) || hasText(d, "avis", 8)) },
];

const EXECUTABLES: { mime: string; test: (d: Uint8Array) => boolean }[] = [
  { mime: "application/vnd.microsoft.portable-executable", test: (d) => hasText(d, "MZ") },
  { mime: "application/x-elf", test: (d) => hasBytes(d, [0x7f, 0x45, 0x4c, 0x46]) },
  {
    mime: "application/x-mach-binary",
    test: (d) =>
      [
        [0xfe, 0xed, 0xfa, 0xce],
        [0xfe, 0xed, 0xfa, 0xcf],
        [0xce, 0xfa, 0xed, 0xfe],
        [0xcf, 0xfa, 0xed, 0xfe],
        [0xca, 0xfe, 0xba, 0xbe],
      ].some((sig) => hasBytes(d, sig)),
  },
];

const ARCHIVES: { mime: string; test: (d: Uint8Array) => boolean }[] = [
  { mime: "application/zip", test: (d) => hasBytes(d, [0x50, 0x4b, 0x03, 0x04]) || hasBytes(d, [0x50, 0x4b, 0x05, 0x06]) },
  { mime: "application/gzip", test: (d) => hasBytes(d, [0x1f, 0x8b]) },
  { mime: "application/x-7z-compressed", test: (d) => hasBytes(d, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) },
  { mime: "application/vnd.rar", test: (d) => hasText(d, "Rar!\x1a\x07") },
];

export function sniff(data: Uint8Array): SniffResult {
  const result: SniffResult = { mime: null, rasterImage: false, executable: false, script: false, archive: false };

  const raster = RASTER.find((r) => r.test(data));
  if (raster) return { ...result, mime: raster.mime, rasterImage: true };

  const executable = EXECUTABLES.find((e) => e.test(data));
  if (executable) return { ...result, mime: executable.mime, executable: true };

  const archive = ARCHIVES.find((a) => a.test(data));
  if (archive) return { ...result, mime: archive.mime, archive: true };

  if (hasText(data, "%PDF-")) return { ...result, mime: "application/pdf" };
  if (hasText(data, "#!")) return { ...result, mime: "text/x-script", script: true };
  return result;
}
