import "server-only";

/**
 * Content-Disposition fixed at upload through a signed header (04 §8.4, DEC-010).
 * Always "attachment": downloads never render in the browser. The filename is expected to
 * be sanitized already (no control characters).
 */
export function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  // RFC 8187 attr-char: encodeURIComponent leaves ' ( ) * unescaped, which attr-char forbids.
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
