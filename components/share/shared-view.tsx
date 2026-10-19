"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Flag } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ApiRequestError } from "@/lib/client/api-error";
import { queryKeys } from "@/lib/client/queries/keys";
import { viewerContentQuery } from "@/lib/client/queries/links";
import type { ApiClient } from "@/lib/client/api-client";
import { createViewerApiClient } from "@/lib/client/viewer-api";
import { viewerContentResponse, type ViewerContent, type ViewerShareContent } from "@/lib/shared/api/schemas";
import { BURN } from "../burn/copy";
import { expiresIn } from "../local/format";
import { ReportDialog } from "../report/report-dialog";
import { VIEWER_STATES } from "./copy";
import { PasswordPrompt } from "./password-prompt";
import { RoomViewerContent } from "./room-view";
import { ViewerShare } from "./viewer-share";

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
 *
 * Burn after download (Phase 3): the first Download or Reveal, after a confirmation, claims the
 * share for this browser. A revealed text stays in component state only. Others who hold the link
 * see "already downloaded" (410 ALREADY_DOWNLOADED), and so does the claimant once it's gone.
 *
 * Password links (Phase 4, P4-16): the unlock, the content (after a code, a reload or a password
 * change) answer 409 PASSWORD_REQUIRED until this browser's grant proves the password; the page then
 * shows the prompt instead of anything of the share. Once proved, the content is fetched again.
 *
 * Room links (Phase 4, P4-19): the same page, the same unlock, grant and password; the content is the room's shares
 * (room-view.tsx), each shown as a share link's share is (ViewerShare), naming itself in burn actions and reports.
 */

type Phase = "opening" | "ready" | "password" | keyof typeof VIEWER_STATES;
const NO_FRAGMENT = { secret: null, report: false };

function phaseFor(error: unknown, hadSecret: boolean): Phase {
  if (error instanceof ApiRequestError) {
    if (error.code === "PASSWORD_REQUIRED") return "password";
    if (error.code === "ALREADY_DOWNLOADED") return (error.details as { byYou?: boolean } | undefined)?.byYou ? "downloadedByYou" : "downloaded";
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

function SharedContent({ api, content }: { api: ApiClient; content: ViewerShareContent }) {
  const [reporting, setReporting] = useState(false);
  const linkId = content.link.id;
  const burn = content.share.burn;

  return (
    <Card data-testid="shared-content">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <p className="text-sm font-medium">Shared with you</p>
        <span className="flex gap-1">
          {burn && (
            <Badge variant="destructive" data-testid="burn-badge">
              {BURN.badge}
            </Badge>
          )}
          <Badge variant="secondary">{expiresIn(content.link.expiresAt)}</Badge>
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        <ViewerShare api={api} linkId={linkId} share={content.share} />
        <p className="text-xs text-muted-foreground">Your access on this device ends {expiresIn(content.access.expiresAt).replace("Expires in", "in")}.</p>
        <Button size="sm" variant="ghost" onClick={() => setReporting(true)}>
          <Flag aria-hidden />
          Report
        </Button>
      </CardContent>
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
  if (phase === "password") {
    return (
      <PasswordPrompt
        api={api}
        linkId={linkId}
        onVerified={() => {
          setUnlockError(null);
          setUnlocked(true);
          void queryClient.invalidateQueries({ queryKey: queryKeys.linkContent(linkId) });
        }}
        onEnded={setUnlockError}
      />
    );
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

/**
 * Opens the report form once when the report page sent the reader here to report this link. A room link (P4-19) shows
 * many shares, each with its own Report: the reader picks the one they mean.
 */
function ReportableContent({ api, content, openReport }: { api: ApiClient; content: ViewerContent; openReport: boolean }) {
  const [reporting, setReporting] = useState(openReport);
  if ("room" in content) return <RoomViewerContent api={api} content={content} />;
  return (
    <>
      <SharedContent api={api} content={content} />
      {openReport && <ReportDialog api={api} target={{ type: "link", linkId: content.link.id }} open={reporting} onOpenChange={setReporting} />}
    </>
  );
}
