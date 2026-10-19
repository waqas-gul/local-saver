import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Privacy (draft) · Local Saver" };

/**
 * Privacy draft. It describes what the code does today (03 §13, phase 2 §18, phase 3 retention, the
 * phase 4 sections), including what is not automated yet, so it never promises a deletion that doesn't
 * happen. Updated for Phase 4 in P4-25 (accounts, rooms, history, payments, account deletion).
 */
export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="18 October 2026">
      <p>We collect as little as we can to run the service. There are no ads, no third-party analytics and no tracking cookies.</p>

      <h2>What we store, and for how long</h2>
      <ul>
        <li>
          <strong>What you post</strong> (text, files, file names). Nobody can open a share after it expires or you delete
          it. Text is erased at that moment, and a cleanup step deletes the files from storage shortly afterwards. A
          storage rule that removes any file left over a day after the longest expiry of its kind is planned before
          launch. [OWNER: confirm once the storage rules are applied.]
        </li>
        <li>
          <strong>Records about shares</strong> (when they were posted and ended, sizes, file names): kept after a share
          ends so we can handle abuse reports, then deleted automatically: after 30 days, or 365 days for shares made with
          Pro (they make up its transfer history). Records of reported shares are kept until the report is dealt with.
          [OWNER: retention of reported content after review (Q-022).]
        </li>
        <li>
          <strong>Your network.</strong> To decide who is on the same network, we compute a keyed hash of your internet
          (IP) address. Our database stores the hash, never the address. Network records with no shares and no recent
          visits are deleted after 30 days. &quot;Who is here now&quot; records last 10 minutes and are deleted 24 hours
          after your last visit.
        </li>
        <li>
          <strong>This browser.</strong> Each browser gets an anonymous identity from our authentication provider and a
          device record with a generated name (which you can change) and a rough platform such as &quot;iPhone · Safari&quot;.
          An anonymous identity with nothing open is deleted after 30 days without a visit. Our authentication provider
          (Supabase) stores the IP address of each session and in its audit log. [OWNER: how long, and whether sessions
          are cleaned up (Q-031).]
        </li>
        <li>
          <strong>Your account</strong>, if you make one: your email address, the name you choose to show (optional), how
          you sign in (an email code, or Google, which shares your email address and basic profile with our authentication
          provider) and the browsers signed in to it (their names, platforms, and when they were added and last seen). A
          browser&apos;s record is deleted 30 days after you remove it from the account. If you add an authenticator app,
          its key is kept by our authentication provider; we never see it or your codes.
        </li>
        <li>
          <strong>Emails</strong>: we send only what signing in needs (codes and links, and confirming a new address),
          through our authentication provider, using our email provider.
        </li>
        <li>
          <strong>Private rooms</strong>: the room&apos;s name, its members and when they joined, and what is posted to it.
          Members see each other by account name, or by the name of the device they joined with.
        </li>
        <li>
          <strong>Transfer history (Pro)</strong>: for 365 days, your own shares and what happened to them. Who opened or
          downloaded them is shown only as a kind (a room member, someone with the link), never who.
        </li>
        <li>
          <strong>Payments (Pro)</strong>: your card details go to the payment provider, never to us. We store your plan,
          the subscription&apos;s status and dates, the provider&apos;s customer and subscription references, a short
          record of each payment event (kept 400 days) and lost payment disputes. These records stay after you delete your
          account, as accounting law requires. [OWNER: retention period after legal review (Q-005, Q-022).]
        </li>
        <li>
          <strong>If you open a link or a code</strong>, we set one cookie on that device: a random session value we store
          only as a hash. It lets this browser open that share or room link for up to 12 hours. Session records are
          deleted 24 hours after they expire.
        </li>
        <li>
          <strong>Downloads</strong>: we record that a download or preview link was handed out, for which share, with the
          browser family, to investigate abuse. These records are deleted after 30 days, or 365 days for shares made with
          Pro.
        </li>
        <li>
          <strong>Abuse reports</strong>: the category, your description and, if you give it, your email address. We keep
          them while we review them. [OWNER: retention after review (Q-022).]
        </li>
        <li>
          <strong>Security counters</strong> (rate limits, failed code and password attempts), keyed by device, session or
          the hashed network: deleted when their time window ends; a block after many wrong share codes lasts 24 hours.
        </li>
        <li>
          <strong>Records of actions</strong> on the service (a share made or ended, a browser removed from an account, an
          account deletion requested): kept 90 days, longer where they concern reported content or our own actions on abuse. They
          hold no IP addresses or content.
        </li>
      </ul>

      <h2>Deleting your account</h2>
      <p>
        You can delete your account in its settings. It is deleted 7 days later, and you can cancel until then. Then your
        open shares end and their files are deleted, rooms you own are deleted, and your browsers, profile and sign-in
        identity are deleted. Other people&apos;s records keep what happened (for example a download) but not that it was
        you. Payment records, records of actions and abuse reports are kept as described above.
      </p>

      <h2>Who processes data for us</h2>
      <ul>
        <li>Supabase: database, sign-in (anonymous and accounts), authenticator apps, live updates, and sending sign-in emails.</li>
        <li>Cloudflare: network protection, file storage (R2) and bot checks (Turnstile), which run only at sign-in, after several wrong share codes or passwords, and when you send a report.</li>
        <li>[OWNER: the email provider that delivers sign-in emails (D4-8).]</li>
        <li>[OWNER: the payment provider for Pro (Q-005).]</li>
        <li>Google, only if you choose to sign in with Google.</li>
        <li>[OWNER: hosting provider (DEC-022) and data locations (Q-016).]</li>
      </ul>

      <h2>Your choices</h2>
      <ul>
        <li>Delete your shares at any time from My uploads (on the browser you posted from, or on any browser of your account).</li>
        <li>Sign a browser out of your account, cancel Pro, or delete your account, in your settings.</li>
        <li>Without an account, clearing this site&apos;s data removes your anonymous identity from the browser; you then can&apos;t edit or delete earlier posts, which still expire as scheduled.</li>
        <li>A copy of your data isn&apos;t available from the app yet. [OWNER: how to ask for one, the contact for privacy requests, and your rights under applicable law (Q-022).]</li>
      </ul>
    </LegalPage>
  );
}
