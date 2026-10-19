import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Acceptable use (draft) · Local Saver" };

export default function AcceptableUsePage() {
  return (
    <LegalPage title="Acceptable Use Policy" updated="18 October 2026">
      <p>Don&apos;t use Local Saver to share or do any of the following:</p>
      <ul>
        <li>Child sexual abuse material. We remove it, keep what the law requires, and report it to the authorities.</li>
        <li>Anything illegal where you are or where it is opened.</li>
        <li>Malware, or files meant to harm devices or steal data; phishing pages or scams.</li>
        <li>Content you don&apos;t have the right to share, including other people&apos;s copyrighted work.</li>
        <li>Harassment, threats, or other people&apos;s private information without their consent.</li>
        <li>Spam, or using the service to host files for other websites.</li>
        <li>Guessing links, share codes, invites or passwords, getting around limits, plans or bot checks (for example with many accounts), or disrupting the service.</li>
        <li>Using other people&apos;s accounts, or payment details you aren&apos;t allowed to use.</li>
      </ul>
      <p>These rules apply everywhere: on a network, by link or code, and in private rooms and their links.</p>
      <h2>What we do</h2>
      <p>
        We can remove content, turn off links, share codes and invites, switch off sharing for a network, and restrict
        devices and accounts that break these rules. Programs, scripts, installers and disk images can&apos;t be shared by
        link or share code, on any plan.
      </p>
      <p>Report a problem with the Report button on the share, or on the Report abuse page.</p>
    </LegalPage>
  );
}
