# Phase 6 — Production Hardening

| Field | Value |
|---|---|
| **Status** | **PLANNED** (outline). Not started. |
| Plan depth | Outline. A continuous workstream. Items needed for the public beta are **pulled forward** into Phases 2–3 ([05 §4.1](../05-implementation-roadmap.md#41-public-beta-gate-checklist)). |
| Depends on | Phase 3 VERIFIED for most items. Some run alongside Phases 4–5. |
| Last updated | 2026-09-23 |

---

## 1. Goal

Raise safety, reliability, scalability and compliance to the level expected of a paid, public file-sharing service, and re-evaluate deferred options using production data.

## 2. Scope (workstreams)

| Workstream | Contents |
|---|---|
| **Malware scanning** | Asynchronous scanning (ClamAV container on a small VPS or Cloudflare Containers) for files up to a size limit. `scan_status` gating for risky types on remote downloads. Lift the Free executable block only with scanning in place. **No public multi-scanner services** for private files. |
| **Illegal-content handling** | Legal-process maturity (reporting obligations per jurisdiction). Evaluate hash-matching tools. Evidence preservation rules. Operator training. |
| **Network classification** | ASN, VPN, hosting and mobile-carrier data (if not already adopted in Phase 1) to mark more networks `shared_egress`, shrinking residual risk R2 (RISK-001). Tune the large-network cap (Q-029) and the IPv4-with-several-IPv6 rule from production data. |
| **Edge protection** | Cloudflare plan review (Q-013), WAF managed rules, bot management tuning, rate-rule tuning with CGNAT-aware thresholds |
| **Load and chaos** | k6 load tests against the targets in [09 §6](../09-testing-strategy.md#6-performance-and-load-targets-proposal). Chaos drills: janitor down, R2 errors, Supabase degraded, cron stalled. |
| **Data protection and DR** | Point-in-time recovery, quarterly restore drills, configuration-as-code for Cloudflare, R2 and Supabase settings, replication evaluation for Team long-retention content |
| **Security assurance** | External penetration test (focus: isolation, links, burn, billing, workspaces). OWASP ZAP baseline in CI. Dependency update cadence. Secret-rotation automation. |
| **Compliance and privacy** | Data export (user and workspace), deletion SLAs, subprocessor list maintenance, DPA, cookie and consent review if analytics are added, accessibility audit (WCAG 2.2 AA target) |
| **Observability** | Dashboards (API latency, error rates, realtime connections, janitor backlog, storage growth, abuse metrics), alert tuning, log retention policy |
| **Cost controls** | Budget alerts, per-plan unit economics tracking, MAU and connection trends. **Custom-JWT exit ramp** (RISK-006) if anonymous MAU costs grow. |
| **Deferred options** | Cloudflare Worker download gateway (custom domain, exact completion tracking, per-link bandwidth caps). Next.js on Cloudflare Workers re-evaluation. Cache Components for marketing pages. Native companion apps (Q-025), which could identify the real LAN instead of the public IP. |
| **Operator tooling** | Web admin console (MFA, allow-list) for reports, takedowns, user flags and kill switches, with full audit |

## 3. Existing system state (expected at start)

Phases 1–3 live in public beta. Phases 4–5 in progress or live.

## 4. What will be changed

Infrastructure, CI security workflows, the scanner service, classification data pipelines, monitoring configuration, runbooks, legal documents, and the operator console.

## 5. What will NOT be changed

Core security model (DEC-031, DEC-032, DEC-013, DEC-015), unless a change record is approved.

## 6. Architecture decisions involved

DEC-017 (Worker alternative), DEC-022 (hosting re-evaluation), DEC-025 (scanning), DEC-029, plus new decisions as options are adopted.

## 7. Files / modules involved

`instrumentation.ts`, `instrumentation-client.ts`, `infra/**` (scanner, VPS/Tunnel if applicable), `tests/load/*.js`, `.github/workflows/security.yml`, `project-docs-workthrough/runbooks/**`, operator console routes (`app/(ops)/**`).

## 8. Database changes

Scan results fields (already modelled in `files`), classification ranges (`network_egress_ranges` sources), content hash blocklist, operator console audit views, and possibly partitioning of `audit_events` and `downloads`.

## 9. API changes

Operator console endpoints (MFA plus allow-list), scan webhooks and callbacks (internal, secret-authenticated).

## 10. Security considerations

The scanner handles untrusted files: isolate it (container, no network egress except to R2 and the callback, resource limits). Classification data sources must be licensed for commercial use. Pen-test findings are tracked in the risk register.

## 11. Dependencies

Budget for the Cloudflare plan, scanner hosting, PITR and the pen test. Legal counsel.

## 12. Testing requirements

Load tests, chaos drills, ZAP baseline, scanner EICAR test files, restore drills with measured RPO/RTO, accessibility audit.

## 13. Acceptance criteria (outline)

| ID | Criterion |
|---|---|
| AC-6.1 | Remote downloads of risky file types require a `clean` scan. EICAR test blocked. |
| AC-6.2 | Load targets met on production-like staging |
| AC-6.3 | Chaos drills pass: access stays denied and alerts fire |
| AC-6.4 | PITR enabled. Restore drill within RTO. |
| AC-6.5 | External pen test: no open critical or high findings |
| AC-6.6 | Data export and deletion flows meet the documented SLAs |
| AC-6.7 | Cost dashboards and budget alerts active |

## 14. Known risks

RISK-001, RISK-004, RISK-005, RISK-006, RISK-015, RISK-022, RISK-026.

## 15. Open questions

Q-013, Q-022, Q-025.

## 16. Implementation status

| Date | Status | Note |
|---|---|---|
| 2026-09-17 | PLANNED | Outline drafted. Public-beta items pulled forward into Phases 2–3. |
| 2026-09-23 | PLANNED | CR-001: WebRTC experiment removed; classification work targets RISK-001 under automatic visibility |

### Verification record

*Empty until verified.*
