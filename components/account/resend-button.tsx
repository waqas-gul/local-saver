"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { RESEND_SECONDS } from "@/lib/client/sign-in";
import { ACCOUNT_COPY } from "./copy";

/**
 * "Send a new code" (phase 4 §17.5.8, P4-23), held for RESEND_SECONDS after the last code was sent: Supabase refuses
 * another email to the same address sooner, so the button counts down instead of failing.
 */
export function ResendButton({ sentAt, disabled, onClick, testId }: { sentAt: number; disabled: boolean; onClick: () => void; testId: string }) {
  const [now, setNow] = useState(() => Date.now());
  const left = Math.min(RESEND_SECONDS, Math.max(0, Math.ceil((sentAt + RESEND_SECONDS * 1000 - now) / 1000)));

  useEffect(() => {
    const end = sentAt + RESEND_SECONDS * 1000;
    if (Date.now() >= end) return;
    const timer = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= end) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [sentAt]);

  return (
    <Button type="button" variant="outline" disabled={disabled || left > 0} onClick={onClick} data-testid={testId}>
      {left > 0 ? ACCOUNT_COPY.resendIn(left) : ACCOUNT_COPY.resend}
    </Button>
  );
}
