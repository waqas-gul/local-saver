import { describe, expect, it } from "vitest";
import { contentDisposition } from "@/lib/server/security/content-disposition";
import { riskFlags } from "@/lib/server/security/file-risk";
import { sanitizeFilename } from "@/lib/server/security/filenames";

describe("sanitizeFilename (03 §7.2, T-023)", () => {
  it("keeps ordinary names and lower-cases the extension", () => {
    expect(sanitizeFilename("Holiday Photo.JPG")).toEqual({ name: "Holiday Photo.JPG", extension: "jpg" });
  });

  it("removes bidirectional overrides used for extension spoofing", () => {
    // "invoice<RLO>fdp.exe" displays as "invoiceexe.pdf"
    const result = sanitizeFilename("invoice‮fdp.exe");
    expect(result.name).toBe("invoicefdp.exe");
    expect(result.extension).toBe("exe");
    for (const ch of ["‪", "‫", "‬", "‭", "⁦", "⁧", "⁨", "⁩", "‎", "‏"]) {
      expect(sanitizeFilename(`a${ch}b.txt`).name).toBe("ab.txt");
    }
  });

  it("removes control and zero-width characters", () => {
    expect(sanitizeFilename("a\u0000b\u0007c\u001F\u007Fd.txt").name).toBe("abcd.txt");
    expect(sanitizeFilename("re​port﻿.pdf").name).toBe("report.pdf");
    expect(sanitizeFilename("line\r\nbreak.txt").name).toBe("linebreak.txt");
  });

  it("replaces path separators and reserved punctuation", () => {
    expect(sanitizeFilename('../../etc/passwd').name).toBe("_.._etc_passwd");
    expect(sanitizeFilename('a\\b:c*d?e"f<g>h|i.txt').name).toBe("a_b_c_d_e_f_g_h_i.txt");
  });

  it("trims leading and trailing dots and spaces", () => {
    expect(sanitizeFilename("  ..hidden.txt.. ").name).toBe("hidden.txt");
  });

  it("avoids Windows reserved device names", () => {
    expect(sanitizeFilename("CON").name).toBe("_CON");
    expect(sanitizeFilename("nul.txt").name).toBe("_nul.txt");
    expect(sanitizeFilename("com1.tar.gz").name).toBe("_com1.tar.gz");
    expect(sanitizeFilename("console.txt").name).toBe("console.txt");
  });

  it("normalizes to NFC", () => {
    expect(sanitizeFilename("café.txt").name).toBe("café.txt");
  });

  it("limits names to 255 UTF-8 bytes and keeps the extension", () => {
    const long = `${"é".repeat(300)}.pdf`;
    const result = sanitizeFilename(long);
    expect(Buffer.byteLength(result.name, "utf8")).toBeLessThanOrEqual(255);
    expect(result.name.endsWith(".pdf")).toBe(true);
    expect(result.name).not.toContain("�");
  });

  it("falls back to a neutral name when nothing is left", () => {
    expect(sanitizeFilename(" ‮.. ").name).toBe("file");
  });

  it("only treats short alphanumeric suffixes as extensions", () => {
    expect(sanitizeFilename("archive.tar.gz").extension).toBe("gz");
    expect(sanitizeFilename("notes").extension).toBe("");
    expect(sanitizeFilename("weird.ex e").extension).toBe("");
  });
});

describe("contentDisposition (04 §8.4, T-024)", () => {
  it("always uses attachment with an ASCII fallback and a UTF-8 filename*", () => {
    expect(contentDisposition("report.pdf")).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    expect(contentDisposition("Grüße 2026.txt")).toBe(
      `attachment; filename="Gr__e 2026.txt"; filename*=UTF-8''Gr%C3%BC%C3%9Fe%202026.txt`,
    );
  });

  it("escapes characters that would break the header", () => {
    const header = contentDisposition(`it's (big) *final*.txt`);
    expect(header).toBe(`attachment; filename="it's (big) *final*.txt"; filename*=UTF-8''it%27s%20%28big%29%20%2Afinal%2A.txt`);
    expect(contentDisposition('a"b\\c.txt')).toContain('filename="a_b_c.txt"');
  });
});

describe("riskFlags (03 §7.4)", () => {
  const none = { executable: false, script: false, archive: false };

  it("flags executables, scripts, archives and disk images by extension", () => {
    expect(riskFlags({ name: "setup.exe", extension: "exe" }, none)).toEqual(["executable"]);
    expect(riskFlags({ name: "run.ps1", extension: "ps1" }, none)).toEqual(["script"]);
    expect(riskFlags({ name: "a.zip", extension: "zip" }, none)).toEqual(["archive"]);
    expect(riskFlags({ name: "disk.iso", extension: "iso" }, none)).toEqual(["disk_image"]);
    expect(riskFlags({ name: "notes.txt", extension: "txt" }, none)).toEqual([]);
  });

  it("flags executable content whatever the extension says", () => {
    expect(riskFlags({ name: "cat.png", extension: "png" }, { ...none, executable: true })).toEqual(["executable"]);
  });

  it("flags double extensions that hide an executable", () => {
    expect(riskFlags({ name: "report.pdf.exe", extension: "exe" }, none)).toEqual(["executable", "double_extension"]);
    expect(riskFlags({ name: "archive.tar.gz", extension: "gz" }, none)).toEqual(["archive"]);
  });

  it("treats Java and Android packages as executables", () => {
    expect(riskFlags({ name: "app.apk", extension: "apk" }, { ...none, archive: true })).toEqual(["executable", "archive"]);
  });
});
