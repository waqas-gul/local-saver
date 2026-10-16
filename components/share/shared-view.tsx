"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, FileText, Flag } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiRequestError } from "@/lib/client/api-error";
import { queryKeys } from "@/lib/client/queries/keys";
import { viewerContentQuery, viewerPreviewQuery } from "@/lib/client/queries/links";
import type { ApiClient } from "@/lib/client/api-client";
import { createViewerApiClient } from "@/lib/client/viewer-api";
import { downloadUrlResponse, viewerContentResponse, type ViewerContent, type ViewerFileDto } from "@/lib/shared/api/schemas";
import { RISK_LABELS } from "../local/copy";
import { expiresIn, formatBytes } from "../local/format";
import { LinkedText } from "../local/linked-text";
import { ReportDialog } from "../report/report-dialog";
import { REMOTE_RISK_WARNING, VIEWER_STATES } from "./copy";

/**
 * The share page (/s/{linkId}, 03 §4.1–§4.2). The server sends a static shell; everything here
 * happens in the browser:
 *
 * 1. Read the secret from the URL fragment (browsers never send it to any server).
 * 2. POST it once to unlock: a viewer session cookie and a grant, no Supabase user.
 * 3. Strip the fragment from the address bar, so it doesn't linger in history or screenshots.
 * 4. Show only the link's target share, polled every 30 s and on focus (no Realtime).
 *
 * Without a fragment (a reload, or arriving from the code page) the grant alone is tried.
 * A 404 or 410 replaces everything cached for the link (DEC-034 rule 4). The phase shown is
 * derived from the unlock result and the content query; no state mirrors it.
 */

type Phase = "opening" | "ready" | keyof typeof VIEWER_STATES;
const NO_FRAGMENT = { secret: null, report: false };

function phaseFor(error: unknown, hadSecret: boolean): Phase {
  if (error instanceof ApiRequestError) {
    if (error.status === 410) return "expired";
    if (error.status === 404) return hadSecret ? "unavailable" : "incomplete";
    if (error.code === "REMOTE_LINKS_DISABLED") return "paused";
    if (error.status === 429) return "limited";
  }
  return "failed";
}

/** The secret from "#k=…", if any (03 §4.1). Report requests from the report page add "&report=1". */
function readFragment(): { secret: string | null; report: boolean } {
  if (!window.location.hash) return NO_FRAGMENT;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const secret = params.get("k");
  return { secret: secret && /^[A-Za-z0-9_-]{43}$/.test(secret) ? secret : null, report: params.get("report") === "1" };
}

function stripFragment(): void {
  if (window.location.hash) window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
}

function Preview({ api, linkId, file }: { api: ApiClient; linkId: string; file: ViewerFileDto }) {
  const { data } = useQuery(viewerPreviewQuery(api, linkId, file.id));
  if (!data) return <div className="size-12 shrink-0 animate-pulse rounded-md bg-muted" aria-hidden />;
  // eslint-disable-next-line @next/next/no-img-element -- deliberate: no image optimization of user content
  return <img src={data.url} alt={file.name} className="size-12 shrink-0 rounded-md object-cover" referrerPolicy="no-referrer" />;
}

