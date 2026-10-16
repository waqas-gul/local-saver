"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp, Send, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ApiRequestError } from "@/lib/client/api-error";
import { entitlementsQuery } from "@/lib/client/queries/entitlements";
import { queryKeys } from "@/lib/client/queries/keys";
import { useRuntime } from "@/lib/client/runtime";
import { UploadsStore } from "@/lib/client/stores/session";
import { useUiStore } from "@/lib/client/stores/ui-store";
import { uploadFiles } from "@/lib/client/uploader";
import { shareResponse, type ShareDto } from "@/lib/shared/api/schemas";
import { EXPIRY_LABELS, FREE_LIMITS } from "@/lib/shared/plans";
import { BURN } from "../burn/copy";
import { LINK_ONLY_AUDIENCE } from "../share/copy";
import { ShareLinkDialog } from "../share/share-link-dialog";
import { AUDIENCE } from "./copy";
import { formatBytes } from "./format";

/**
 * Post text or files (DEC-033) to this network, or as Link only: never visible on any network,
 * shared by link, QR code or code (Phase 2). The audience line is shown right below the button.
 * Where local sharing is off, Link only is the one destination. Limits shown here are hints;
 * the server enforces them (07 §3). Burn after download (Phase 3) is offered only when the server
 * says this device may use it (GET /me/entitlements, Q-008).
 */

type Destination = "network" | "link_only";

function textError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === "TEXT_TOO_LARGE") return "This text is longer than 100 KB.";
    if (error.code === "LOCAL_SHARING_UNAVAILABLE") return "Local sharing is off on this network.";
    if (error.code === "RATE_LIMITED") return "You're posting too fast. Wait a moment.";
    if (error.code === "UPLOADS_DISABLED") return "Posting is paused right now.";
    if (error.code === "REMOTE_LINKS_DISABLED") return "Sharing by link is paused right now.";
    // OWNER REVIEW (phase 3 §17.9): burn errors at posting.
    if (error.code === "FEATURE_NOT_IN_PLAN" || error.code === "BURN_AFTER_DOWNLOAD_DISABLED") return "Burn after download isn't available right now.";
  }
  return "Couldn't post. Try again.";
}

