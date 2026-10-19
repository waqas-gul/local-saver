import { describe, expect, it } from "vitest";
import { sniff, SNIFF_BYTES } from "@/lib/server/storage/sniff";

function bytes(...parts: (string | number[])[]): Uint8Array {
  const chunks = parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p)));
  return new Uint8Array(Buffer.concat(chunks));
}

describe("sniff (03 §7.3, T-025)", () => {
  it("reads the first 4,100 bytes", () => {
    expect(SNIFF_BYTES).toBe(4100);
  });

  it("recognizes the raster image formats allowed for previews", () => {
    expect(sniff(bytes([0xff, 0xd8, 0xff, 0xe0], "JFIF"))).toMatchObject({ mime: "image/jpeg", rasterImage: true });
    expect(sniff(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "rest"))).toMatchObject({
      mime: "image/png",
      rasterImage: true,
    });
    expect(sniff(bytes("GIF89a", [1, 2, 3]))).toMatchObject({ mime: "image/gif", rasterImage: true });
    expect(sniff(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "))).toMatchObject({ mime: "image/webp", rasterImage: true });
    expect(sniff(bytes([0, 0, 0, 0x1c], "ftypavif", [0, 0, 0, 0]))).toMatchObject({ mime: "image/avif", rasterImage: true });
  });

  it("does not treat SVG, HTML or PDF as previewable images", () => {
    expect(sniff(bytes("<svg xmlns='http://www.w3.org/2000/svg'>"))).toMatchObject({ rasterImage: false });
    expect(sniff(bytes("<!DOCTYPE html><html>"))).toMatchObject({ rasterImage: false });
    expect(sniff(bytes("%PDF-1.7"))).toMatchObject({ mime: "application/pdf", rasterImage: false });
  });

  it("detects executables: PE, ELF, Mach-O", () => {
    expect(sniff(bytes("MZ", [0x90, 0, 3]))).toMatchObject({ executable: true, rasterImage: false });
    expect(sniff(bytes([0x7f, 0x45, 0x4c, 0x46, 2, 1]))).toMatchObject({ executable: true });
    expect(sniff(bytes([0xcf, 0xfa, 0xed, 0xfe]))).toMatchObject({ executable: true });
    expect(sniff(bytes([0xfe, 0xed, 0xfa, 0xce]))).toMatchObject({ executable: true });
    expect(sniff(bytes([0xca, 0xfe, 0xba, 0xbe]))).toMatchObject({ executable: true });
  });

  it("detects scripts with a shebang and ZIP-based archives", () => {
    expect(sniff(bytes("#!/bin/sh\nrm -rf /"))).toMatchObject({ script: true });
    expect(sniff(bytes("PK", [3, 4, 20, 0]))).toMatchObject({ mime: "application/zip", archive: true });
  });

  it("detects Java and Android packages (ZIPs whose first entry is a manifest) as executables (03 §7.4)", () => {
    const localHeader = (name: string) => {
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(Buffer.byteLength(name), 26);
      return bytes([...header], name, "...");
    };
    expect(sniff(localHeader("META-INF/MANIFEST.MF"))).toMatchObject({ executable: true, archive: true });
    expect(sniff(localHeader("AndroidManifest.xml"))).toMatchObject({ executable: true, archive: true });
    expect(sniff(localHeader("photos/one.jpg"))).toMatchObject({ executable: false, archive: true });
  });

  it("returns nothing special for plain text or empty input", () => {
    expect(sniff(bytes("hello world"))).toEqual({
      mime: null,
      rasterImage: false,
      executable: false,
      script: false,
      archive: false,
    });
    expect(sniff(new Uint8Array())).toMatchObject({ mime: null, rasterImage: false });
  });
});
