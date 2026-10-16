"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Report a link without browsing it first: the pasted link opens the share page with the report
 * form already open ("#k=…&report=1"). The secret stays in the fragment, so it never reaches a
 * server; reporting still requires holding the link (the server checks the grant).
 */
export function ReportLinkForm() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const url = new URL(value.trim());
      const match = /^\/s\/([A-Za-z0-9_-]{16})$/.exec(url.pathname);
      const secret = new URLSearchParams(url.hash.slice(1)).get("k");
      if (url.origin !== window.location.origin || !match || !secret) throw new Error();
      router.push(`/s/${match[1]}#k=${secret}&report=1`);
    } catch {
      setError("Paste the whole link, as you received it. For a share code, open it on the code page and press Report there.");
    }
  };

  return (
    <form className="flex flex-col gap-2 sm:flex-row" onSubmit={submit}>
      <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Paste the link" aria-label="Link to report" />
      <Button type="submit" variant="outline" disabled={value.trim() === ""}>
        Report this link
      </Button>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
