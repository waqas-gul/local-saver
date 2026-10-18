import { formatBytes } from "@/lib/shared/format";
import {
  AVAILABLE_FEATURES,
  deliverableLimits,
  FREE_FEATURES,
  FREE_LIMITS,
  PRICING,
  PRO_FEATURES,
  PRO_LIMITS,
  type Features,
  type Limits,
} from "@/lib/shared/plans";
import { BILLING_COPY } from "./copy";

/**
 * The Free / Pro comparison (phase 4 §17.6.5). Static, generated from lib/shared/plans.ts as this
 * build delivers it (deliverableLimits), so it can't drift from what the server enforces; features
 * appear once they exist (AVAILABLE_FEATURES). Prices wait for Q-006.
 */

type Row = { key: string; label: string; value: (limits: Limits, features: Features) => string };

const longest = (options: readonly number[]) => BILLING_COPY.expiryValue(Math.max(...options));
const count = (n: number) => n.toLocaleString("en-US");

const ROWS: Row[] = [
  { key: "maxFileBytes", label: BILLING_COPY.rows.maxFileBytes, value: (l) => formatBytes(l.maxFileBytes) },
  { key: "maxFilesPerShare", label: BILLING_COPY.rows.maxFilesPerShare, value: (l) => count(l.maxFilesPerShare) },
  { key: "maxTextBytes", label: BILLING_COPY.rows.maxTextBytes, value: (l) => formatBytes(l.maxTextBytes) },
  { key: "activeStorageBytes", label: BILLING_COPY.rows.activeStorageBytes, value: (l) => formatBytes(l.activeStorageBytes) },
  { key: "dailyUploadBytes", label: BILLING_COPY.rows.dailyUploadBytes, value: (l) => formatBytes(l.dailyUploadBytes) },
  { key: "expiry", label: BILLING_COPY.rows.expiry, value: (l) => longest(l.localExpiryOptionsSeconds) },
  { key: "linkExpiry", label: BILLING_COPY.rows.linkExpiry, value: (l) => longest(l.linkExpiryOptionsSeconds) },
  { key: "codeExpiry", label: BILLING_COPY.rows.codeExpiry, value: (l) => longest(l.shortCodeExpiryOptionsSeconds) },
  { key: "linkDownloads", label: BILLING_COPY.rows.linkDownloads, value: (l) => count(l.linkDailyUrlIssuances) },
  { key: "devices", label: BILLING_COPY.rows.devices, value: (l) => count(l.maxSignedInDevices) },
  ...AVAILABLE_FEATURES.map((feature) => ({
    key: feature,
    label: BILLING_COPY.rows[feature as keyof typeof BILLING_COPY.rows] ?? feature,
    value: (_: Limits, f: Features) => (f[feature] ? BILLING_COPY.included : BILLING_COPY.notIncluded),
  })),
];

function price(): string {
  const { monthly, yearly } = PRICING.pro;
  if (!monthly && !yearly) return BILLING_COPY.pricePlaceholder;
  return [monthly && BILLING_COPY.perMonth(monthly), yearly && BILLING_COPY.perYear(yearly)].filter(Boolean).join(" · ");
}

export function PricingTable() {
  const free = deliverableLimits(FREE_LIMITS);
  const pro = deliverableLimits(PRO_LIMITS);
  return (
    <table className="w-full table-fixed border-collapse text-sm" data-testid="pricing-table">
      <thead>
        <tr className="border-b">
          <th scope="col" className="w-2/5 py-2 text-left font-normal text-muted-foreground">
            <span className="sr-only">Limit</span>
          </th>
          <th scope="col" className="py-2 text-left">
            <span className="block font-semibold">{BILLING_COPY.free}</span>
            <span className="block text-xs font-normal text-muted-foreground">{BILLING_COPY.freePrice}</span>
          </th>
          <th scope="col" className="py-2 text-left">
            <span className="block font-semibold">{BILLING_COPY.pro}</span>
            <span className="block text-xs font-normal text-muted-foreground" data-testid="pro-price">
              {price()}
            </span>
          </th>
        </tr>
      </thead>
      <tbody>
        {ROWS.map((row) => (
          <tr key={row.key} className="border-b align-top" data-testid={`pricing-row-${row.key}`}>
            <th scope="row" className="py-2 pr-2 text-left font-normal text-muted-foreground">
              {row.label}
            </th>
            <td className="py-2 pr-2">{row.value(free, FREE_FEATURES)}</td>
            <td className="py-2">{row.value(pro, PRO_FEATURES)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
