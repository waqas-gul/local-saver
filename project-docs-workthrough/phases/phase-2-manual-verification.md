# Phase 2 — Manual and staging verification procedure

| Field | Value |
|---|---|
| Purpose | Close the Phase 2 acceptance criteria that need real devices, staging or the owner: **AC-2.6 (real QR scans), AC-2.8 (takedown rehearsal), AC-2.10 (legal pages on staging, operator contact)**, plus the real-R2 and real-Turnstile parts of AC-2.1 and AC-2.4 ([phase 2 §13](phase-2-remote-sharing.md#13-acceptance-criteria)) |
| Status | **BLOCKED.** Nothing here has been run. The prerequisites (§1) don't exist yet. |
| Written | 2026-10-15 |
| Who runs it | The owner or a tester the owner names, with a laptop, an iPhone and an Android phone |
| Rule | Record what actually happened, including failures. Emulated phones, local runs and decoded QR images are **not** evidence for these steps. |

The automated checks that already cover parts of these criteria are listed in [phase 2 §18.3](phase-2-remote-sharing.md#183-acceptance-criteria-status). They don't replace any step below.

---

## 1. Prerequisites

Everything in [Phase 1's prerequisites](phase-1-manual-verification.md#1-prerequisites-owner-items) (P-1 … P-7: domain, Cloudflare, staging host, staging Supabase, staging R2, egress lists, Access, devices), plus:

| # | Prerequisite | Where it's specified |
|---|---|---|
| P2-1 | The staging build of this phase with `LINK_PEPPER`, `CODE_PEPPER` and `TURNSTILE_SECRET_KEY` set (the boot refuses to start without them) | [08 §9](../08-deployment-and-operations.md#9-configuration-inventory) |
| P2-2 | The Turnstile widget's hostnames include the staging hostname | [infra/cloudflare/README.md](../../infra/cloudflare/README.md) |
| P2-3 | Cloudflare Access must **not** block `/s/*`, `/c` and `/api/v1/links/*`, `/api/v1/codes/*`, `/api/v1/reports` for the viewer devices (or the viewers pass Access too) | 08 §3 |
| P2-4 | A named operator with dashboard access for the takedown rehearsal (Q-022) | [takedown runbook](../runbooks/takedown.md) |

## 2. Recording sheet

Copy into `evidence/phase-2/manual-matrix.md`; one row per step and device; screenshots under `evidence/phase-2/manual/`. Never record IP addresses, link secrets or share codes in the evidence: blur them in screenshots.

| Date | Step | Device / OS / browser (version) | Network type | Expected | Observed | Pass? | Notes |
|---|---|---|---|---|---|---|---|

## 3. QR codes on real phones (AC-2.6)

**A** = laptop on Wi-Fi 1, posting. **B** = iPhone, **C** = Android phone, both on **mobile data** (Wi-Fi off), so they are on another network.

| Step | Action | Expected |
|---|---|---|
| Q-1 | On A, post a text and a photo. On the photo's card, "Share link" → "Create link". | The dialog shows the link, a QR code, the expiry and "Anyone who scans this can open the share." |
| Q-2 | On B, open the **Camera** app and point it at the QR code on A's screen. Open the suggested link. | Safari opens the share page with the photo; no app sign-in, no "This network" view. After it loads, the address bar shows `/s/…` **without** `#k=`. |
| Q-3 | On B, tap Download. | The photo downloads with its name and opens (Files or Photos). |
| Q-4 | Repeat Q-2 and Q-3 on C with the **Camera** app (or Google Lens if the camera has no QR reader). | Same as Q-2 and Q-3 in Chrome. |
| Q-5 | On B, reload the page. | The share shows again (this browser's access lasts up to 12 hours). |
| Q-6 | On A, "Turn off" the link. On B and C, switch to another app and back (or wait 30 s). | Both show "This link has ended"; the photo is gone from the page. |
| Q-7 | On A, check that the photo's post is still on A's network feed. | Turning off a link doesn't delete the share. |

## 4. Share codes on phone keyboards (AC-2.4 manual part, 09 §8 scenario 7)

| Step | Action | Expected |
|---|---|---|
| K-1 | On A, create a link with "Also make a share code". | A code like `7KQ4M-X9D2P` and its expiry are shown. |
| K-2 | On B, open `https://<staging-host>/c` and type the code with the phone keyboard: lower case, with a space instead of the hyphen. | The share opens. Autocorrect and auto-capitalization didn't get in the way (note anything that did). |
| K-3 | On C, type the code with the letter O instead of zero and L instead of 1 where they occur. | The share opens. |
| K-4 | On C (new private tab), enter six wrong codes in a row. | After the fifth wrong code, a Turnstile check appears before the next attempt; after solving it, a correct code still works. |

## 5. Takedown rehearsal (AC-2.8)

| Step | Action | Expected |
|---|---|---|
| T-1 | On B, open a link from A and press Report → "Spam" → Send. | "Thanks for reporting". The server log has `abuse.report_received` with the report ID, and the triage query (runbook §2) lists the report. No alert reaches a person in Phase 2 (owner decision 2026-10-16, Q-022): don't record a delivery. |
| T-2 | Operator follows the [takedown runbook](../runbooks/takedown.md) §2–§3 to block the share. | The function returns the share as `blocked` and the queued object keys. |
| T-3 | On B, return to the share page; on A, look at the feed and My uploads. | B: "This link has ended". A: the share is gone. |
| T-4 | Operator follows §4 (storage) and records how long until the R2 object is gone, and by which path (sweep, manual delete, lifecycle). | The object is gone; the time is recorded. |
| T-5 | Operator checks the audit query in §7. | `admin.block` with the operator's name and reason. |

## 6. Legal pages and contact (AC-2.10)

| Step | Action | Expected |
|---|---|---|
| L-1 | Open `/terms`, `/privacy`, `/acceptable-use`, `/report` on staging. | Each shows the draft notice. |
| L-2 | Owner fills in every `[OWNER: …]` placeholder or decides to keep it open for the beta. | Recorded in phase 2 §17.2 / 06 (Q-022). |
| L-3 | Owner confirms the operator contact address and who will receive report alerts once they exist. | Recorded (Q-022). Alert delivery itself is a future requirement, not part of Phase 2. |

## 7. Real R2 and real Turnstile (AC-2.1, AC-2.4 staging parts)

| Step | Action | Expected |
|---|---|---|
| R-1 | Q-3 above downloads from the staging R2 bucket. | The download comes from the R2 S3 hostname, as an attachment. |
| R-2 | K-4 above uses the real Turnstile widget and Cloudflare's siteverify. | The check appears and is verified by the server. |
| R-3 | Browser dev tools on B's share page (desktop Safari via a cable, or a desktop browser on mobile data). | Requests go only to the app's hostname and the R2 hostname; Turnstile only on `/c` after failures and when sending a report. |
