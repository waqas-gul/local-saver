# Project Docs — Workthrough

The permanent technical record of this project: audit, architecture, decisions, risks, and the phase-by-phase implementation plan and history.

> **Current state (2026-10-15):** **Phase 1 is implemented and NEEDS REVIEW.** The owner started it before Phase 0 is VERIFIED ([phase 1 §17.1](phases/phase-1-local-sharing.md#171-starting-conditions-and-owner-decision)). Everything in the repository is built and tested on the local stack: 252 unit/component tests, 134 pgTAP assertions, 83 API integration tests (including the IDOR matrix, Realtime and database-log evidence), 30 E2E tests (two simulated devices, phone-width layout, two emulated phones). The security review, the owner's review items and the owner's follow-ups (Firefox 128+, phone layout, final audience copy) are done ([phase 1 §18.4–§18.6](phases/phase-1-local-sharing.md#186-owner-follow-up-third-pass-2026-10-15)). **Blocked on the owner:** staging and real R2, real devices and networks, copy approval, seven decisions (six assumed answers and Q-031); the [manual and staging procedure](phases/phase-1-manual-verification.md) is ready. Open: staging and real R2, the manual device/network matrix, owner review of the copy, six assumed answers ([phase 1 §18.3](phases/phase-1-local-sharing.md#183-acceptance-criteria-status)). Phase 0 is still BLOCKED on owner items. Nothing is committed yet. **Phase 2 has not started.**

---

## Status board

| Phase | Status | Plan depth | Document |
|---|---|---|---|
| 0 — Architecture and foundation (+ spikes) | **BLOCKED on owner items** (in-repo work done and verified locally; accounts, infrastructure, spikes and decision review pending) | Detailed task plan + implementation log | [phases/phase-0-foundation.md](phases/phase-0-foundation.md) |
| 1 — Anonymous local sharing (automatic, same network) | **NEEDS REVIEW** (implemented and tested locally; staging, real devices, copy review and decisions **blocked on the owner**) | Detailed task plan + implementation record | [phases/phase-1-local-sharing.md](phases/phase-1-local-sharing.md) |
| 2 — Remote secure sharing | PLANNED | Detailed scope | [phases/phase-2-remote-sharing.md](phases/phase-2-remote-sharing.md) |
| 3 — Expiry, cleanup, one-time download | PLANNED | Detailed scope | [phases/phase-3-expiry-one-time-download.md](phases/phase-3-expiry-one-time-download.md) |
| 4 — Accounts, entitlements, Pro, billing | PLANNED | Outline | [phases/phase-4-pro-accounts.md](phases/phase-4-pro-accounts.md) |
| 5 — Team workspaces | PLANNED | Outline | [phases/phase-5-team.md](phases/phase-5-team.md) |
| 6 — Production hardening | PLANNED | Outline (continuous) | [phases/phase-6-production-hardening.md](phases/phase-6-production-hardening.md) |

Decision status: 35 decisions. **ACCEPTED by the owner:** DEC-001 (Next.js and shadcn/ui), DEC-031 (automatic same-network visibility), DEC-034 (Zustand / TanStack Query / Realtime), DEC-035 (shadcn/ui on Radix). DEC-002 REJECTED, DEC-003 SUPERSEDED (CR-001). DEC-022 CONDITIONAL. All others PROPOSED. 31 questions: Q-001 answered, Q-002–Q-004 withdrawn, 27 open. See [06](06-decisions-and-risks.md).

---

## Reading order

1. [00-project-overview.md](00-project-overview.md): executive summary, key conclusions, what needs your decision.
2. [10-requirements-and-diagram-review.md](10-requirements-and-diagram-review.md): what in the brief and diagram should change, and why.
3. [03-security-and-network-design.md](03-security-and-network-design.md): the same-network analysis and the local-mode design (automatic visibility, and the guards that keep other networks out).
4. [02-system-architecture.md](02-system-architecture.md) → [04-database-and-storage-design.md](04-database-and-storage-design.md) → [07-plans-and-entitlements.md](07-plans-and-entitlements.md) → [08-deployment-and-operations.md](08-deployment-and-operations.md) → [09-testing-strategy.md](09-testing-strategy.md).
5. [05-implementation-roadmap.md](05-implementation-roadmap.md) and [phases/phase-0-foundation.md](phases/phase-0-foundation.md): what happens next.
6. [06-decisions-and-risks.md](06-decisions-and-risks.md): approve or change decisions and answer questions.

## Document index

| Document | Contents |
|---|---|
| [00-project-overview.md](00-project-overview.md) | Product as understood, executive summary, architecture at a glance, required requirement changes, top risks, recommended Phase 0, glossary |
| [01-codebase-audit.md](01-codebase-audit.md) | Findings on all ten inspection areas (a pristine Next.js 16.3.5 scaffold), technical debt, and the Next.js 16 behaviours that constrain the design |
| [02-system-architecture.md](02-system-architecture.md) | Stack evaluation (keep/conditional/add), components and trust boundaries, sequence diagrams for key flows, realtime architecture, API conventions and endpoint catalogue, module layout |
| [03-security-and-network-design.md](03-security-and-network-design.md) | Threat model, **what the server can and can't know about a network**, the local-mode design (network keys, origin lock, dual-stack binding, fail-closed guards, per-request visibility, guarantees and residual risks), remote links, QR, short codes, passwords, burn-after-download, content safety, authorization matrix, rate limits, CSP, secrets, privacy |
| [04-database-and-storage-design.md](04-database-and-storage-design.md) | Schema (network spaces and presence, shares, links, Phase 4 rooms, and the rest mapped to the requested entities), RLS and realtime policies, R2 evaluation and configuration, object keys, upload/verify/delete flows, quota ledger, the expiry and cleanup job catalogue, migration strategy |
| [05-implementation-roadmap.md](05-implementation-roadmap.md) | Phase workflow, overview and dependencies, release gates and the public-beta checklist, files and modules per phase, proposed dependencies |
| [06-decisions-and-risks.md](06-decisions-and-risks.md) | Decision log (DEC-001…035), risk register (RISK-001…028), open questions (Q-001…030), change records (CR-001) |
| [07-plans-and-entitlements.md](07-plans-and-entitlements.md) | Plan matrix, entitlements model and resolution, **enforcement-point matrix**, downgrade rules, billing architecture, cost and pricing analysis, ads position |
| [08-deployment-and-operations.md](08-deployment-and-operations.md) | Hosting evaluation and SP-01 pass/fail criteria, topologies, environments, Cloudflare/Supabase/R2 checklists, CI/CD, alerting, configuration inventory, backups and DR, runbooks |
| [09-testing-strategy.md](09-testing-strategy.md) | Test layers and tools, safe network simulation, critical test catalogue (T-001…054), IDOR matrix as code, performance targets, CI gates, manual device/network matrix, verification protocol |
| [10-requirements-and-diagram-review.md](10-requirements-and-diagram-review.md) | 30 findings on the brief and the reference diagram (REQ-001…030), and suggested wording updates |
| [phases/phase-1-manual-verification.md](phases/phase-1-manual-verification.md) | Phase 1 manual, real-device and staging test procedure with the recording sheet |
| [phases/](phases/) | One document per phase with the mandatory sections (goal, scope, state, changes, non-changes, decisions, files, DB/API changes, security, dependencies, tests, acceptance criteria, risks, questions, status, verification record) |

Folders: `runbooks/` (operational procedures; first one in Phase 1: [egress lists](runbooks/egress-lists.md)). Created later: `spikes/` (Phase 0 spike reports).

---

## Workflow rules

```text
Inspect → Create/update plan → Document it → Human review → Approve/change architecture
→ Implement phase → Test → Verify → Update documentation → Next phase
```

- **Do not jump ahead.** A phase starts only after the previous phase is `VERIFIED` and its own plan is approved.
- **Code written ≠ done.** `COMPLETED` means merged. `VERIFIED` means every acceptance criterion has recorded evidence and owner sign-off ([09 §9](09-testing-strategy.md#9-verification-protocol-how-a-phase-becomes-verified)).
- **Never silently change an accepted decision.** Use a change record in [06 §5](06-decisions-and-risks.md#5-change-records) (previous decision, reason, new decision, impact).
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
