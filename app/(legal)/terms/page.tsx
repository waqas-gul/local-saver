import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Terms (draft) · Local Saver" };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="18 October 2026">
      <h2>1. What the service does</h2>
      <p>
        Local Saver lets you share text and files, with or without an account. Posts to <strong>this network</strong> are
        shown automatically to everyone whose device reaches the service from the same network (for example the same
        Wi-Fi), including guests. Posts made as <strong>Link only</strong> are shown to nobody on any network: only people
        you send the link, its QR code or a share code to can open them. Posts to a <strong>private room</strong> (created
        with Pro) are shown to the room&apos;s members, from any network.
      </p>
      <h2>2. Your content</h2>
      <ul>
        <li>You are responsible for what you post and for who you send links, codes and invites to.</li>
        <li>Post only content you have the right to share. Don&apos;t post anything private to a network you don&apos;t control.</li>
        <li>You allow us to store and transmit your content only to run the service: to show it to the people you shared it with until it expires or you delete it.</li>
        <li>Anyone who can open your content can download it and keep it. Deleting a share or turning off a link stops further access, not copies already made.</li>
        <li>Everyone in a private room sees what is posted to it. Anyone with a room&apos;s read-only link sees what is posted to the room while the link works.</li>
      </ul>
      <h2>3. Rules</h2>
      <p>
        You must follow the <Link href="/acceptable-use" className="underline">Acceptable Use Policy</Link>. Programs,
        scripts, installers and disk images can&apos;t be shared by link or share code, on any plan.
      </p>
      <h2>4. Your account</h2>
      <ul>
        <li>An account is optional. You sign in with a code sent to your email address (or with Google, where offered), so keep your email account secure. You can add an authenticator app.</li>
        <li>An account can be signed in on up to 10 browsers. You can sign any of them out in your settings.</li>
        <li>If you sign in on a browser where you posted without an account, those posts move into your account.</li>
        <li>You can delete your account in your settings. It is deleted 7 days later; until then you can&apos;t post anything new, and you can cancel. What we keep afterwards is in the <Link href="/privacy" className="underline">Privacy Policy</Link>.</li>
      </ul>
      <h2>5. Pro</h2>
      <ul>
        <li>Pro is a paid subscription, monthly or yearly, for [OWNER: price and currency (Q-006)]. Payments are handled by [OWNER: payment provider, and whether it sells as merchant of record (Q-005)].</li>
        <li>It renews until you cancel. You can cancel at any time in your billing settings, and Pro stays until the end of the period you paid for.</li>
        <li>If a payment fails, Pro continues for a 7-day grace period while the payment is retried, then ends.</li>
        <li>Refunds: [OWNER: refund policy, legal review]. A full refund ends Pro.</li>
        <li>If a payment is disputed and the dispute is lost, Pro ends at once. After a second lost dispute, uploads from the account are paused for review.</li>
        <li>When Pro ends, what you already shared keeps the settings it was made with; anything new follows the free plan.</li>
      </ul>
      <h2>6. Expiry and removal</h2>
      <ul>
        <li>Every share expires (after 1 hour, 24 hours or 7 days, as you choose; with Pro also 30 or 90 days, and Pro shares can be extended) and can&apos;t be opened after that.</li>
        <li>We may remove content, turn off links, and block networks, devices or accounts that break these terms or the law, and may report illegal content to the authorities where the law requires it.</li>
      </ul>
      <h2>7. Limits and availability</h2>
      <p>
        The service has size, storage and rate limits, which depend on your plan, and may be paused or changed at any time.
        It is provided as it is, without guarantees. [OWNER: liability, warranty, consumer rights for paid plans and
        governing-law wording after legal review (Q-016, Q-022).]
      </p>
      <h2>8. Contact</h2>
      <p>
        To report abuse, use the Report button on the share, or see <Link href="/report" className="underline">Report abuse</Link>.
        [OWNER: legal and support contact address (Q-022).]
      </p>
    </LegalPage>
  );
}
