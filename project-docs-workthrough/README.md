# Project Docs — Workthrough

The permanent technical record of this project: audit, architecture, decisions, risks, and the phase-by-phase implementation plan and history.

> **How the system works today: [ARCHITECTURE.md](ARCHITECTURE.md).** It is the current high-level architecture, kept in step with the code. Documents 00–10 are the original plan and target design; the phase documents record what each phase planned, built and tested; [06](06-decisions-and-risks.md) records why decisions were made.

> **Phase 3 (2026-10-16): CODE COMPLETE / NEEDS REVIEW**, on branch `phase-3-expiry-one-time-download` (uncommitted, on top of the Phase 2 commit `3e03120`). The owner answered Q-008 and D-1 … D-9 and asked for implementation before Phase 2 is VERIFIED. Built and tested on the local stack:
> - the storage janitor (a Supabase Edge Function, the one deletion executor) and legal hold for takedowns;
> - retention and anonymous-user cleanup;
> - storage reconciliation and job health (`/health/cron`);
> - burn after download, with a 50-claim race test at the SQL and API levels.
>
> Test counts: 376 unit/component tests, 421 pgTAP assertions, 195 API integration tests, 45 E2E tests.
>
> **Pending:** staging (janitor go-live, latency, a 7-day soak, chaos with alerts, the restore drill), real phones, the owner's copy review, an alert recipient, and the evidence policy (Q-022). See [phase 3 §18](phases/phase-3-expiry-one-time-download.md#18-implementation-2026-10-16) and the [Phase 3 manual procedure](phases/phase-3-manual-verification.md).