export function Composer({ localAvailable = true }: { localAvailable?: boolean }) {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const uploads = UploadsStore.useStoreApi();
  const draft = useUiStore((s) => s.textDraft);
  const setDraft = useUiStore((s) => s.setTextDraft);
  const files = useUiStore((s) => s.selectedFiles);
  const setFiles = useUiStore((s) => s.setSelectedFiles);
  const [tab, setTab] = useState("text");
  const [expiresIn, setExpiresIn] = useState<number>(FREE_LIMITS.localDefaultExpirySeconds);
  const [chosen, setChosen] = useState<Destination>("network");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The just-posted link-only share, to make its link straight away.
  const [linkShare, setLinkShare] = useState<ShareDto | null>(null);
  const destination: Destination = localAvailable ? chosen : "link_only";
  const entitlements = useQuery(entitlementsQuery(runtime?.api ?? null));
  const burnAllowed = entitlements.data?.features.burnAfterDownload === true;
  const [burnChosen, setBurnChosen] = useState(false);
  const burn = burnAllowed && burnChosen;

  const textBytes = new TextEncoder().encode(draft).length;
  const tooLong = textBytes > FREE_LIMITS.maxTextBytes;
  const oversized = files.filter((f) => f.size > FREE_LIMITS.maxFileBytes);
  const tooMany = files.length > FREE_LIMITS.maxFilesPerShare;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.local() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.myShares() });
  };

  const postText = async () => {
    if (!runtime) return;
    setBusy(true);
    setError(null);
    try {
      const { share } = await runtime.api.request("POST", "/api/v1/texts", {
        body: { destination, content: draft, expiresIn, ...(burn ? { burnAfterDownload: true } : {}) },
        schema: shareResponse,
      });
      setDraft("");
      refresh();
      if (destination === "link_only") setLinkShare(share);
    } catch (e) {
      setError(textError(e));
    } finally {
      setBusy(false);
    }
  };

  const sendFiles = async () => {
    if (!runtime || files.length === 0) return;
    const selected = files;
    const target = destination;
    setFiles([]);
    setError(null);
    const share = await uploadFiles({
      api: runtime.api,
      files: selected,
      expiresIn,
      destination: target,
      burnAfterDownload: burn,
      uploads,
      onFinished: refresh,
    });
    if (share && target === "link_only") setLinkShare(share);
  };

  const canPost = tab === "text" ? draft.trim().length > 0 && !tooLong && !busy : files.length > 0 && oversized.length === 0 && !tooMany;

  return (
    <Card data-testid="composer">
      <CardContent className="space-y-3">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="text">Text</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
          </TabsList>
          <TabsContent value="text" className="space-y-1">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type or paste text to share"
              rows={3}
              aria-label="Text to share"
              data-testid="composer-text"
            />
            {tooLong && <p className="text-xs text-destructive">Text can be up to 100 KB.</p>}
          </TabsContent>
          <TabsContent value="files" className="space-y-2">
            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              <FileUp className="size-4" aria-hidden />
              Choose files (up to {FREE_LIMITS.maxFilesPerShare}, 100 MB each)
              <input
                type="file"
                multiple
                className="sr-only"
                data-testid="composer-files"
                onChange={(e) => {
                  setFiles([...files, ...Array.from(e.target.files ?? [])]);
                  e.target.value = "";
                }}
              />
            </label>
            {files.length > 0 && (
              <ul className="space-y-1 text-sm">
                {files.map((file, i) => (
                  <li key={`${file.name}-${i}`} className="flex items-center justify-between gap-2">
                    <span className={`truncate ${file.size > FREE_LIMITS.maxFileBytes ? "text-destructive" : ""}`}>
                      {file.name} · {formatBytes(file.size)}
                    </span>
                    <Button variant="ghost" size="icon-xs" aria-label={`Remove ${file.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                      <X aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {oversized.length > 0 && <p className="text-xs text-destructive">Files can be up to 100 MB each.</p>}
            {tooMany && <p className="text-xs text-destructive">You can share up to {FREE_LIMITS.maxFilesPerShare} files at once.</p>}
          </TabsContent>
        </Tabs>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            {localAvailable && (
              <Select value={chosen} onValueChange={(v) => setChosen(v as Destination)}>
                <SelectTrigger size="sm" aria-label="Post to" data-testid="composer-destination">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="network">This network</SelectItem>
                  <SelectItem value="link_only">Link only</SelectItem>
                </SelectContent>
              </Select>
            )}
            <Select value={String(expiresIn)} onValueChange={(v) => setExpiresIn(Number(v))}>
              <SelectTrigger size="sm" aria-label="Expires after">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FREE_LIMITS.localExpiryOptionsSeconds.map((seconds) => (
                  <SelectItem key={seconds} value={String(seconds)}>
                    Expires after {EXPIRY_LABELS[seconds]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={() => void (tab === "text" ? postText() : sendFiles())} disabled={!canPost} data-testid="composer-submit">
            <Send aria-hidden />
            {destination === "network" ? "Share to this network" : "Post and get a link"}
          </Button>
        </div>
        {burnAllowed && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={burnChosen}
              onChange={(e) => setBurnChosen(e.target.checked)}
              data-testid="composer-burn"
            />
            {BURN.toggle}
          </label>
        )}
        <p className="text-xs text-muted-foreground" data-testid="audience-line">
          {destination === "network" ? AUDIENCE : LINK_ONLY_AUDIENCE}
        </p>
        {burn && (
          <p className="text-xs text-muted-foreground" data-testid="burn-line">
            {destination === "network" ? BURN.networkLine : BURN.linkOnlyLine}
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
      {linkShare && <ShareLinkDialog share={linkShare} open onOpenChange={(open) => !open && setLinkShare(null)} />}
    </Card>
  );
}
