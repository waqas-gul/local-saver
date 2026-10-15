# Phase 1 — Manual and staging verification procedure

| Field | Value |
|---|---|
| Purpose | Close the Phase 1 acceptance criteria that need real devices, real networks, staging, real R2 or the owner: **AC-1.3 (T-009), AC-1.6, AC-1.8, AC-1.9, AC-1.11, AC-1.12** ([phase 1 §14](phase-1-local-sharing.md#13-acceptance-criteria)) |
| Status | **BLOCKED.** Nothing here has been run. The prerequisites (§1) don't exist yet. |
| Written | 2026-10-15 |
| Who runs it | The owner or a tester the owner names, with two to four devices |
| Rule | Record what actually happened, including failures. Don't mark a criterion VERIFIED from emulation or local runs. |

Local, automated checks that already cover parts of these criteria are listed in [phase 1 §18.5](phase-1-local-sharing.md#185-review-follow-up-second-pass-2026-10-15). They don't replace any step below.

---

## 1. Prerequisites (owner items)

Real-device tests **can't run against a laptop on the local network**: a phone reaching `next dev` over Wi-Fi presents a private address (`192.168.x.x`), which the app treats as non-global, so local sharing is `unavailable`. Grouping only works when the app sees **public** addresses through Cloudflare. Everything below therefore needs the staging environment.

| # | Prerequisite | Where it's specified |
|---|---|---|
| P-1 | Domain, Cloudflare zone, staging hostname proxied, `X-Origin-Auth` Transform Rule, **Pseudo IPv4 off** | [08 §4](../08-deployment-and-operations.md#4-cloudflare-configuration-checklist) |
| P-2 | Staging host running the Phase 1 build with `APP_ENV=staging`, `TRUST_PROXY_MODE=cloudflare` (SP-01) | [08 §3](../08-deployment-and-operations.md#3-environments), [phase 0](phase-0-foundation.md) |
| P-3 | Staging Supabase project: migrations applied, anonymous sign-ins and Turnstile captcha on, Realtime "Allow public access" off, query logging checked | [08 §5](../08-deployment-and-operations.md#5-supabase-configuration-checklist) |
| P-4 | Staging R2 bucket with `infra/r2/cors.staging.json` and `infra/r2/lifecycle.json` applied | [08 §6](../08-deployment-and-operations.md#6-r2-configuration-checklist) |
| P-5 | Egress lists loaded (`pnpm egress:load`) within the last 14 days | [runbook](../runbooks/egress-lists.md) |
| P-6 | Cloudflare Access on staging lets the test devices in (email one-time code is fine on phones) | 08 §3 |
| P-7 | Devices: one laptop or desktop (Chrome or Edge), one iPhone (Safari), one Android phone (Chrome); a second Wi-Fi or a phone with mobile data | — |

**Privacy while testing:** never write down IP addresses. Record the address **family** (IPv4 or IPv6) and the network type only. To see the family, open `https://<staging-host>/cdn-cgi/trace` on the device: the `ip=` line contains `:` for IPv6.

## 2. Recording sheet

Copy this table into `evidence/phase-1/manual-matrix.md` and fill one row per step and device. Attach screenshots or screen recordings under `evidence/phase-1/manual/`.

| Date | Step | Device / OS / browser (version) | Network type | Family | Status shown | Devices here | Expected | Observed | Pass? | Time (s) | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|

---

## 3. Same network (AC-1.11 part 1, AC-1.6, AC-1.1 on real devices)

Devices: **A** = laptop, **B** = phone. Both on the **same Wi-Fi**. Fresh browser profiles (or private windows) on both.

| Step | Action | Expected |
|---|---|---|
| S-1 | On both, open `https://<staging-host>/`. Pass Cloudflare Access. | The one-time notice "Everyone on this network can see what you post" appears once. After "Got it" it doesn't come back on reload. |
| S-2 | Look at the status line on both. Note the family from `/cdn-cgi/trace` on both. | Both show *"This network · 2 devices here now"*, and *"Visible to everyone on this network"* under the composer. **If B shows "Local sharing is off", or each shows "1 device", record it as a false negative** with both families (for example A on IPv6, B on IPv4: without SP-04 the two families are different networks, DV1-3). |
| S-3 | On A, post a text containing a link. Don't reload B. | B shows it within 2 s, link clickable, "Copy" works. |
| S-4 | On A, choose Files, pick a JPEG or PNG photo. | Progress on A, then "Shared". B shows the file with a preview within a few seconds, without reloading. |
| S-5 | On A, pick a PDF (and a `.docx` if available). | B shows the documents (no preview, a Download button). |
| S-6 | On B, tap Download for each file. | The file downloads with its original name and opens. |
| S-7 | On A, edit the text, then delete the photo share. | B shows the edit and then loses the photo within 2 s. B has no Edit or Delete buttons on A's posts. |
| S-8 (**AC-1.6**) | On B (the phone), choose Files and pick (a) a photo from the camera roll, (b) a video or file of 50–100 MB. Keep the screen on. | Progress advances; both finish; A sees them and can download them. **Record:** what the iPhone sends for a HEIC photo (name and type shown on A; a HEIC photo gets no preview), the time for the large file, and whether locking the screen breaks the upload. |
| S-9 | Repeat S-8 on the other phone platform (iPhone or Android). | Same as S-8. |

## 4. Different networks (AC-1.11 part 2, T-001 on real networks)

Devices: **A** on Wi-Fi 1 with the posts from §3. **B** on a different network: another Wi-Fi, or mobile data with Wi-Fi switched off. For step D-3 B must be a **desktop browser** (for example a laptop tethered to a phone's hotspot), because the check uses the browser console.

| Step | Action | Expected |
|---|---|---|
| D-1 | Open the site on B. | B's feed does not contain any of A's posts. Status is either "1 device here now" or "Local sharing is off" (record which, and the reason text). On mobile data, record the status: `ok` there would mean a carrier address is treated as one network (input for SP-04 and Q-029). |
| D-2 | On A, open DevTools → Network, reload, and copy one share `id` and one file `id` from the `/api/v1/local/shares` response. | — |
| D-3 | On B, open DevTools → Console and run the snippet below with A's IDs. | Every call returns **404** with the same body as the random ID (apart from `requestId`). No content, file name or size appears. |
| D-4 | On A, switch to mobile data (or the other network) and open "My uploads". | A still sees its own posts in My uploads and can delete them. The "This network" feed on A shows the new network's content only. |
| D-5 | — | **Not tested here:** links, QR codes and share codes are Phase 2. |

```js
// Run in the console of the staging page on device B. Replace the two IDs.
const SHARE_ID = "<share id from A>";
const FILE_ID = "<file id from A>";
const session = JSON.parse(localStorage.getItem("local-saver.auth"));
const headers = { authorization: `Bearer ${session.access_token}`, "x-device-id": localStorage.getItem("local-saver.device-id") };
const show = async (label, response) => console.log(label, response.status, await response.text());
await show("share", await fetch(`/api/v1/shares/${SHARE_ID}`, { headers }));
await show("random", await fetch(`/api/v1/shares/${crypto.randomUUID()}`, { headers }));
const post = (path) => fetch(path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" });
await show("download", await post(`/api/v1/files/${FILE_ID}/download-url`));
await show("preview", await post(`/api/v1/files/${FILE_ID}/preview-url`));
```

## 5. Network transition (AC-1.11 part 3, T-003 on real devices)

Device **B** (phone) moves: same Wi-Fi as A → mobile data (Wi-Fi off) → same Wi-Fi again. Keep the page open in the foreground throughout, then repeat with the tab in the background during each switch.

What the app does ([DEC-034 rule 3](../06-decisions-and-risks.md), `lib/client/use-network.ts`): the server derives the network on **every request**, so any request after the switch is answered for the new network. The page re-checks its network on the browser's `online` event, on a connection change (Chromium only), when the tab regains focus, and every 5 minutes; when the network differs, it **removes** the old network's data from memory. Nothing is stored in the browser except the session, the device ID and the notice flag.

| Step | Action | Expected |
|---|---|---|
| T-1 | B on the same Wi-Fi as A. | B sees A's posts. |
| T-2 | Switch B to mobile data. Start a stopwatch. Don't touch the page. | A's posts disappear from B. **Record the time.** Android Chrome should clear at once (connection change). iPhone Safari may keep the old list on screen until the next check (up to 5 minutes) because Safari has no connection-change event: record it. |
| T-3 | While A's posts are still on screen (if they are), tap Download on one. | The download fails ("not found"). Nothing downloads. |
| T-4 | Switch the tab away and back, or reload. | A's posts are gone. Reloading shows the new network's feed only. |
| T-5 | On B, open DevTools (desktop) or skip on phones: Application → Local storage. | Only `local-saver.auth`, `local-saver.device-id` and `local-saver.notice-v1`. No post content. |
| T-6 | Switch B back to the same Wi-Fi. | A's posts reappear (if not expired) without a reload, at the next check. |
| T-7 | Press Back/Forward between "This network" and "My uploads" after a switch. | No old-network content reappears. |

---

## 6. Staging: expiry, cleanup and the R2 lifecycle backstop (AC-1.8)

| Step | Action | Expected / evidence |
|---|---|---|
| E-1 | Apply `infra/r2/lifecycle.json` to the staging bucket. Read it back with `aws s3api get-bucket-lifecycle-configuration --bucket <bucket> --endpoint-url https://<account>.r2.cloudflarestorage.com`. | The three backstop rules (`d7/` 8 days, `d30/` 31, `d90/` 91) and the multipart abort rule. Save the output. |
| E-2 | In the Supabase SQL editor: `select jobname, schedule, active from cron.job order by 1;` | The six Phase 1 jobs, active. |
| E-3 | Post a text and a file with expiry **1 hour** from a test device. | Both visible on a second device. |
| E-4 | After the hour, reload on the second device and try the file's download. | Gone from the feed; download refused. |
| E-5 | `select status, end_reason, ended_at from app.shares where id = '<id>';` and `select status, return_message, start_time from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'expire-shares') order by start_time desc limit 5;` | `expired` / `expired` within a minute of expiry; job runs succeed. |
| E-6 | `select object_key, completed_at, tombstoned_at from app.object_deletions where source_file_id = '<file id>';` then delete any other share from a device (this runs the storage sweep) and repeat. | The row becomes completed; the object is gone from R2 (`aws s3api head-object` → 404). |
| E-7 | Backstop: upload a test object straight to `d7/2026/01/01/<uuid>` with the AWS CLI (never referenced by the app). Check again after 9 days. | The object is gone without any app action. Record dates. |
| E-8 | Write-once and tombstones on R2 (SP-02): post a file, copy its upload URL and headers from DevTools (the `/api/v1/shares` response), delete the share, then replay the PUT with `curl -X PUT --data-binary @same-size-file -H ...` | **412**; `head-object` shows `Content-Length: 0` and `x-amz-meta-tombstone: 1`. Also replay a PUT with a different size → 403. |

## 7. Staging: quota race, rate limits, kill switches (AC-1.9)

Use a desktop browser on staging with the console helper from §4 (`headers`, `post`).

| Step | Action | Expected |
|---|---|---|
| Q-1 | Find your user ID: `JSON.parse(localStorage.getItem("local-saver.auth")).user.id`. In SQL: `insert into app.storage_usage (subject_type, subject_id, bytes_committed) values ('user', '<user id>', 2147483648 - 100*1048576) on conflict (subject_type, subject_id) do update set bytes_committed = excluded.bytes_committed;` (100 MB left). | — |
| Q-2 | Run 30 parallel announcements of 10 MB each (snippet below; 30 is the hourly limit for new shares). | Exactly **10** answer `201`, the other 20 `409 STORAGE_QUOTA_EXCEEDED`. Any `429` means this session already created shares in the last hour: use a fresh private window. Then reset `storage_usage` for that user. |
| Q-3 | Call observe 31 times within a minute: `for (let i = 0; i < 31; i++) await show(i, await post("/api/v1/network/observe"));` | The 31st answers **429** with a `Retry-After` header. |
| Q-4 | Kill switches, one at a time: `update app.runtime_flags set enabled = false where key = 'uploads_enabled';` wait 30 s, try a file upload; set it back. Repeat for `anonymous_uploads_enabled` (text and files) and `local_sharing_enabled` (feed hidden, status "Local sharing is paused"). | Each action is refused while its switch is off and works again after it is back on. |

```js
// Q-2: 30 parallel 10 MB announcements (no bytes are uploaded).
const body = JSON.stringify({ destination: "network", files: [{ name: "q.bin", size: 10 * 1048576, type: "application/octet-stream" }] });
const results = await Promise.all(Array.from({ length: 30 }, () =>
  fetch("/api/v1/shares", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body }).then((r) => r.status)));
console.log(results.reduce((count, s) => ({ ...count, [s]: (count[s] ?? 0) + 1 }), {}));
```

## 8. Real network matrix (AC-1.11)

Run §3 S-1 to S-3 (and D-1 where a second network is involved) on as many of these as possible. Each row needs: status shown, devices here, whether the two devices grouped, and the families.

| # | Network | What to learn |
|---|---|---|
| N-1 | Home Wi-Fi, IPv4 only | Basic grouping |
| N-2 | Home Wi-Fi, dual stack (IPv4 + IPv6) | Do devices split by family (false negative without SP-04)? |
| N-3 | Office Wi-Fi | Grouping; `too_large` above 50 devices/24 h? |
| N-4 | Café, hotel or other guest Wi-Fi | Strangers group (by design, R1); audience line count |
| N-5 | University or eduroam | Likely `too_large` or false positives |
| N-6 | Mobile data, two phones on the same carrier | Carrier NAT: `ok`, `too_large` or `shared_egress`? |
| N-7 | Phone hotspot with a laptop | Grouping of the hotspot's devices |
| N-8 | One device on a VPN | Expected: the VPN device does not group |
| N-9 | iPhone with iCloud Private Relay on (Safari) | Expected: `shared_egress` ("Local sharing is off") |

## 9. Owner copy review (AC-1.12)

Review the screenshots (desktop and phone width) and either approve each item or write the change.

| Item | Copy (`components/local/copy.ts`) | Screenshots |
|---|---|---|
| C-1 One-time notice | "Everyone on this network can see what you post" + body | [desktop](evidence/phase-1/1-first-visit-notice.png), [phone](evidence/phase-1/1-first-visit-notice-phone.png) |
| C-2 Audience and status lines (owner decision, 2026-10-15; applied) | Under the composer: "Visible to everyone on this network". Status bar: "This network · N devices here now" | [desktop](evidence/phase-1/2-this-network.png), [phone](evidence/phase-1/2-this-network-phone.png) |
| C-3 Risky download | "Download this file?" + body, "Download anyway" | [desktop](evidence/phase-1/3-risky-download.png), [phone](evidence/phase-1/3-risky-download-phone.png) |
| C-4 Local sharing off | "Local sharing is off on this network" + body | [desktop](evidence/phase-1/4-local-sharing-off.png), [phone](evidence/phase-1/4-local-sharing-off-phone.png) |
| C-5 Other status texts | "Local sharing is paused" (kill switch, stale lists); "We can't tell which network you're on" | `copy.ts` |

The review notes and recommendations are in [phase 1 §18.5](phase-1-local-sharing.md#185-review-follow-up-second-pass-2026-10-15) (screenshot review).

## 10. When everything has passed

1. File the recording sheet and evidence under `evidence/phase-1/`.
2. Update the AC table in [phase 1 §18.3](phase-1-local-sharing.md#183-acceptance-criteria-status) with links to the evidence.
3. The owner signs the verification record in [phase 1 §16](phase-1-local-sharing.md#16-implementation-status). Only then is Phase 1 VERIFIED.