> **Phase 2 (2026-10-15; owner decisions applied 2026-10-16): CODE COMPLETE / NEEDS REVIEW**, on branch `phase-2-remote-sharing`, committed and pushed by the owner (`1ade292`, `3e03120`), not merged. The owner started it before Phase 1 is VERIFIED ([phase 2 §17.1](phases/phase-2-remote-sharing.md#171-starting-conditions-and-owner-decision)). Links, QR codes, short codes, link-only posting, viewer sessions and grants, abuse reports and SQL takedown are built and tested on the local stack: 307 unit/component tests, 189 pgTAP assertions, 140 API integration tests, 39 E2E tests. The owner answered Q-010, Q-011 (for Phase 2), Q-027 and Q-028 on 2026-10-16 ([phase 2 §19](phases/phase-2-remote-sharing.md#19-owner-decisions-and-final-review-2026-10-16)). **Pending:** QR scans and code entry on real phones, the takedown rehearsal and legal pages on staging, real R2 and Turnstile, CI, and Q-022 ([phase 2 §19.5](phases/phase-2-remote-sharing.md#195-verification-levels-and-what-blocks-verified)); the [Phase 2 manual procedure](phases/phase-2-manual-verification.md) is ready.

> **Phase 1 (2026-10-15):** **implemented and NEEDS REVIEW.** The owner started it before Phase 0 is VERIFIED ([phase 1 §17.1](phases/phase-1-local-sharing.md#171-starting-conditions-and-owner-decision)). Everything in the repository is built and tested on the local stack: 252 unit/component tests, 134 pgTAP assertions, 83 API integration tests (including the IDOR matrix, Realtime and database-log evidence), 30 E2E tests (two simulated devices, phone-width layout, two emulated phones). The security review, the owner's review items and the owner's follow-ups (Firefox 128+, phone layout, final audience copy) are done ([phase 1 §18.4–§18.6](phases/phase-1-local-sharing.md#186-owner-follow-up-third-pass-2026-10-15)). **Blocked on the owner:** staging and real R2, real devices and networks, copy approval, seven decisions (six assumed answers and Q-031); the [manual and staging procedure](phases/phase-1-manual-verification.md) is ready. Open: staging and real R2, the manual device/network matrix, owner review of the copy, six assumed answers ([phase 1 §18.3](phases/phase-1-local-sharing.md#183-acceptance-criteria-status)). Phase 0 is still BLOCKED on owner items. The Phase 0 and Phase 1 code is committed on branch `phase-1-local-sharing` (not merged into `main`). CI has run only once, on the Phase 0 commit pushed to `main` (2026-09-29), and that run failed at typecheck; the current workflow has not run.

---

## Status board

| Phase | Status | Plan depth | Document |
|---|---|---|---|
| 0 — Architecture and foundation (+ spikes) | **BLOCKED on owner items** (in-repo work done and verified locally; accounts, infrastructure, spikes and decision review pending) | Detailed task plan + implementation log | [phases/phase-0-foundation.md](phases/phase-0-foundation.md) |
| 1 — Anonymous local sharing (automatic, same network) | **NEEDS REVIEW** (implemented and tested locally; staging, real devices, copy review and decisions **blocked on the owner**) | Detailed task plan + implementation record | [phases/phase-1-local-sharing.md](phases/phase-1-local-sharing.md) |
| 2 — Remote secure sharing | **CODE COMPLETE / NEEDS REVIEW** (implemented and tested locally; committed and pushed by the owner (`3e03120`), not merged; owner decisions applied 2026-10-16; real-device QR and code entry, takedown rehearsal, staging, CI and Q-022 **pending**) | Detailed task plan + implementation record | [phases/phase-2-remote-sharing.md](phases/phase-2-remote-sharing.md) |
| 3 — Expiry, cleanup, one-time download | **CODE COMPLETE / NEEDS REVIEW** (implemented and tested locally 2026-10-16, not committed; staging, real devices, copy review, alert recipient and evidence policy **pending**) | Detailed task plan (§17) + implementation record (§18) | [phases/phase-3-expiry-one-time-download.md](phases/phase-3-expiry-one-time-download.md) |
| 4 — Accounts, entitlements, Pro, billing | PLANNED | Outline | [phases/phase-4-pro-accounts.md](phases/phase-4-pro-accounts.md) |
| 5 — Team workspaces | PLANNED | Outline | [phases/phase-5-team.md](phases/phase-5-team.md) |
| 6 — Production hardening | PLANNED | Outline (continuous) | [phases/phase-6-production-hardening.md](phases/phase-6-production-hardening.md) |

Decision status: 35 decisions. **ACCEPTED by the owner:** DEC-001 (Next.js and shadcn/ui), DEC-031 (automatic same-network visibility), DEC-034 (Zustand / TanStack Query / Realtime), DEC-035 (shadcn/ui on Radix). DEC-002 REJECTED, DEC-003 SUPERSEDED (CR-001). DEC-022 CONDITIONAL. All others PROPOSED. 31 questions: Q-001 answered, Q-002–Q-004 withdrawn; Q-008, Q-010, Q-027 and Q-028 answered and Q-011 answered for Phase 2 by the owner on 2026-10-16. See [06](06-decisions-and-risks.md).

---

## Reading order

**Engineers and agents working on the code:** start with [ARCHITECTURE.md](ARCHITECTURE.md), then the current phase document.

**Reviewing the plan:**

1. [00-project-overview.md](00-project-overview.md): executive summary, key conclusions, what needs your decision.
2. [10-requirements-and-diagram-review.md](10-requirements-and-diagram-review.md): what in the brief and diagram should change, and why.
3. [03-security-and-network-design.md](03-security-and-network-design.md): the same-network analysis and the local-mode design (automatic visibility, and the guards that keep other networks out).
4. [02-system-architecture.md](02-system-architecture.md) → [04-database-and-storage-design.md](04-database-and-storage-design.md) → [07-plans-and-entitlements.md](07-plans-and-entitlements.md) → [08-deployment-and-operations.md](08-deployment-and-operations.md) → [09-testing-strategy.md](09-testing-strategy.md).
5. [05-implementation-roadmap.md](05-implementation-roadmap.md) and [phases/phase-0-foundation.md](phases/phase-0-foundation.md): what happens next.
6. [06-decisions-and-risks.md](06-decisions-and-risks.md): approve or change decisions and answer questions.

## Document index

| Document | Contents |
|---|---|
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | **The current architecture as implemented** (living document): components, stack, frontend state, API, local network sharing, uploads, text, remote sharing (links, QR, codes, viewers, reports, takedown), database, storage, Realtime, security, data flows, tests, limitations, phase status, and the architecture change rule |
| [00-project-overview.md](00-project-overview.md) | Product as understood, executive summary, architecture at a glance, required requirement changes, top risks, recommended Phase 0, glossary |
| [01-codebase-audit.md](01-codebase-audit.md) | Findings on all ten inspection areas (a pristine Next.js 16.3.5 scaffold), technical debt, and the Next.js 16 behaviours that constrain the design |
| [02-system-architecture.md](02-system-architecture.md) | Stack evaluation (keep/conditional/add), components and trust boundaries, sequence diagrams for key flows, realtime architecture, API conventions and endpoint catalogue, module layout |
| [03-security-and-network-design.md](03-security-and-network-design.md) | Threat model, **what the server can and can't know about a network**, the local-mode design (network keys, origin lock, dual-stack binding, fail-closed guards, per-request visibility, guarantees and residual risks), remote links, QR, short codes, passwords, burn-after-download, content safety, authorization matrix, rate limits, CSP, secrets, privacy |
| [04-database-and-storage-design.md](04-database-and-storage-design.md) | Schema (network spaces and presence, shares, links, Phase 4 rooms, and the rest mapped to the requested entities), RLS and realtime policies, R2 evaluation and configuration, object keys, upload/verify/delete flows, quota ledger, the expiry and cleanup job catalogue, migration strategy |
| [05-implementation-roadmap.md](05-implementation-roadmap.md) | Phase workflow, overview and dependencies, release gates and the public-beta checklist, files and modules per phase, proposed dependencies |
| [06-decisions-and-risks.md](06-decisions-and-risks.md) | Decision log (DEC-001…035), risk register (RISK-001…031), open questions (Q-001…031), change records (CR-001) |
| [07-plans-and-entitlements.md](07-plans-and-entitlements.md) | Plan matrix, entitlements model and resolution, **enforcement-point matrix**, downgrade rules, billing architecture, cost and pricing analysis, ads position |
| [08-deployment-and-operations.md](08-deployment-and-operations.md) | Hosting evaluation and SP-01 pass/fail criteria, topologies, environments, Cloudflare/Supabase/R2 checklists, CI/CD, alerting, configuration inventory, backups and DR, runbooks |
| [09-testing-strategy.md](09-testing-strategy.md) | Test layers and tools, safe network simulation, critical test catalogue (T-001…054), IDOR matrix as code, performance targets, CI gates, manual device/network matrix, verification protocol |
| [10-requirements-and-diagram-review.md](10-requirements-and-diagram-review.md) | 30 findings on the brief and the reference diagram (REQ-001…030), and suggested wording updates |
| [phases/phase-1-manual-verification.md](phases/phase-1-manual-verification.md) | Phase 1 manual, real-device and staging test procedure with the recording sheet |
| [phases/phase-2-manual-verification.md](phases/phase-2-manual-verification.md) | Phase 2 procedure: QR scans and codes on real phones, takedown rehearsal, legal pages, real R2 and Turnstile |
| [phases/](phases/) | One document per phase with the mandatory sections (goal, scope, state, changes, non-changes, decisions, files, DB/API changes, security, dependencies, tests, acceptance criteria, risks, questions, status, verification record) |

Folders: `runbooks/` (operational procedures: [egress lists](runbooks/egress-lists.md) from Phase 1; [takedown](runbooks/takedown.md) and [kill switches](runbooks/kill-switches.md) from Phase 2; [janitor](runbooks/janitor.md), [cron](runbooks/cron.md), [monitoring](runbooks/monitoring.md), [incident](runbooks/incident.md), [secret rotation](runbooks/secret-rotation.md) and [restore drill](runbooks/restore-drill.md) from Phase 3). Created later: `spikes/` (Phase 0 spike reports).

---

## Workflow rules

```text
Inspect → Create/update plan → Document it → Human review → Approve/change architecture
→ Implement phase → Test → Verify → Update documentation → Next phase
```

- **Do not jump ahead.** A phase starts only after the previous phase is `VERIFIED` and its own plan is approved.
- **Code written ≠ done.** `COMPLETED` means merged. `VERIFIED` means every acceptance criterion has recorded evidence and owner sign-off ([09 §9](09-testing-strategy.md#9-verification-protocol-how-a-phase-becomes-verified)).
- **Never silently change an accepted decision.** Use a change record in [06 §5](06-decisions-and-risks.md#5-change-records) (previous decision, reason, new decision, impact).
- **Keep [ARCHITECTURE.md](ARCHITECTURE.md) current.** Any phase that changes the architecture updates it in the same change and adds an entry to its change log: previous architecture, new architecture, reason, affected components, migration and compatibility impact ([§19](ARCHITECTURE.md#19-architecture-change-rule)).
- Before implementing a phase, add its **detailed task plan** (task-by-task, test-first, exact files and commands) to the phase document.

### Status vocabulary

| Phases | Decisions | Risks | Questions |
|---|---|---|---|
| `NOT STARTED` · `PLANNED` · `IN PROGRESS` · `BLOCKED` · `COMPLETED` · `VERIFIED` | `PROPOSED` · `CONDITIONAL` · `ACCEPTED` · `SUPERSEDED` · `REJECTED` | `OPEN` · `MITIGATING` · `ACCEPTED` · `CLOSED` | `OPEN` · `ANSWERED` |

### ID conventions

| Prefix | Meaning | Defined in |
|---|---|---|
| `DEC-NNN` | Architecture decision | [06 §2](06-decisions-and-risks.md#2-decision-log) |
| `CR-NNN` | Change record for a decision | [06 §5](06-decisions-and-risks.md#5-change-records) |
| `RISK-NNN` | Risk | [06 §3](06-decisions-and-risks.md#3-risk-register) |
| `Q-NNN` | Open question for the owner | [06 §4](06-decisions-and-risks.md#4-open-questions) |
| `REQ-NNN` | Finding on the requirements or diagram | [10](10-requirements-and-diagram-review.md) |
| `SP-NN` | Technical spike | [phase 0 §4](phases/phase-0-foundation.md#4-spikes) |
| `T-NNN` | Test case | [09 §4](09-testing-strategy.md#4-critical-test-catalogue) |
| `AC-P.N` | Acceptance criterion *N* of phase *P* | Phase documents |
| `G1–G7`, `R1–R6` | Isolation guarantees and residual risks | [03 §3.8](03-security-and-network-design.md#38-isolation-guarantees) |

---

## Changelog

| Date | Change |
|---|---|
| 2026-09-17 | Folder created. Initial audit, architecture, security/network design, data and storage design, roadmap, decision log, plans, deployment, testing, requirements review and phase plans (0–6) drafted. |
| 2026-09-23 | Phase documents and README completed. Phase 2 takedown changed from operator HTTP endpoints to MFA-protected SQL functions (web admin deferred to Phase 4+). |
| 2026-09-23 | **CR-001 — owner decision: keep automatic same-network visibility, no approval step.** DEC-031 accepted; DEC-002 rejected; DEC-003 superseded by DEC-032 (network keys, dual-stack binding, fail-closed guards); DEC-033 added (creator-only controls, link-only posting, no network-feed links). Local mode redesigned in 03, schema in 04, tests in 09, Phase 1 rewritten; rooms and invites moved to Phase 4; SP-05 withdrawn; RISK-025/026 and Q-028–Q-030 added. All documents updated. |
| 2026-09-23 | Owner decisions: Next.js confirmed (DEC-001 ACCEPTED); frontend state management accepted (DEC-034: Zustand for client-only state, TanStack Query for server state, Supabase Realtime for live signals only). Updated 02, 05, 06; consistency edits in README, Phase 1 and 09 (T-003). RISK-027 added. |
| 2026-09-23 | **Phase 0 implementation started and in-repo tasks completed** (not committed). Task plan, deviations DV-1 … DV-8, implementation log, findings F-1 … F-6 and acceptance status in [phase 0 §17–18](phases/phase-0-foundation.md#17-detailed-task-plan-2026-09-23). Docs 02, 04, 05, 06, 08, 09 updated. |
| 2026-09-29 | Owner approved the Phase 0 review and shadcn/ui. Database baseline executed locally (28 pgTAP assertions), types generated and verified. shadcn/ui initialized (P0-18, **DEC-035**). CSP gains `style-src-attr 'unsafe-inline'` for Radix (F-7). Baseline gives `app_server` access to `extensions` so `citext` stays case-insensitive (F-9). Findings F-7 … F-11. Phase 0 now **BLOCKED on owner items**. Docs 00, 02, 03, 04, 05, 06, 08 and phase 0 updated. |
| 2026-10-15 | **Phase 1 implemented** on the owner's instruction (before Phase 0 VERIFIED): migration, API, client, UI, tests; task plan, deviations DV1-1 … DV1-17, findings F1-1 … F1-9, acceptance status and screenshots in [phase 1 §17–18](phases/phase-1-local-sharing.md#17-detailed-task-plan-2026-10-15). Six open questions assumed (Q-007, 019, 021, 023, 029, 030). RustFS replaces MinIO locally. Next.js 16.3.8 for security advisories. Docs 00, 02, 03, 04, 05, 06, 07, 08, 09 updated. Status NEEDS REVIEW. |
| 2026-10-15 | **Phase 1 security review** (no critical/high): write-once uploads and stored-header check (M1), egress-list loader, runbook and fail-closed staleness rule (M2), test-override hardening, lock order, streaming body limit, CSP on dotted paths, per-space download limit, posting rules before idempotent replay. DV1-18 … DV1-20, F1-10, F1-11 and [§18.4](phases/phase-1-local-sharing.md#184-independent-security-review-2026-10-15) added; 03 §3.5/§7, 06 (RISK-001, RISK-010), 08 checklists and alerts, 09 test map updated; [runbooks/egress-lists.md](runbooks/egress-lists.md) added. |
| 2026-10-15 | **Phase 1 review follow-up (second pass).** Fixed: a deleted share's upload URL could put bytes back (tombstones, recorded and capped URL expiry, completion deadline check; F1-12, F1-15); the raw client IP reached Postgres as a query parameter (prefix-only egress lookup, merged ranges, database-log evidence test; F1-13); error codes aligned with 07 §4. Found: Supabase Auth stores session IPs (F1-14, RISK-029, **Q-031**); Firefox 128 is the real floor (Q-019). Added: T-009 fallback test, emulated phone E2E, R2 config test, recaptured and phone-width screenshots, [manual and staging procedure](phases/phase-1-manual-verification.md). Docs 02, 03, 04, 06, 08, 09, runbook and phase 1 §18.5 updated. Status NEEDS REVIEW; six criteria BLOCKED on the owner. |
| 2026-10-15 | **Phase 1 owner follow-ups** ([§18.6](phases/phase-1-local-sharing.md#186-owner-follow-up-third-pass-2026-10-15)): browser baseline corrected to Chrome/Edge 111+, **Firefox 128+**, Safari 16.4+ (01, 02, 06 Q-019); phone header no longer breaks labels (tabs on their own row below 640 px); dialog titles keep clear of the close button; copy split into *"Visible to everyone on this network"* under the composer and *"This network · N devices here now"* in the status bar (00, 03, 06 DEC-033, 10). Layout E2E at 320–1280 px added; screenshots recaptured. Q-031 (Supabase Auth stores session IPs) stays an owner decision. Status NEEDS REVIEW. |
| 2026-10-15 | **[ARCHITECTURE.md](ARCHITECTURE.md) added**: the living description of the architecture as implemented after Phase 1 (checked against the code at commit `1cd8ee3`), with the plan-versus-implementation deviations, current limitations, phase status and the architecture change rule. README: pointer, reading order, index row, workflow rule, current-state line (the code is now committed on a branch). Documentation only; no application code changed. |
| 2026-10-15 | **Phase 2 implemented** on the owner's instruction (before Phase 1 VERIFIED), on branch `phase-2-remote-sharing`: migration, links, viewer sessions and grants, share and code pages, QR, short codes, link-only posting, reports and SQL takedown, remote file policy, legal drafts, tests. Task plan, deviations DV2-1 … DV2-19, findings F2-1 … F2-6, acceptance status in [phase 2 §17–18](phases/phase-2-remote-sharing.md#17-detailed-task-plan-2026-10-15). Four questions assumed (Q-010, 011, 027, 028). ARCHITECTURE.md gains §9 Remote sharing (later sections renumbered) and four change-log entries; 02, 03, 04, 05, 06 (RISK-030, RISK-031), 07, 08, 09, `infra/cloudflare/README.md`, two runbooks and a manual procedure updated or added. Status CODE COMPLETE / NEEDS REVIEW; not committed. |
| 2026-10-16 | **Phase 2 owner decisions** ([phase 2 §19](phases/phase-2-remote-sharing.md#19-owner-decisions-and-final-review-2026-10-16)): Q-010 (block executables, scripts, installers and disk images in Free remote links), Q-027 (limits as implemented) and Q-028 (a link exposes only its share) answered; Q-011 answered for Phase 2 (no ads); a link never outlives its share (DV2-13 accepted); abuse reports are stored, audited and logged with no alert delivery (DV2-11 accepted, Q-022 open). Implementation reviewed against them: report copy that promised a review fixed with regression tests; RISK-032 and RISK-033 added. 06, 03, 07, 08, 09, ARCHITECTURE.md (verification levels in §18), the takedown runbook and the manual procedure updated. Full suite re-run. Still CODE COMPLETE / NEEDS REVIEW; not committed. |
| 2026-10-16 | **Phase 3 task plan** (planning only, [phase 3 §17](phases/phase-3-expiry-one-time-download.md#17-detailed-task-plan-2026-10-16)): traced the current deletion path, 14 conflicts between the scope plan and the code with the smallest compatible approach, janitor and job designs, burn-after-download claim and race analysis, database and API changes, threat model, test plan, runbook contents, tasks P3-00 … P3-16, acceptance mapping, open decisions (Q-008, Q-013, Q-022, D-1 … D-9) and proposed risks R3-1 … R3-8. No code, migrations or packages. |
| 2026-10-16 | **Phase 3 implemented** ([phase 3 §18](phases/phase-3-expiry-one-time-download.md#18-implementation-2026-10-16)). Owner decisions Q-008 and D-1 … D-9 applied. **P3-00:** Edge Function limits measured locally; the egress merge doesn't fit, so it moves to GitHub Actions. **Built:** the storage-janitor Edge Function (one deletion executor, SQL guard rails, backoff, dry run, reconciliation), legal hold for takedowns, retention and anonymous-user cleanup with evidence exclusions, ledger reconciliation, job heartbeats and `/health/cron`, burn after download (claim, grace, Reveal, confirm-received, finalize; UI with OWNER REVIEW copy), and six new routes. Three migrations. Deviations DV3-1 … DV3-14; RISK-034 … RISK-041. **Tests:** 354 unit/component, 401 pgTAP, 192 integration (T-037 at the SQL and API levels, with mutation checks), 45 E2E. **Docs:** 06 (decisions, Q-008, risks), ARCHITECTURE.md, 02, 03, 04, 07, 08, 09; six new runbooks, three updated; the Phase 3 manual procedure. CODE COMPLETE / NEEDS REVIEW; not committed. |
| 2026-10-16 | **Phase 3 security review** ([phase 3 §18.13](phases/phase-3-expiry-one-time-download.md#1813-security-review-2026-10-16)). R2's lifecycle rules would have deleted legally held objects at their class period + 1 day; the janitor now copies held objects to `hold/`, which no rule covers (DV3-15). The janitor token's scope (RISK-037) and the injected Supabase keys (RISK-036) are documented as platform limitations, with regression tests. Not verified on real R2. Updated 06, ARCHITECTURE.md, 03, 04, 08, six runbooks and the manual procedure. |
