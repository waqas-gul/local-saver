"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuthRuntime } from "@/lib/client/auth-runtime";
import { usePublicConfig } from "@/lib/client/config";
import { navigateTo } from "@/lib/client/navigate";
import { completeCallback, currentMode, readEmailLink, startGoogle, type EmailLink } from "@/lib/client/sign-in";
import { ACCOUNT_COPY } from "./copy";
import { callbackUrl, MergeProblem, mergeProblem } from "./login-form";

/**
 * /auth/callback (§17.5.2): an email link or Google comes back here with a one-time code, which
 * only this browser can exchange (PKCE). Then any pending merge, then the app. A Google account that
 * already belongs to an account comes back with identity_already_exists: the merge is offered.
 * The link in Auth's emails arrives first as #confirm=<Supabase's verify URL> (P4-23): the page follows it only when
 * the person presses Continue, because mail scanners open links and following it uses up the token. The fragment
 * stays in the address bar: browsers never send it, and the token works once, within the hour.
 */

type State = { kind: "working" } | { kind: "failed" } | { kind: "google_merge_offer" } | { kind: "merge_problem"; message: string };

// A code works once; React may run the effect twice in development.
const handled = new Set<string>();

const NO_LINK: EmailLink = { kind: "none" };
const unchanging = () => () => {};
let lastLink: { hash: string; supabaseUrl: string; link: EmailLink } | null = null;

/** The email's link in this page's fragment, the same object while the fragment is (useSyncExternalStore). */
function emailLinkNow(supabaseUrl: string | undefined): EmailLink {
  if (!supabaseUrl) return NO_LINK;
  const hash = window.location.hash;
  if (lastLink?.hash !== hash || lastLink.supabaseUrl !== supabaseUrl) lastLink = { hash, supabaseUrl, link: readEmailLink(hash, supabaseUrl) };
  return lastLink.link;
}

export function AuthCallback() {
  const params = useSearchParams();
  const runtime = useAuthRuntime();
  const config = usePublicConfig();
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "working" });
  const [busy, setBusy] = useState(false);
  // The server has no fragment: it renders the plain callback, and the browser's first render reads the link.
  const link = useSyncExternalStore(unchanging, () => emailLinkNow(config?.supabaseUrl), () => NO_LINK);

  useEffect(() => {
    if (!runtime || !config) return;
    // An email's link: nothing to exchange until the person continues (read here too, in case hydration ran first).
    if (readEmailLink(window.location.hash, config.supabaseUrl).kind !== "none") return;
    const key = params.toString();
    if (handled.has(key)) return;
    handled.add(key);
    void completeCallback(runtime.supabase, runtime.api, new URLSearchParams(key)).then(
      (result) => {
        if (result.kind === "google_merge_offer") return setState(result);
        if (result.kind === "failed") return setState(result);
        const message = mergeProblem(result.merge);
        if (message) return setState({ kind: "merge_problem", message });
        router.replace("/");
      },
      () => setState({ kind: "failed" }),
    );
  }, [params, runtime, config, router]);

  if (link.kind === "follow") {
    return (
      <Card>
        <CardContent className="space-y-3">
          <p className="text-sm">{ACCOUNT_COPY.emailLink}</p>
          <Button onClick={() => navigateTo(link.url)} data-testid="callback-continue">
            {ACCOUNT_COPY.emailLinkContinue}
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (link.kind === "none" && state.kind === "working") return <p className="text-sm text-muted-foreground">{ACCOUNT_COPY.finishing}</p>;

  if (link.kind === "none" && state.kind === "merge_problem") {
    return (
      <Card>
        <CardContent>
          <MergeProblem message={state.message} />
        </CardContent>
      </Card>
    );
  }

  if (link.kind === "none" && state.kind === "google_merge_offer" && runtime) {
    const proceed = async () => {
      setBusy(true);
      try {
        const { mode } = await currentMode(runtime.supabase);
        await startGoogle(runtime.supabase, runtime.api, mode, { redirectTo: callbackUrl(), merge: true });
      } catch {
        setState({ kind: "failed" });
      }
    };
    return (
      <Card>
        <CardContent className="space-y-3" data-testid="merge-offer">
          <h2 className="font-medium">{ACCOUNT_COPY.mergeTitle}</h2>
          <p className="text-sm text-muted-foreground">{ACCOUNT_COPY.mergeBody}</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void proceed()} disabled={busy} data-testid="merge-continue">
              {ACCOUNT_COPY.mergeContinue}
            </Button>
            <Button asChild variant="outline">
              <Link href="/login">{ACCOUNT_COPY.useAnotherEmail}</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-3">
        <p className="text-sm" role="alert" data-testid="callback-failed">
          {ACCOUNT_COPY.errors.callbackFailed}
        </p>
        <Button asChild>
          <Link href="/login">{ACCOUNT_COPY.signIn}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
