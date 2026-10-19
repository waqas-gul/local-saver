import { Suspense } from "react";
import { AuthCallback } from "@/components/account/auth-callback";

/** /auth/callback (§17.5.2): finishes an email link or Google sign-in in this browser (PKCE). */
export default function AuthCallbackPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-medium">Signing in</h1>
      {/* useSearchParams needs a Suspense boundary (Next.js 16). */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">…</p>}>
        <AuthCallback />
      </Suspense>
    </div>
  );
}
