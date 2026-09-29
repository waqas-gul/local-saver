# Phase 2 — Remote Secure Sharing

| Field | Value |
|---|---|
| **Status** | **PLANNED** (detailed scope). Not started. |
| Plan depth | Scope-level plan. A task-by-task plan is written after Phase 1 is VERIFIED. |
| Depends on | Phase 1 VERIFIED. Q-010, Q-011, Q-027, Q-028 answered. |
| Unblocks | Phase 3 |
| Release | **Invite-only beta** after VERIFIED |
| Last updated | 2026-09-23 |

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

## 16. Implementation status

| Date | Status | Note |
|---|---|---|
| 2026-09-17 | PLANNED | Scope plan drafted |
| 2026-09-23 | PLANNED | Takedown moved to SQL functions + runbook for this phase (no operator web endpoints before accounts/MFA in Phase 4) |
| 2026-09-23 | PLANNED | CR-001: room invites / QR pairing moved to Phase 4. Added creator-only links, link-only posting, and no network-feed links. |

### Verification record

*Empty until verified.*
