import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Privacy (draft) · Local Saver" };

/**
 * Privacy draft. It describes what the code does today (03 §13 and phase 2 §18), including what
 * is not automated yet, so it never promises a deletion that doesn't happen.
 */
export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="15 October 2026">
      <p>We collect as little as we can to run the service. There are no ads, no third-party analytics and no tracking cookies.</p>

      <h2>What we store, and for how long</h2>
      <ul>
        <li>
          <strong>What you post</strong> (text, files, file names). Nobody can open a share after it expires or you delete
          it. Text is erased at that moment. Files are deleted from storage right away when you delete a share; after
          expiry they are deleted by a later cleanup step. A scheduled cleanup, with a storage rule that removes anything
          left after 8 days, is planned before public launch and not running yet.
        </li>
        <li>
          <strong>Records about shares</strong> (when they were posted and ended, sizes, file names): kept for 30 days after
          a share ends so we can handle abuse reports. Automatic deletion of these records is not built yet.
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
          Our authentication provider (Supabase) stores the IP address of each session and in its audit log. [OWNER: how
          long, and whether sessions are cleaned up (Q-031).] Deleting inactive anonymous identities is not built yet.
        </li>
        <li>
          <strong>If you open a link or a code</strong>, we set one cookie on that device: a random session value we store
          only as a hash. It lets this browser open that share for up to 12 hours. Session records are deleted 24 hours
          after they expire.
        </li>
        <li>
          <strong>Downloads</strong>: we record that a download or preview link was handed out, for which share, with the
          browser family, to investigate abuse. These records are marked for deletion after 30 days; automatic deletion
          is not built yet.
        </li>
        <li>
          <strong>Abuse reports</strong>: the category, your description and, if you give it, your email address. We keep
          them while we review them. [OWNER: retention after review (Q-022).]
        </li>
        <li>
          <strong>Security counters</strong> (rate limits, failed code attempts), keyed by device, session or the hashed
          network: deleted when their time window ends; a block after many wrong share codes lasts 24 hours.
        </li>
      </ul>

      <h2>Who processes data for us</h2>
      <ul>
        <li>Supabase: database, anonymous sign-in and live updates.</li>
        <li>Cloudflare: network protection, file storage (R2) and bot checks (Turnstile), which run only at sign-in, after several wrong share codes, and when you send a report.</li>
        <li>[OWNER: hosting provider (DEC-022) and data locations (Q-016).]</li>
      </ul>

      <h2>Your choices</h2>
      <ul>
        <li>Delete your shares at any time from My uploads (on the browser you posted from).</li>
        <li>Clearing this site&apos;s data removes your anonymous identity from the browser; you then can&apos;t edit or delete earlier posts, which still expire as scheduled.</li>
        <li>[OWNER: contact for privacy requests and your rights under applicable law (Q-022).]</li>
      </ul>
    </LegalPage>
  );
}
