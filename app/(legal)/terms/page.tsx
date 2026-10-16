import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Terms (draft) · Local Saver" };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="15 October 2026">
      <h2>1. What the service does</h2>
      <p>
        Local Saver lets you share text and files without an account. Posts to <strong>this network</strong> are shown
        automatically to everyone whose device reaches the service from the same network (for example the same Wi-Fi),
        including guests. Posts made as <strong>Link only</strong> are shown to nobody on any network: only people you
        send the link, its QR code or a share code to can open them.
      </p>
      <h2>2. Your content</h2>
      <ul>
        <li>You are responsible for what you post and for who you send links and codes to.</li>
        <li>Post only content you have the right to share. Don&apos;t post anything private to a network you don&apos;t control.</li>
        <li>You allow us to store and transmit your content only to run the service: to show it to the people you shared it with until it expires or you delete it.</li>
        <li>Anyone who can open your content can download it and keep it. Deleting a share or turning off a link stops further access, not copies already made.</li>
      </ul>
      <h2>3. Rules</h2>
      <p>
        You must follow the <Link href="/acceptable-use" className="underline">Acceptable Use Policy</Link>. Programs,
        scripts, installers and disk images can&apos;t be shared by link on the free service.
      </p>
      <h2>4. Expiry and removal</h2>
      <ul>
        <li>Every share expires (after 1 hour, 24 hours or 7 days, as you choose) and can&apos;t be opened after that.</li>
        <li>We may remove content, turn off links, and block networks or devices that break these terms or the law, and may report illegal content to the authorities where the law requires it.</li>
      </ul>
      <h2>5. Limits and availability</h2>
      <p>
        The service has size, storage and rate limits, and may be paused or changed at any time. It is provided as it is,
        without guarantees. [OWNER: liability, warranty and governing-law wording after legal review (Q-016, Q-022).]
      </p>
      <h2>6. Contact</h2>
      <p>
        To report abuse, use the Report button on the share, or see <Link href="/report" className="underline">Report abuse</Link>.
        [OWNER: legal contact address (Q-022).]
      </p>
    </LegalPage>
  );
}
