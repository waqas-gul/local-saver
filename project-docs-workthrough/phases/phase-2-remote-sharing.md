# Phase 2 — Remote Secure Sharing

| Field | Value |
|---|---|
| **Status** | **CODE COMPLETE / NEEDS REVIEW** (2026-10-15; owner decisions applied and re-verified 2026-10-16, §19). Implemented and tested on the local stack. **Not VERIFIED:** real-device QR scans, phone-keyboard codes, the takedown rehearsal, legal pages on staging, real R2 and Turnstile, and CI are pending (§19.5). |
| Plan depth | Task plan in §17 (written 2026-10-15, before implementation). |
| Depends on | Phase 1 VERIFIED (it is NEEDS REVIEW; owner instruction to proceed, §17.1). Q-010, Q-027, Q-028 answered and Q-011 answered for Phase 2 by the owner on 2026-10-16 (§19.1); Q-022 open. |
| Unblocks | Phase 3 |
| Release | **Invite-only beta** after VERIFIED |
| Branch | `phase-2-remote-sharing`, from `538334d` (Phase 1 branch, unchanged). Not committed. |
| Last updated | 2026-10-16 (§19: owner decisions, implementation review, re-verification) |

---

## 1. Goal

Implement the remote half of the owner's rule (DEC-031): a device on a **different network** gets access **only through a secure link, a QR code of that link, or a short share code**, and only to the specific share (files or text) its creator shared. The recipient gets exactly that and nothing else from the network.

Also:

- **"Link only" posting**: shares that are never visible on any network, only through their links.
- The abuse controls a public file host needs.

Pairing devices into rooms by QR code moved to Phase 4 (Pro private rooms), because Free local mode has no rooms (CR-001).

## 2. Scope

### In scope

| Area | Contents |
|---|---|
| Share links | Created **by the share's creator only** (DEC-033), from any network (including from "My uploads"). Create (expiry ≤ share expiry), list, revoke. Format `/s/{linkId}#k={secret}` (DEC-013). Secret and code HMACs with a pepper version. No link can target a whole network feed (Q-028). |
| Link-only posting | Composer destination **Link only** (`scope = 'link_only'`): never in any network feed or `net:` topic. Available on any network, including where local mode is off. |
| Viewer sessions | `POST /links/{id}/unlock`, `__Host-link_session` cookie, `link_grants` (≤ 12 h). Uniform 404 before the secret is proven, 410 after. |
| Share page | `/s/[linkId]`: static shell, reads the fragment, strips it after unlocking, viewer DTO, downloads and previews through the grant, polls every 30 s. `noindex`, `no-referrer`, no third-party scripts. Generic metadata for unfurlers. |
| QR | Client-side QR generation for share links, with expiry and warning copy |
| Short codes | Create and regenerate (10-char Crockford Base32, default 1 h, max 24 h on Free), `/c` entry page, `POST /codes/resolve` → grant (never reveals the secret), failure limits with Turnstile escalation |
| Fallback copy | Where local mode is off or misses a device, the UI points to "Share by link, QR code or code" |
| Abuse controls | Report button (share page and local feed items) → `abuse_reports` + operator notification. Takedown SQL functions (`admin_block_share`, `admin_block_link`) run from the MFA-protected Supabase dashboard, with a runbook. Per-link daily URL issuance caps. Kill switch `remote_links_enabled`. |
| File policy | Executables, scripts, installers and disk images blocked from anonymous/Free remote links (Q-010). Archives allowed with a warning. |
| Legal pages | Draft Terms, Privacy, Acceptable Use and a Report page (legal review happens before public beta) |
| Headers / SEO | `no-referrer` and `noindex` on `/s`, `/c`. `robots.ts` disallows them. |

**As built / accepted (2026-10-16, §19.1):** the "operator notification" above is a stored report, an audit event and a structured log event; Phase 2 delivers no alert to a person (DV2-11). Links last at most as long as their share, by default exactly as long (DV2-13).

### Out of scope

Password-protected links, private rooms, room invites and QR pairing, read-only room links, multi-use invite links (Phase 4). Burn after download (Phase 3). Web admin console (Phase 4+). Malware scanning (Phase 6).

## 3. Existing system state (expected at start)

Phase 1: automatic local visibility on `ok` networks, network spaces and presence, fail-closed guards, text and file shares, downloads for devices on the network, "My uploads", request-time expiry, basic jobs, quotas, rate limits, realtime.

## 4. What will be changed

New link, code and abuse modules and routes. New share and code pages. The `link_only` share scope. Phase 2 migrations. `proxy.ts` header rules for share routes. Download service extended with the link-viewer path.

## 5. What will NOT be changed

