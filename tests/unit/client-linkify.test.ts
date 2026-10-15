import { describe, expect, it } from "vitest";
import { LINK_REL, splitLinks } from "@/lib/client/linkify";

/** Text is plain text; only http(s) URLs become links (03 §6). */
describe("splitLinks", () => {
  it("splits text around http and https URLs", () => {
    expect(splitLinks("see https://example.org/a?b=1 and http://x.test.")).toEqual([
      { text: "see " },
      { text: "https://example.org/a?b=1", href: "https://example.org/a?b=1" },
      { text: " and " },
      { text: "http://x.test", href: "http://x.test" },
      { text: "." },
    ]);
  });

  it("never links other schemes", () => {
    for (const text of ["javascript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "ftp://x.test"]) {
      expect(splitLinks(text)).toEqual([{ text }]);
    }
  });

  it("keeps closing punctuation out of the link", () => {
    expect(splitLinks("(https://example.org/x), next")).toEqual([
      { text: "(" },
      { text: "https://example.org/x", href: "https://example.org/x" },
      { text: "), next" },
    ]);
  });

  it("marks links as untrusted user content", () => {
    expect(LINK_REL).toBe("noopener noreferrer nofollow ugc");
  });
});
