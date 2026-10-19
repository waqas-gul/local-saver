/**
 * Multipart uploads (phase 4 §17.8.1, DEC-026): the byte range of each part, shared by the server (the
 * size it signs into each part URL and expects at completion) and the uploader (the slice it sends).
 * The server alone chooses the part size and count (lib/server/storage/multipart.ts).
 */

/** R2: at most 10,000 parts per upload. */
export const MULTIPART_MAX_PARTS = 10_000;

/** Part `partNumber` (1-based) of a `size`-byte file cut into `partSize`-byte parts: all equal but the last. */
export function partRange(partNumber: number, partSize: number, size: number): { start: number; end: number; size: number } {
  const count = Math.ceil(size / partSize);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count) throw new RangeError("part number out of range");
  const start = (partNumber - 1) * partSize;
  const end = Math.min(start + partSize, size);
  return { start, end, size: end - start };
}