- The local visibility rule from Phase 1 (DEC-031, DEC-032).
- Other local shares are **never** reachable through a share link (only the link's target share).
- No Supabase users for link viewers.
- No secrets in URL paths, logs or realtime payloads.

## 6. Architecture decisions involved

DEC-013, DEC-014, DEC-020 (link limits), DEC-024, DEC-025 (executable policy), DEC-031 (remote access only by link/QR/code), DEC-033 (creator-only links, no network-feed links, link-only posting).

## 7. Files / modules involved

See [05 §6 — Phase 2](../05-implementation-roadmap.md#phase-2). Key modules:

- `lib/server/links/{create.ts, unlock.ts, codes.ts, grants.ts, sessions.ts}`
- `lib/server/abuse/{reports.ts, takedown.ts}`, `lib/server/security/file-policy.ts`
- `components/{share, qr, report}/**`
- `app/(share)/{s/[linkId], c}/page.tsx`, `app/(legal)/**`

## 8. Database changes

- New tables: `share_links`, `link_sessions`, `link_grants`, `abuse_reports`.
- `shares.scope` gains `link_only`.
- New functions: `admin_block_share`, `admin_block_link` (each writes audit events).
- `end_share` extended to invalidate links.
- `purge-ephemeral` job clauses for sessions, grants and expired codes.

## 9. API changes

Phase 2 endpoints in [02 §6.2](../02-system-architecture.md#62-endpoint-catalogue-by-phase):

- `destination: "link_only"` on share and text creation.
- Link create/list/revoke (creator only), unlock, content, and viewer download/preview URLs.
- Code resolution.
- Abuse reports.

## 10. Security considerations

- Link secrets: 256-bit, fragment-only, stored as peppered HMACs, timing-safe comparison with the HMAC computed even when the link is missing.
- Short-code entropy and limits ([03 §4.4](../03-security-and-network-design.md#44-short-codes-dec-014)). Codes create grants and never reveal the secret.
- Viewer DTOs exclude space and room IDs, presence, devices and other shares (G4).
- Only the creator can create links, so nobody can export someone else's local post off the network.
- Unfurler safety: page GETs never change state and never expose content.
- QR codes are generated locally. No third-party QR APIs.
- Abuse: report intake with Turnstile, takedown runbook, per-link caps, executable policy.
- Link revocation takes effect on the next request. Outstanding presigned URLs live ≤ 60 s (RISK-009).

## 11. Dependencies

- **Phase:** Phase 1 VERIFIED.
- **Packages (to be approved):** a client-side QR library (for example `qrcode`, MIT).
- **Process:** a named operator for abuse reports (Q-022).

## 12. Testing requirements

- T-029 … T-033, T-035, T-036, the link part of T-011, T-012, and the link-related T-047 and T-049.
- IDOR matrix extended with link-viewer fixtures (this share / another share).
- E2E: sender on network A, viewer on network B. Link, QR (URL content), code, revoke, expiry. Link-only shares never appear on A's feed.
- Manual: QR scanning on iOS and Android camera apps, code entry on mobile keyboards (09 §8 scenarios 6–7).
- Takedown runbook rehearsal on staging.

## 13. Acceptance criteria

| ID | Criterion | Evidence |
|---|---|---|
| AC-2.1 | A viewer on another network opens a link, sees only that share, and downloads it. No other local content, space or presence data is reachable (T-029, E2E). | CI + E2E |
| AC-2.2 | Unknown link and wrong secret give identical 404s. State revealed only after the secret is proven (T-030). | CI |
| AC-2.3 | Revoked or expired links stop working on the next request (T-031) | CI |
| AC-2.4 | Short codes: normalization, expiry, limits, Turnstile escalation, never returning the secret (T-032) | CI |
| AC-2.5 | Unfurler simulation changes nothing and receives no share data (T-033) | E2E |
| AC-2.6 | A share-link QR code scanned by a phone on mobile data opens that share. Only the creator can create or revoke links (T-011). Link-only shares never appear on any network (T-012). | E2E + manual |
| AC-2.7 | An executable in an anonymous remote link is refused (T-035) | CI |
| AC-2.8 | Report → takedown via SQL function → link and share inaccessible, objects enqueued, audit written (T-036). Runbook rehearsed. | CI + rehearsal notes |
| AC-2.9 | Share and code pages carry `noindex` and `no-referrer`. No third-party requests from share pages (network log). | E2E capture |
| AC-2.10 | Legal page drafts published on staging. Operator contact defined. | Pages |
| AC-2.11 | Docs updated (authorization matrix with link viewers, data inventory, risks) | Doc diff |

## 14. Known risks

RISK-004, RISK-005, RISK-009, RISK-013 (links, QR and codes are the fallback when local mode misses a device), RISK-020.

## 15. Open questions

Q-010 (executables), Q-011 (ads), Q-022 (abuse/legal owner), Q-027 (anonymous link caps), Q-028 (no network-feed links).

**Answered 2026-10-16:** Q-010, Q-027 and Q-028, and Q-011 for Phase 2 (§19.1). Q-022 stays open.

## 16. Implementation status

| Date | Status | Note |
|---|---|---|
| 2026-09-17 | PLANNED | Scope plan drafted |
| 2026-09-23 | PLANNED | Takedown moved to SQL functions + runbook for this phase (no operator web endpoints before accounts/MFA in Phase 4) |
| 2026-09-23 | PLANNED | CR-001: room invites / QR pairing moved to Phase 4. Added creator-only links, link-only posting, and no network-feed links. |
| 2026-10-15 | IN PROGRESS | Owner instruction: implement Phase 2 now, on branch `phase-2-remote-sharing`. Task plan §17. |
| 2026-10-15 | **CODE COMPLETE / NEEDS REVIEW** | All in-repo tasks done and tested on the local stack (§18): pgTAP 189/189, unit and component 306/306, API integration 140/140, E2E 39/39, build, typecheck, lint and audit clean. Open: real-device QR scans, takedown rehearsal and legal pages on staging (§18.7), the assumed answers (§17.2), Q-022. **Not committed; not VERIFIED.** |
| 2026-10-16 | **CODE COMPLETE / NEEDS REVIEW** | Owner answered Q-010, Q-027, Q-028, Q-011 (for Phase 2), the link lifetime and abuse notification. Implementation reviewed against them (§19.3); three copy and wording mismatches fixed (§19.4); full suite re-run (§19.6). Real-device, staging and CI checks still pending (§19.5). **Not committed; not VERIFIED.** |

### Verification record

*Empty until verified.*

---

## 17. Detailed task plan (2026-10-15)

### 17.1 Starting conditions and owner decision

The owner instructed on 2026-10-15: *"Implement Phase 2 — Remote Secure Sharing … Work only in this new Phase 2 worktree/branch … Do not call Phase 2 VERIFIED merely because automated tests pass."* That overrides the rule that a phase starts only after the previous one is VERIFIED (05 §1). What is not in place, and how Phase 2 proceeds without it:

| Missing dependency | Consequence for Phase 2 |
|---|---|
| Phase 1 VERIFIED (it is NEEDS REVIEW) | Phase 2 builds on the Phase 1 code as committed (`538334d`) on a separate branch, `phase-2-remote-sharing`. The Phase 1 branch is not changed. |
| Phase 0 owner items (staging, Cloudflare, R2, hosting, CI run) | Built and tested **on the local stack only**, like Phase 1. Real-device QR scanning, the takedown rehearsal and published legal pages need staging. |
| Q-010, Q-011, Q-027, Q-028 | The owner's Phase 2 instruction states the answers for Q-010 (block executables in Free remote links), Q-027 (anonymous links under per-link caps) and Q-028 (no network-feed links). Q-011 follows from "no third-party scripts" on share pages. Recorded as **assumed answers** in §17.2; the owner confirms them. |
| Q-022 (named operator for abuse reports) | Reports are stored, audited and raised as an alertable log event; who receives them, and the published contact address, stay owner decisions. |
| Package approval (§11: a client-side QR library) | `qr` (paulmillr, MIT or Apache-2.0, no dependencies) is added for QR encoding in the browser. It also ships a decoder, which the tests use to prove what a code contains. |

### 17.2 Assumed answers (pending owner confirmation)

| Question | Assumed value | Where it lives |
|---|---|---|
| Q-010 Executables in anonymous remote links | **Blocked** for Free (every user in Phase 2): executables, scripts, installers and disk images. Archives allowed with a warning. Local shares unchanged (warning + confirmation). | `lib/server/security/file-policy.ts` |
| Q-011 Ads | None on share and code pages: no third-party scripts at all, except Cloudflare Turnstile when a check is actually required (code-guessing escalation, report form) | Pages, CSP |
| Q-027 Anonymous remote links | Allowed, under the Free caps: 30 links/hour per user, **500 download/preview URL issuances per link per day**, short codes ≤ 24 h | `lib/shared/plans.ts`, `lib/server/ratelimit/limits.ts` |
| Q-028 Network-feed links | **None.** A link targets exactly one share. | Schema (`target_type = 'share'` only), services |

**Answered 2026-10-16:** the owner accepted all four as assumed (Q-011 for Phase 2 only). This table stays as the record of what was assumed; the answers are in §19.1.

### 17.3 Deviations planned from the scope plan

| # | Planned | Built | Reason |
|---|---|---|---|
| DV2-1 | Start after Phase 1 VERIFIED | Started 2026-10-15 | Owner instruction (§17.1) |
| DV2-2 | Q-010/011/027/028 answered first | Assumed answers (§17.2) | Questions still open; each is a constant |
| DV2-3 | Cookie `__Host-link_session` | `__Host-link_session` (Secure) whenever the app origin is HTTPS, which staging and production must be; plain `link_session` without `Secure` on HTTP origins, which only local development and tests use | Browsers refuse `__Host-` and `Secure` cookies from plain-HTTP origins such as `http://127.0.0.1` |
| DV2-4 | `Idempotency-Key` on link creation (02 §6.1) | Not supported | A replay would have to return the link secret, which is never stored. A retried request creates a second link, which the creator can revoke. |
| DV2-5 | — | `POST /api/v1/links/{linkId}/code` regenerates a link's short code | "Generate new code" (03 §4.4) needs an endpoint; 02 §6.2 doesn't list one |
| DV2-6 | Server-side Turnstile: not in Phase 1 | `TURNSTILE_SECRET_KEY` is now used by the app (code escalation, reports), required in staging and production | Turnstile escalation and report intake need server-side verification |

Deviations found while implementing (2026-10-15):

| # | Planned | Built | Reason |
|---|---|---|---|
| DV2-7 | `lib/server/abuse/takedown.ts` | No TypeScript module: takedown is the two SQL functions only | No operator web endpoint before Phase 4, so nothing in the app calls them |
| DV2-8 | `qrcode` (example) | `qr` 0.7.2 (paulmillr; MIT or Apache-2.0; no dependencies) | `qrcode` pulls a CLI argument parser and a PNG library into production; `qr` also ships the decoder the tests use |
| DV2-9 | `share_links` per 04 §7.4 | `share_id` NOT NULL and `target_type` `share` only (Phase 4 widens both); adds `created_by_device_id`, `revoke_reason`, `short_code_pepper_version`; password columns wait for Phase 4 | Only share links exist; the reason tells "turned off" from "share ended" and "blocked"; codes rotate peppers separately |
| DV2-10 | `link_sessions.network_key` (rate-limit key); `abuse_reports.reporter_network_key`, `evidence_retained_until` | Not stored. Rate limits derive the network key per request. `abuse_reports` adds `reporter_kind`. | Data minimization; evidence retention waits for legal advice (Q-022, RISK-031) |
| DV2-11 | Operator notification | An alertable warn-level log event `abuse.report_received` (IDs and category only) plus the `report.created` audit event | No alert channel exists yet (DEC-029 monitoring, Q-022 operator); the event is what an alert watches |
| DV2-12 | One root layout with the app's providers | Route-group layouts: `(app)` (Supabase runtime), `(share)` (query client only), `(legal)` (none); `app/page.tsx` moved to `app/(app)/page.tsx` (same URL) | Share and code pages must never start a Supabase session (RISK-006, 03 §4.2) |
| DV2-13 | Link expiry: default 7 days (07 §1) | Default: until the share expires; options 1 h, 24 h, 7 days, never past the share (422 otherwise) | A link can't outlive its share, and local shares default to 24 h |
| DV2-14 | Code validity "never beyond the link's expiry" | Clamped to the link's expiry instead of refused | A 1-hour default code on a link with 30 minutes left should still work |
| DV2-15 | Daily cap on download-URL issuances | Download **and** preview URLs share the per-link cap (500 a day on Free) | Previews are full images and the same hosting-abuse vector |
| DV2-16 | — | Upload-restricted users can't create links either; `remote_links_enabled` off also stops link-only posting (creators can still list and revoke) | A restriction or a kill switch must not leave a way to send content off the network |
| DV2-17 | — | `ShareDto` gains `scope`; one Phase 1 pgTAP assertion ("link_only shares do not exist in Phase 1") became "a link_only share can never belong to a network space" | The scope now exists; the replacement assertion is as strict |
| DV2-18 | — | The sniffer flags Java and Android packages (ZIP whose first entry is the manifest) as executables, and `pkg`, `mpkg`, `appimage`, `xapk` join the installer extensions | 03 §7.4 lists APK/JAR and installers; on local shares this only adds a warning badge (stricter, not weaker) |
| DV2-19 | Turnstile escalation | Without Turnstile configured (local development), the escalation is a wait until the 10-minute window ends (429) | Fail closed when the check can't be offered |

**Accepted by the owner on 2026-10-16 (§19.1):** DV2-11 (no alert delivery in Phase 2) and DV2-13 (a link's maximum lifetime is its share's expiry).

### 17.4 Tasks

Test-first: each task starts with failing tests (pgTAP, Vitest unit or integration, Playwright).

| # | Task | Files | Tests |
|---|---|---|---|
| P2-01 | Phase 2 migration: `share_links`, `link_sessions`, `link_grants`, `abuse_reports`, scope `link_only`, `end_share` revokes links, purge clauses, `admin_block_share` / `admin_block_link`, kill switches `remote_links_enabled` and `short_codes_enabled` | `supabase/migrations/*_phase2_remote_sharing.sql` | `supabase/tests/phase2_remote_sharing.test.sql` |
| P2-02 | Environment: link and code peppers (versioned), Turnstile secret, test-only Turnstile verify URL | `lib/server/env.ts`, `.env.example`, local stack scripts | `env.test.ts` |
| P2-03 | Pure modules: link IDs, secrets and HMACs, short-code generation and normalization, remote file policy, link-session cookies, Turnstile verification, viewer DTO | `lib/server/links/*`, `lib/shared/short-code.ts`, `lib/server/security/{file-policy,turnstile}.ts` | Unit tests |
| P2-04 | Services: link create/list/revoke/code, unlock, grants, code resolution with failure limits, viewer content/download/preview, link-only shares, abuse reports | `lib/server/{links,abuse,shares,policy}/**` | Integration |
| P2-05 | API routes (02 §6.2, Phase 2 rows) | `app/api/v1/**` | IDOR matrix (extended with link-viewer actors) |
| P2-06 | Integration harness and tests: viewer cookie jar, Turnstile stub | `tests/integration/**` | T-011, T-012, T-029 … T-033 (API part), T-035, T-036, T-047, T-049 |
| P2-07 | Client: separate layouts so share pages never start a Supabase session; viewer API client and queries; composer destination; share-link dialog with QR and code; report dialog; share page `/s/[linkId]`; code page `/c`; legal drafts | `app/**`, `components/{share,qr,report}/**`, `lib/client/**` | Component tests |
| P2-08 | E2E: sender on network A, viewer on network B: link, QR (decoded), code, revoke, expiry, link-only, unfurler, takedown, no third-party requests | `tests/e2e/local-remote-sharing.spec.ts` | AC-2.1, 2.5, 2.6 (URL content), 2.9 |
| P2-09 | Docs: ARCHITECTURE.md, 02, 03, 04, 05, 06, 07, 08, 09, README; takedown and kill-switch runbooks; manual QR/code procedure | `project-docs-workthrough/**` | Link check |

---

## 18. Implementation record (2026-10-15)

### 18.1 Implementation log

| Task | Result | Evidence |
|---|---|---|
| P2-01 Migration | `20261015180000_phase2_remote_sharing.sql`: `share_links` (16-character IDs, 32-byte secret and code HMACs with pepper versions, unique live codes, a trigger that refuses a link outliving its share), `link_sessions`, `link_grants` (≤ 12 h, by check constraint), `abuse_reports`; `shares.scope` allows `link_only`; `downloads` and `audit_events` accept link viewers (`downloads.link_id`); `end_share` revokes the share's links and clears their codes; `purge_ephemeral` deletes expired grants, sessions 24 h after expiry, and clears expired codes; `admin_block_share` / `admin_block_link` (audited, resolve reports, no grant to `app_server`); kill switches `remote_links_enabled`, `short_codes_enabled`. Applied from scratch with `supabase db reset`. | pgTAP **55/55** (`phase2_remote_sharing.test.sql`), and all 189 with Phase 0 and 1 |
| P2-02 Environment | `LINK_PEPPER`, `CODE_PEPPER` (≥ 32 characters, different from each other, placeholder check), `*_PREVIOUS` with `PEPPER_VERSION` for rotation, `TURNSTILE_SECRET_KEY` (needs the site key), `TURNSTILE_VERIFY_URL` (refused in production builds and deployments). All three secrets required in staging and production. `.env.example` and `pnpm stack:env` updated. | `env.test.ts` (34 tests, 6 new) |
| P2-03 Pure modules | `lib/shared/short-code.ts` (Crockford alphabet, normalization, display); `lib/server/links/secrets.ts` (96-bit IDs, 256-bit secrets, link-bound HMAC, timing-safe verification that computes the HMAC even for a missing link, code HMACs per pepper); `links/cookies.ts` (DV2-3); `security/file-policy.ts`; `security/turnstile.ts` (fails closed, no client IP sent, hostname check); APK/JAR sniffing and installer extensions (DV2-18) | Unit tests: `short-code`, `link-secrets`, `link-cookies`, `file-policy`, `turnstile`, `sniff`, `visibility` |
| P2-04 Services | `links/create.ts` (create, list, revoke, regenerate code; creator only, from any network; `FOR SHARE` lock so `end_share` revokes a racing link), `links/unlock.ts`, `links/sessions.ts` (never adopts a client-chosen session), `links/grants.ts` (every viewer request re-checks session, grant, link and share), `links/codes.ts` (failure-only counting, Turnstile escalation, 24-hour block, global alert), `links/viewer.ts` (viewer DTO, file URLs scoped to the link's share, daily cap, download log), `abuse/reports.ts`; link-only posting in `policy/posting.ts`, `shares/{create,text,complete}.ts`; `network/requester.ts` (rate-limit key without local-mode flags) | Integration suites below |
| P2-05 API | 9 route files, 10 handlers (02 §6.2 Phase 2 rows plus DV2-5): `POST/GET /shares/{id}/links`, `DELETE /links/{id}`, `POST /links/{id}/code`, `POST /links/{id}/unlock`, `GET /links/{id}/content`, `POST /links/{id}/files/{fileId}/download-url` and `…/preview-url`, `POST /codes/resolve`, `POST /reports` | IDOR matrix coverage test (every route and method) |
| P2-06 Integration | Viewer helper with a cookie jar, a local stand-in for Turnstile's siteverify, the server log captured to a file. New: `remote-links.test.ts` (23), `short-codes.test.ts` (10), `abuse.test.ts` (7), `remote-hygiene.test.ts` (6); a link-only Realtime test; the IDOR matrix gained two actors (viewer of this share, viewer of another share) and nine routes | **140/140** (11 files) |
| P2-07 Client | Layout split (DV2-12); `lib/client/viewer-api.ts`, `queries/links.ts` (30 s polling, a 404 or 410 replaces cached content); composer destination; `components/share/{share-link-dialog,shared-view,code-entry,viewer-shell,copy}`, `components/qr/share-qr` (local SVG), `components/report/{report-dialog,report-link-form}`; legal drafts `/terms`, `/privacy`, `/acceptable-use`, `/report` with a draft notice and `[OWNER]` placeholders; status copy now points to Link only; `components/ui/input.tsx` from the shadcn CLI | Component tests: `remote-ui` (9), `share-qr` (2) |
| P2-08 E2E | `tests/e2e/local-remote-sharing.spec.ts`: 9 scenarios on the STACK server, each viewer a separate browser that never opens the app | **9/9**, and 39/39 with Phases 0 and 1 |
| P2-09 Docs | This file, [manual procedure](phase-2-manual-verification.md), [takedown](../runbooks/takedown.md) and [kill-switch](../runbooks/kill-switches.md) runbooks, ARCHITECTURE.md, 02, 03, 04, 05, 06, 07, 08, 09, README, `infra/cloudflare/README.md` | Link check |

**Test totals (local, 2026-10-15, after `supabase db reset`):** typecheck and lint clean. Vitest unit + component **306/306** (40 files; Phase 1 had 252). pgTAP **189/189** (28 + 106 + 55). API integration **140/140** (11 files; Phase 1 had 83). Playwright **39/39** (13 Phase 0 + 17 Phase 1 + 9 Phase 2). `pnpm build` clean. Generated database types unchanged by `pnpm db:types` after the reset. `pnpm audit --audit-level high`: no unreviewed findings (the one ignored advisory is Phase 1's `braces`, F1-6). CI has not run this branch (no pull request).

### 18.2 Findings during implementation

| # | Finding | Action |
|---|---|---|
| F2-1 | `app_owner` has no `USAGE` on the `extensions` schema, so it can't create a `citext` column; the first apply of the migration failed (in one transaction, nothing applied). | `abuse_reports` is created by the migration role and handed to `app_owner`, like the Phase 1 tables that reference `auth.users`. |
| F2-2 | TanStack Query keeps the last successful data after a refetch fails, so an ended link's content would stay in memory behind the "ended" message. | The content query resolves 404 and 410 into an "ended" result that replaces the content and stops polling; the link's previews are removed (DEC-034 rule 4). |
| F2-3 | Browsers don't accept `__Host-` or `Secure` cookies from `http://127.0.0.1`. | DV2-3. |
| F2-4 | The React lint rules forbid reading the clock during render and setting state synchronously in an effect. | The share page derives its phase from the unlock result and the query instead of mirroring it in state; the dialog reads the clock once when it opens. |
| F2-5 | Takedown queues the files for deletion, but until the Phase 3 janitor nothing runs the outbox except the app's sweep after creator deletes; and nothing preserves evidence where the law requires it. | The function returns the object keys and hold times; the runbook covers manual deletion and the child-safety caution. RISK-031. |
| F2-6 | Every new integration test passed on its first run, so its strength was unproven. | Mutation check: two deliberate faults (any secret unlocks; a file of another share is reachable through a grant) made four integration tests fail (T-030, T-029, the unlock limit); both were reverted from byte copies and the build was redone. |

### 18.3 Acceptance criteria status

| AC | Status | Evidence / what is missing |
|---|---|---|
| AC-2.1 | ✅ Met on the local stack | `remote-links.test.ts` (viewer DTO keys, no space/creator/device IDs or other shares; grant scoped to one link and its share's files; no local API), IDOR matrix (viewer actors on every route), E2E "a viewer on another network…" and "files…". Real R2 download: manual R-1. |
| AC-2.2 | ✅ Met | Identical 404 bodies for wrong secret, unknown and malformed link IDs, no cookie; comparable median timing; 410 only after the secret is proven (`remote-links.test.ts`) |
| AC-2.3 | ✅ Met | Revoked, expired, share-ended and expired-share cases on the next request (`remote-links.test.ts`), E2E turn-off and expiry |
| AC-2.4 | ✅ Met on the local stack | `short-codes.test.ts` (normalization, expiry, replacement, revocation, 5-failure Turnstile escalation per network and per session, single-use tokens, 24-hour block, kill switch, secret never returned), unit tests, E2E code flow. Real Turnstile and phone keyboards: manual K-2 … K-4, R-2. |
| AC-2.5 | ✅ Met | E2E unfurler test (three bot user agents, generic metadata, no cookie, unlock count unchanged); integration: identical page for existing, unknown and malformed link IDs, no session rows created |
| AC-2.6 | ⚠️ Partly met | Met: QR content (component test decodes the rendered SVG; E2E decodes the creator's QR and opens it on another network), creator-only links (IDOR matrix, T-011), link-only never on a network (`remote-links.test.ts`, Realtime test, pgTAP, E2E). **Blocked:** scans with iOS and Android camera apps (manual Q-1 … Q-7). |
| AC-2.7 | ✅ Met | `remote-links.test.ts`: executable → 422 `REMOTE_FILE_BLOCKED` at link creation, by name at link-only upload start and by content at completion; local behaviour unchanged |
| AC-2.8 | ⚠️ Partly met | Met in CI terms: `abuse.test.ts` (report → `admin_block_share` → link, code, local and My uploads access gone, object queued, audit, report resolved; `admin_block_link`; the app role can't call either), pgTAP, E2E takedown. Runbook written. **Blocked:** rehearsal on staging with a named operator (manual T-1 … T-5, Q-022). |
| AC-2.9 | ✅ Met on the local stack | `remote-hygiene.test.ts` (`/s` and `/c`: `no-store`, `noindex`, `no-referrer` headers and meta tags, strict CSP), E2E network log on share pages (only the app and storage), zero CSP violations, no Supabase calls from viewers |
| AC-2.10 | ❌ Blocked | Drafts exist with the draft notice; publishing on staging needs staging; the operator contact is Q-022 (manual L-1 … L-3) |
| AC-2.11 | ✅ Met, pending owner review | Authorization matrix with link viewers (03 §9 as built, IDOR matrix), data inventory (03 §13), risks (06), this record |

### 18.4 Security review notes (self-review, 2026-10-15)

| Area | How it is handled | Tested by |
|---|---|---|
| Secret leakage | Secret only in the fragment and the unlock body; stored as HMAC; never logged (the logger also redacts fragments and keys named like secrets); never in Realtime; the URL is built from `NEXT_PUBLIC_APP_ORIGIN`, never the request's Host | Full statement logging and server-log scan (`remote-hygiene.test.ts`); pgTAP/integration HMAC-only checks |
| Timing | HMAC computed and compared even for unknown links (dummy HMAC) | Median comparison (`remote-links.test.ts`) |
| IDOR | Grants per (session, link); file URLs filtered by the link's share; creator actions behind `requireOwnShare` and the link's creator | IDOR matrix, mutation check (F2-6) |
| Session fixation | A presented cookie is reused only if its hash is a live stored session; `__Host-` in deployments | "a session is never adopted" test |
| CSRF | Viewer mutations are POST JSON with the exact Origin check; the cookie is SameSite=Lax; `GET /content` changes nothing | `withApi` tests (Phase 1), unfurler tests |
| Unfurlers | The share page is the same static shell for any link ID; GETs never touch the database | E2E and integration |
| Brute force | Unlock: 30/10 min per link, 60/10 min per network key. Codes: failure counters, Turnstile, 24-hour block, global alert | `remote-links`, `short-codes` tests |
| Abuse | Executable policy, per-link daily cap, reports, takedown, kill switches | `remote-links`, `abuse` tests |
| Residual | Link holders can forward links until revoked (inherent); presigned URLs live 60 s (RISK-009); takedown bytes and evidence (RISK-031); code guessing across many networks (RISK-030) | — |

### 18.5 What changed outside Phase 2 scope, and why

- **Phase 1 behaviour kept:** local feeds still exclude anything that isn't `scope = 'network'`; local shares still allow flagged files with a badge; the Phase 1 integration, E2E and pgTAP suites still pass. Additive changes only: a `scope` field on share DTOs, "Share link" and "Report" buttons on posts, a footer with the code page and legal links, Link only in the composer, and the network-off copy pointing to Link only.
- **No Phase 3+ work:** no janitor, no burn-after-download, no passwords, rooms, invites, QR pairing, room links, web admin, malware scanning or billing.

### 18.6 Assumed answers and owner decisions still open

The four assumed answers (§17.2: Q-010, Q-011, Q-027, Q-028) and Q-022 (operator and legal contact), plus the copy (share page, dialogs, legal drafts) need the owner's review. The legal drafts carry `[OWNER: …]` placeholders where a decision is missing.

**Update 2026-10-16:** the four assumed answers are answered (§19.1). Still open: Q-022 and the copy review.

### 18.7 What blocks VERIFIED

*Superseded by §19.5 (2026-10-16); kept as the 2026-10-15 record.*

| Item | Needs |
|---|---|
| AC-2.6 real QR scans | Staging and two phones ([manual procedure](phase-2-manual-verification.md) §3) |
| AC-2.8 takedown rehearsal | Staging and a named operator (§5, Q-022) |
| AC-2.10 legal pages on staging, operator contact | Staging; Q-022 (§6) |
| Real R2 and real Turnstile behaviour | Staging (§7), SP-02 |
| CI | A pull request and a green run (Phase 0 AC-0.1) |
| Phase 1 | Still NEEDS REVIEW; Phase 2 sits on top of it |
| Owner review | Assumed answers, copy, this record |

---

## 19. Owner decisions and final review (2026-10-16)

On 2026-10-16 the owner answered the Phase 2 questions and asked for the implementation to be checked against the answers: *"Finalize Phase 2 based on the following owner decisions … Do not assume the code is correct just because tests pass … Do NOT start Phase 3. Do NOT commit or push."* Sections 1–18 stay as written. This section records the answers, the review, the fixes and the new evidence.

### 19.1 Decisions applied

| Decision | Owner's answer (2026-10-16) | As built | Recorded in |
|---|---|---|---|
| Q-010 Remote executable policy | Accept. For anonymous/Free remote sharing, block executables, scripts, installers and disk images. Archives stay allowed with the existing warning. Local Phase 1 sharing is unchanged. | As assumed in §17.2 (`lib/server/security/file-policy.ts`). No code change. | 06 Q-010, DEC-025; 03 §7.4; 07; ARCHITECTURE §9.1 |
| Q-011 Advertising | Accept: no advertising in Phase 2. Remote sharing stays ad-free. No ad system is built. | No ads, and no third-party script except Turnstile when a check is needed. No code change. Ads after Phase 2 are not decided. | 06 Q-011, DEC-024; 07 §8 |
| Q-027 Anonymous remote-link limits | Accept the conservative design as implemented. Don't loosen any limit; add one only if security requires it. | Unchanged. Values in §19.2. No limit added; two consequences are recorded as RISK-032 and RISK-033. | 06 Q-027; 03 §10; ARCHITECTURE §5.8 |
| Q-028 Network-feed links | Accept. A link exposes only its share: never a network feed, a network space, other users' local shares, presence, device lists or network identifiers. Link-only shares stay out of all local feeds. | Unchanged. Checked in §19.3 (rows 2, 3 and 6). | 06 Q-028, DEC-033; ARCHITECTURE §9.1 |
| Link expiry | The share's expiry is the maximum lifetime. A link never outlives its share. No separate 7-day limit is needed. | Unchanged (DV2-13). A link lasts until its share expires unless a shorter option (1 h, 24 h, 7 days) is chosen and fits. The service, a database trigger and every viewer request enforce it. | 06 DEC-013; 07 Phase 2 note; ARCHITECTURE §9.2 |
| Abuse notification | A report is stored, audited and logged as a structured event, and takedown is available. Don't claim that a human alert channel exists, and don't build one. Q-022 and operator alerts stay future operational requirements. | Code unchanged. Copy and wording that promised a review or called the log event a notification were corrected (§19.4). | 06 Q-022; 08 §8; [takedown runbook](../runbooks/takedown.md) §1; [manual procedure](phase-2-manual-verification.md) T-1, L-3; 03 §7.6, §14; ARCHITECTURE §9.7 |

The planned "Default 7 days" for links (07 §1) and "operator notification" (§2) stay in the documents as the historical plan. DV2-13 and DV2-11 are now accepted deviations.

### 19.2 Accepted limits as implemented (Q-027)

From `lib/server/ratelimit/limits.ts`, `lib/server/links/codes.ts`, `lib/shared/plans.ts` and `lib/server/storage/s3.ts`. Every `429` carries `Retry-After`.

| What | Limit | Counted per |
|---|---|---|
| Create a link | 30 per hour | User |
| List a share's links | 60 per minute | Device |
| Revoke a link | 60 per minute | User |
| New short code | 30 per hour | User |
| Unlock a link | 30 per 10 minutes (every attempt, RISK-033), and 60 per 10 minutes | Link, and network key |
| Viewer content (polling) | 60 per minute | Link session |
| Viewer download and preview URLs | 120 per minute, and **500 per day** (downloads and previews together, UTC days, from the link's entitlement snapshot) | Link session, and link |
| Wrong short codes | 5 in 10 minutes: Turnstile for every further attempt (`403 TURNSTILE_REQUIRED`; where Turnstile isn't configured, a `429` wait). 20 in a day: a 24-hour block (`429`). 1,000 in 10 minutes across everyone: error log `code.resolve_failure_spike`. Successful resolutions are not counted (RISK-032). | Network key or link session; network key; everyone |
| Abuse reports | 10 per hour, and 10 per hour; Turnstile on every report wherever it is configured (required in staging and production) | Network key, and reporter (device or link session) |
| Link-only posting | The Phase 1 posting limits: 30 file shares per hour per user; 2 GB a day per user and 10 GB a day per network key; text 60 per minute per user and 300 per minute per network key | As in Phase 1 |
| Lifetimes | Link: until the share expires, or 1 h / 24 h / 7 days if that fits. Short code: 10 minutes, 1 hour (default) or 24 hours, never past the link. Grant: at most 12 hours, never past the link or the share. Session cookie: 12 hours. Download URL: 60 s. Preview URL: 300 s. | — |
| Kill switches | `remote_links_enabled` off: link creation, link-only posting, unlocking, viewer content and file URLs, new codes, code resolution and reports from link viewers answer `503`; creators can still list and revoke links. `short_codes_enabled` off: new codes and resolution answer `503`; links keep working. Both take effect within 30 s (`RUNTIME_FLAGS_CACHE_SECONDS`). | — |

### 19.3 Implementation review against the decisions

The review read the code paths, not only the test results. "Tests" names the automated checks that fail if the rule breaks.

| # | Check | What the code does | Tests | Result |
|---|---|---|---|---|
| 1 | Remote executable policy | `file-policy.ts` blocks the `executable` (installers included), `script` and `disk_image` flags unless the plan has `executablesInRemoteLinks`, which no plan has in Phase 2. Applied at link creation (every verified file), at link-only upload start (by name), at upload completion (by content), and again for every viewer URL. Archives pass with their flag, and the share page asks before downloading them. Local shares never consult the policy. | `file-policy.test.ts` (all four categories, archives, the Pro flag); `remote-links.test.ts` T-035 (3); E2E archive confirmation | ✅ Matches. Note: DV2-18 widened detection (`pkg`, `mpkg`, `appimage`, `xapk`, and Java and Android packages by content), so on local shares these files now get Phase 1's existing warning and confirmation. Nothing is blocked locally. |
| 2 | Link-only visibility | `scope = 'link_only'`, with a database check that such a share never has a network space. The visibility rule shows it only to its creator, the local feed selects `scope = 'network'` only, and the Realtime trigger signals network shares only. | `remote-links` T-012 (2); `realtime` link-only test; pgTAP; `visibility.test.ts`; E2E link-only | ✅ Matches |
| 3 | Network-feed isolation | `share_links.target_type` allows only `share`, and `share_id` is required. No endpoint creates a link to a feed or a space. | pgTAP; viewer DTO key test; IDOR matrix | ✅ Matches |
| 4 | Creator-only links | Creating, listing, revoking and new codes go through `requireOwnShare` and the link's creator. Other devices on the network get `403 NOT_CREATOR`, other networks `404`, callers without a session `401`. Upload-restricted users can't create links. | `remote-links` T-011 (2); IDOR matrix (every route × 9 actors) | ✅ Matches |
| 5 | Link expiry | The default is the share's expiry; a chosen expiry must fit (`422` otherwise); the `check_link_expiry` trigger backs it up. Codes end at `least(code, link)`, grants at `least(12 h, link, share)`, and every viewer request checks both expiries. | `remote-links` (expiry, T-031, T-041); `short-codes` (codes never outlive their link); pgTAP | ✅ Matches |
| 6 | Viewer isolation | Viewers have no Supabase user and no Realtime. The viewer DTO has exactly `link`, `access` and `share` (kind, expiry, text, files). Grants are per (session, link), and file URLs only cover the link's share. The local API answers viewers `401`. A session ID is never adopted from the browser. | `remote-links` T-029 (3, including the exact DTO keys and the absence of space, user and device IDs, other shares and the uploader's label); IDOR matrix; E2E viewer test | ✅ Matches |
| 7 | Short-code limits | As §19.2: failures only, Turnstile escalation, 24-hour block, global log event. A code never returns the link secret. | `short-codes` (10) | ✅ Matches the accepted design. Gap: successful resolutions have no limit of their own (RISK-032). Not changed, because that would add a limit. |
| 8 | Rate limits | As §19.2 | Unlock limit, daily cap, report limit and code limits in the integration tests; the shared limiter in the Phase 1 tests | ✅ Matches. Consequence: the unlock limit counts every attempt (RISK-033). Not changed, because counting only failures would loosen it. |
| 9 | Kill switches | As §19.2. If the flags can't be read, the request fails. A deleted flag row reads as "on" (the Phase 1 convention in `flags.ts`); the migration creates both rows. | `remote-links` kill switch; `short-codes` kill switches (2) | ✅ Matches |
| 10 | Abuse reporting and takedown | Anyone who can see a share can report it. Reports are stored, audited and logged, with Turnstile and limits. `admin_block_share` and `admin_block_link` end access at once, revoke links and codes, queue objects, resolve reports and write audit events; the app's database role can't run them. No alert is sent. | `abuse` (7); pgTAP; E2E takedown | ✅ Code matches. **Mismatches fixed:** user-facing copy promised a review (§19.4). |
| 11 | Secret handling | A 256-bit secret, only in the fragment. Stored as an HMAC under a versioned pepper, bound to the link ID, and compared timing-safely (against a dummy HMAC for unknown links). Returned once and kept only in the dialog's state; removed from the address bar after unlocking. Codes never return it. Session cookies are stored as SHA-256. | `remote-links` (HMAC only, identical 404s, timing); `short-codes`; `link-secrets` and `link-cookies` unit tests | ✅ Matches |
| 12 | Logging and redaction | Logs carry link IDs, never secrets, codes or cookies. Validation errors name fields, never values. Report logs carry IDs and the category only. | `remote-hygiene` (the server log and the full database statement log scanned for secrets and codes); `abuse` log-line test | ✅ Matches |
| 13 | R2 and download authorization | Viewer URLs only for verified files of the link's share, after the file policy, the preview check, the per-session limit and the daily cap. Presigned for 60 s, downloaded as an attachment. Object keys contain no network or share IDs. Each URL is logged in `downloads` without viewer identity. | `remote-links` (grant scope, daily cap, attachment header); E2E download | ✅ Matches on RustFS. Real R2 is pending (R-1). |
| 14 | Phase 1 regression | The Phase 1 tests are unchanged, apart from DV2-17's one replaced pgTAP assertion, and they all pass (§19.6). | Every suite | ✅ Matches |

### 19.4 Mismatches found and fixed

| # | Mismatch | Fix | Regression test |
|---|---|---|---|
| M-1 | The report dialog's confirmation said *"We'll review it."* Nothing alerts anyone, so nothing makes sure a review happens. | Now: *"Your report was recorded. We don't tell the person who shared it who reported it."* (`components/report/report-dialog.tsx`) | `remote-ui.test.tsx`: the confirmation says the report was recorded and doesn't mention a review. It failed before the fix. |
| M-2 | The report page draft said *"A person reviews every report"* and that child-safety reports *"are handled first and reported to the authorities"*. Both are processes that need Q-022's operator. | Now: every report is recorded with the share it is about. Who reviews reports, how fast, how child-safety reports are handled, and the contact address moved into the `[OWNER]` placeholder (`app/(legal)/report/page.tsx`). | `remote-ui.test.tsx`: the page makes no review promise and carries the placeholder. It failed before the fix. |
| M-3 | Code comments and documents called `abuse.report_received` "the operator notification" that an alert "watches". | Reworded as a structured log event that a future alert will watch: `lib/server/abuse/reports.ts`; `tests/integration/abuse.test.ts` (a comment and a test name only); the takedown runbook §1; the manual procedure T-1 and L-3; 03 §7.6 and §14; 08 §8; ARCHITECTURE §5.7 and §9.7. | None needed: no behaviour changed. |

Not changed: RISK-032 and RISK-033 (fixing either would add or loosen a limit, which is the owner's call); DV2-18 (only stricter local warnings); the flag-row default (a Phase 1 convention).

### 19.5 Verification levels and what blocks VERIFIED

| Level | Status | Evidence, or what is missing |
|---|---|---|
| Implemented locally | ✅ | Branch `phase-2-remote-sharing`, not committed |
| Automated-test verified (local stack) | ✅ 2026-10-16 | §19.6 |
| CI verified | ❌ | No pull request; the workflow has never run on this branch |
| Staging verified | ❌ | No staging environment exists (Phase 0 owner items) |
| Real-device verified | ❌ | QR codes are decoded from the rendered page in tests, never scanned by a phone |
| Production verified | ❌ | Nothing is deployed |

Pending, and not to be faked ([manual procedure](phase-2-manual-verification.md)):

| Item | Steps | Blocks |
|---|---|---|
| Real iPhone QR scan | Q-1 … Q-3, Q-5 … Q-7 | AC-2.6 |
| Real Android QR scan | Q-4 | AC-2.6 |
| Short codes typed on real phone keyboards | K-1 … K-4 | AC-2.4 (manual part) |
| Takedown rehearsal on staging, with a named operator | T-1 … T-5 | AC-2.8 |
| Legal pages on staging, and the operator contact | L-1 … L-3 | AC-2.10 |
| Real R2 | R-1 | AC-2.1 (staging part) |
| Real Turnstile | R-2 | AC-2.4 (staging part) |
| CI | A pull request and a green run | Phase 0 AC-0.1 |
| Copy review | Share page, dialogs, legal drafts | AC-2.11 (owner review) |
| Phase 1 | Still NEEDS REVIEW | Phase 2 builds on it |

**Status stays CODE COMPLETE / NEEDS REVIEW.** AC-2.6, AC-2.8 and AC-2.10 can't be met without staging, phones and Q-022.

### 19.6 Test evidence (2026-10-16)

Run on the local stack after the fixes in §19.4, on 2026-10-16:

| Check | Command | Result |
|---|---|---|
| Typecheck | `pnpm typecheck` | Clean |
| Lint | `pnpm lint` | Clean |
| Unit and component | `pnpm test` | **307/307** in 40 files (306 before; one new test for the report page) |
| Database | `pnpm db:reset`, then `pnpm db:test` | **189/189** pgTAP assertions (28 + 106 + 55) |
| Generated types | `pnpm db:types` after the reset | The file still differs from `HEAD` only by the 60 Phase 2 lines; the migration hasn't changed since the types were generated. No drift. |
| Production build | `pnpm build` | Clean, no warnings |
| API integration | `pnpm test:integration` | **140/140** in 11 files |
| End-to-end | `pnpm test:e2e` | **39/39**: 13 Phase 0, 17 Phase 1, 9 Phase 2 |
| Dependency audit | `pnpm audit --audit-level high` | No unreviewed findings; the one ignored advisory is Phase 1's `braces` (F1-6) |
| Documentation links | Relative links and anchors under `project-docs-workthrough/` and `infra/` | 25 files and 1 file, 0 broken |

Phase 1: its suites are part of every run above and all pass. No Phase 1 test was removed or weakened; DV2-17's replaced pgTAP assertion is still the only change to one. CI has not run (§19.5).