function SharedContent({ api, content }: { api: ApiClient; content: ViewerContent }) {
  const [risky, setRisky] = useState<ViewerFileDto | null>(null);
  const [reporting, setReporting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linkId = content.link.id;

  const download = async (file: ViewerFileDto) => {
    setError(null);
    try {
      const { url } = await api.request("POST", `/api/v1/links/${linkId}/files/${file.id}/download-url`, {
        body: {},
        schema: downloadUrlResponse,
      });
      // Content-Disposition: attachment (signed at upload), so this downloads in place.
      window.location.assign(url);
    } catch (e) {
      setError(e instanceof ApiRequestError && e.code === "LINK_DAILY_LIMIT"
        ? "This link has reached its download limit for today. Try again tomorrow."
        : "Couldn't start the download. Try again.");
    }
  };

  return (
    <Card data-testid="shared-content">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <p className="text-sm font-medium">Shared with you</p>
        <Badge variant="secondary">{expiresIn(content.link.expiresAt)}</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {content.share.text && (
          <>
            <div data-testid="shared-text">
              <LinkedText text={content.share.text.content} />
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void navigator.clipboard.writeText(content.share.text?.content ?? "").then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              <Copy aria-hidden />
              {copied ? "Copied" : "Copy"}
            </Button>
          </>
        )}
        {content.share.files.length > 0 && (
          <ul className="space-y-2">
            {content.share.files.map((file) => (
              <li key={file.id} className="flex items-center gap-3 rounded-lg border p-2">
                {file.previewable ? <Preview api={api} linkId={linkId} file={file} /> : <FileText className="size-8 shrink-0 text-muted-foreground" aria-hidden />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{file.name}</p>
                  <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                    {formatBytes(file.sizeBytes)}
                    {file.riskFlags.map((flag) => (
                      <Badge key={flag} variant="destructive">
                        {RISK_LABELS[flag] ?? flag}
                      </Badge>
                    ))}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Download ${file.name}`}
                  onClick={() => (file.riskFlags.length > 0 ? setRisky(file) : void download(file))}
                >
                  <Download aria-hidden />
                  Download
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">Your access on this device ends {expiresIn(content.access.expiresAt).replace("Expires in", "in")}.</p>
        <Button size="sm" variant="ghost" onClick={() => setReporting(true)}>
          <Flag aria-hidden />
          Report
        </Button>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>

      <Dialog open={risky !== null} onOpenChange={(open) => !open && setRisky(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{REMOTE_RISK_WARNING.title}</DialogTitle>
            <DialogDescription>{REMOTE_RISK_WARNING.body}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRisky(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const file = risky;
                setRisky(null);
                if (file) void download(file);
              }}
            >
              {REMOTE_RISK_WARNING.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ReportDialog api={api} target={{ type: "link", linkId }} open={reporting} onOpenChange={setReporting} />
    </Card>
  );
}

export function SharedView({ linkId }: { linkId: string }) {
  const queryClient = useQueryClient();
  const [api] = useState(() => createViewerApiClient());
  // Read once, in the browser. The first render shows "Opening…" either way, so hydration matches.
  const [fragment] = useState(() => (typeof window === "undefined" ? NO_FRAGMENT : readFragment()));
  const [unlocked, setUnlocked] = useState(false);
  const [unlockError, setUnlockError] = useState<unknown>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!fragment.secret || started.current) return; // once per page load, even if React mounts twice
    started.current = true;
    // A direct call, not a mutation: the secret is never kept in the query cache (DEC-034).
    api
      .request("POST", `/api/v1/links/${linkId}/unlock`, { body: { secret: fragment.secret }, schema: viewerContentResponse })
      .then((content) => {
        stripFragment();
        queryClient.setQueryData(queryKeys.linkContent(linkId), { content, ended: null });
        setUnlocked(true);
      })
      .catch((error: unknown) => {
        // A definite answer: the secret is useless now. A network error keeps it for a reload.
        if (error instanceof ApiRequestError) stripFragment();
        setUnlockError(error);
      });
  }, [api, fragment.secret, linkId, queryClient]);

  // With a secret, wait for the unlock; without one, try this browser's grant (reload, code page).
  const content = useQuery(viewerContentQuery(api, linkId, fragment.secret ? unlocked : true));
  const ended = content.data?.ended ?? null;

  useEffect(() => {
    // Nothing of an ended link stays cached (DEC-034 rule 4); the content itself was replaced.
    if (ended) queryClient.removeQueries({ queryKey: [...queryKeys.link(linkId), "preview"] });
  }, [ended, linkId, queryClient]);

  const phase: Phase = unlockError
    ? phaseFor(unlockError, true)
    : ended
      ? phaseFor(ended, fragment.secret !== null)
      : content.error
        ? phaseFor(content.error, fragment.secret !== null)
        : content.data?.content
          ? "ready"
          : "opening";

  if (phase === "ready" && content.data?.content) {
    return <ReportableContent api={api} content={content.data.content} openReport={fragment.report} />;
  }
  if (phase === "opening") {
    return <p className="py-12 text-center text-sm text-muted-foreground">Opening…</p>;
  }
  const state = VIEWER_STATES[phase as keyof typeof VIEWER_STATES];
  return (
    <div className="space-y-3 py-12 text-center" data-testid="viewer-state" data-state={phase}>
      <h2 className="text-lg font-medium">{state.title}</h2>
      <p className="text-sm text-muted-foreground">{state.body}</p>
      {(phase === "incomplete" || phase === "unavailable") && (
        <Button asChild variant="outline" size="sm">
          <Link href="/c">Enter a share code</Link>
        </Button>
      )}
    </div>
  );
}

/** Opens the report form once when the report page sent the reader here to report this link. */
function ReportableContent({ api, content, openReport }: { api: ApiClient; content: ViewerContent; openReport: boolean }) {
  const [reporting, setReporting] = useState(openReport);
  return (
    <>
      <SharedContent api={api} content={content} />
      {openReport && <ReportDialog api={api} target={{ type: "link", linkId: content.link.id }} open={reporting} onOpenChange={setReporting} />}
    </>
  );
}
