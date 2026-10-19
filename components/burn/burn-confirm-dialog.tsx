"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BURN } from "./copy";

/**
 * The confirmation before a download or Reveal claims a burn share (03 §5.4, phase 3 §17.8.8):
 * the claim is always a deliberate second click, so unfurlers, scanners and stray taps never
 * consume it. The existing Radix dialog: focus trapped, works with touch.
 */
export function BurnConfirmDialog({
  open,
  action,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  action: "download" | "reveal";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent data-testid="burn-confirm">
        <DialogHeader>
          <DialogTitle>{BURN.confirmTitle}</DialogTitle>
          <DialogDescription>{BURN.confirmBody}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{BURN.graceWarning}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {BURN.cancel}
          </Button>
          <Button variant="destructive" onClick={onConfirm} data-testid="burn-confirm-button">
            {action === "reveal" ? BURN.reveal : BURN.confirmDownload}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
