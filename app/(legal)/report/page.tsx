import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";
import { ReportLinkForm } from "@/components/report/report-link-form";

export const metadata: Metadata = { title: "Report abuse (draft) · Local Saver" };

export default function ReportPage() {
  return (
    <LegalPage title="Report abuse" updated="15 October 2026">
      <p>
        If something shared with Local Saver breaks the law or our Acceptable Use Policy, tell us. If someone is in
        immediate danger, contact your local emergency services first.
      </p>
      <h2>How to report</h2>
      <ul>
        <li>Opened it from a link or a share code? Press <strong>Report</strong> on that page.</li>
        <li>Seeing it on your network? Press <strong>Report</strong> on the post.</li>
        <li>Have a link but don&apos;t want to look at it? Paste it below. It opens straight into the report form.</li>
      </ul>
      <ReportLinkForm />
      <h2>What happens next</h2>
      <p>
        Every report is recorded together with the share it is about. We can turn off the link or the whole share at
        once, and we never tell the person who shared it who reported it. [OWNER: who reviews reports, response times,
        how child-safety reports are prioritized and reported to the authorities, and the legal contact address
        (Q-022).]
      </p>
    </LegalPage>
  );
}
