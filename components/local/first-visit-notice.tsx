"use client";

import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NOTICE } from "./copy";

const KEY = "local-saver.notice-v1";
const CHANGED = "local-saver:notice";

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

function seenInThisBrowser(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * One-time notice (DEC-033): everyone on the same Wi-Fi, including guests, can see and
 * download local posts. Remembered per browser; a harmless preference (DEC-034 rule 5).
 */
export function FirstVisitNotice({ active }: { active: boolean }) {
  // The server never shows it, so hydration matches; the browser decides after mount.
  const seen = useSyncExternalStore(subscribe, seenInThisBrowser, () => true);
  const [dismissed, setDismissed] = useState(false);

  const dismiss = () => {
    try {
      window.localStorage.setItem(KEY, "1");
      window.dispatchEvent(new Event(CHANGED));
    } catch {
      // private mode: shown again next visit
    }
    setDismissed(true);
  };

  return (
    <Dialog open={active && !seen && !dismissed} onOpenChange={(next) => !next && dismiss()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{NOTICE.title}</DialogTitle>
          <DialogDescription>{NOTICE.body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={dismiss}>{NOTICE.confirm}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
