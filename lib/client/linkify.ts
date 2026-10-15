/**
 * Text shares are plain text (03 §6). Only http(s) URLs become links, marked as untrusted
 * user content; nothing is rendered as HTML or Markdown.
 */

export const LINK_REL = "noopener noreferrer nofollow ugc";

export type Segment = { text: string; href?: string };

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

export function splitLinks(text: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const url = match[0].replace(TRAILING_PUNCTUATION, "");
    if (url.length <= "https://".length) continue;
    if (start > last) segments.push({ text: text.slice(last, start) });
    segments.push({ text: url, href: url });
    last = start + url.length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments;
}
