import { LINK_REL, splitLinks } from "@/lib/client/linkify";

/** Plain text with http(s) URLs as links (03 §6). React escapes everything else. */
export function LinkedText({ text }: { text: string }) {
  return (
    <p className="text-sm whitespace-pre-wrap break-words">
      {splitLinks(text).map((segment, i) =>
        segment.href ? (
          <a key={i} href={segment.href} target="_blank" rel={LINK_REL} className="underline underline-offset-2">
            {segment.text}
          </a>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </p>
  );
}
