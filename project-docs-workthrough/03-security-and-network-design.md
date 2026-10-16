# 03 — Security and Network Design

| Field | Value |
|---|---|
| Document status | PROPOSED — awaiting owner review. §3 implements the owner's accepted rule for local mode (DEC-031, CR-001). |
| Last updated | 2026-10-15 (Phase 2 as built: §4.1–§4.4 and §4.8 notes, §7.4 remote policy, §7.6 reports and takedown, §9 matrix tested with link viewers, §10 Phase 2 limits, §12 peppers and the Turnstile secret now used, §13 new data, §14 events). Earlier the same day: Phase 1 as built (§3.4–§3.5 fallback, stale egress lists fail closed, prefix-only egress lookup, §7.1, §7.3, §7.7, §13 IP inventory, §8 bearer tokens, §10 limits, §11 CSP notes) |
| Key decisions | DEC-031 (ACCEPTED), DEC-032, DEC-033, DEC-004, DEC-013, DEC-014, DEC-015, DEC-020, DEC-021, DEC-024, DEC-025 |
| Key risks | RISK-001, RISK-002, RISK-004, RISK-005, RISK-007, RISK-008, RISK-009, RISK-013, RISK-025, RISK-026 |

---

## 1. Threat model summary

### 1.1 Assets

| Asset | Sensitivity |
|---|---|
| File bytes and text content | High. Can include IDs, contracts, photos, credentials. |
| File names, share titles, room labels | Medium to high (often reveal content) |
| Share-link secrets, short codes, invite secrets (Phase 4), link passwords | High (bearer credentials) |
| Device labels, network presence, private-room membership | Medium |
| Network keys (keyed hashes of IP addresses) | Medium. Pseudonymous personal data. |
| The trusted client IP | **Critical.** It decides local visibility (DEC-031). |
| Accounts, subscriptions, billing identifiers | Medium to high |
| Service credentials (Supabase secret key, R2 keys, peppers, origin secret) | Critical |

### 1.2 Adversaries

| Adversary | Goal / capability |
|---|---|
| Anyone on the same Wi-Fi (guest, café or hotel customer, co-worker, neighbour with the password) | Sees all local content **by design** (DEC-031, R1). Goals beyond that: delete or alter others' posts, export them off the network, post abuse. |
| Stranger on a *different* network behind the same public IP (CGNAT, campus, VPN, relay) | See another network's local content (R2) |
| Internet attacker | Enumerate links and codes, brute-force passwords, **spoof headers to impersonate a network**, IDOR |
| Device that has left the network, or a removed private-room member | Keep access afterwards, exfiltrate |
| Link recipient | Access more than the shared item, keep burn content without consuming it |
| Abuser | Use free hosting for malware, phishing, piracy, illegal content, spam |
| Automated clients | Link unfurlers, email security scanners, crawlers. They follow links and could consume one-time content or index shares. |
| Compromised dependency / XSS | Steal sessions, secrets or presigned URLs from the page |
| Insider / credential leak | Use leaked service keys |

---

## 2. Same-network detection — technical analysis

### 2.1 What the server can reliably know

- **The source IP of the connection that reached the edge** (Cloudflare). Downstream services know it only through a header set by a proxy we control (§3.3).
- The IP family (IPv4 or IPv6).
- **Probabilistic** facts from databases: ASN/organization, country, and whether the address is a known relay, VPN, hosting or Tor egress. These lag and are incomplete.
- Request metadata: TLS/HTTP characteristics and user agent (spoofable), timing.
- Whatever the client *claims* (untrusted).

### 2.2 What the server cannot know

- Whether two requests from the same public IP come from the same LAN, SSID, building or household.
- Whether a public IP belongs to one home router or to a carrier or enterprise NAT shared by thousands (only heuristics).
- Whether two *different* public IPs belong to the same LAN (dual-stack, multi-WAN, relays, a VPN on one device).
- The LAN's private address range, gateway, SSID/BSSID or router identity.
- Whether yesterday's IP still belongs to the same people today (dynamic assignment).
- Anything trustworthy from `X-Forwarded-For`/`X-Real-IP` added by proxies it does not control. **Clients can write these headers.**

### 2.3 Why "same public IP = same network" is only an approximation

Under DEC-031 the network *does* decide local visibility, so the right-hand column is what happens without guards. The guards in §3.5 exist to contain these rows.

| Scenario | What the server sees | Error type | Consequence for local content (without guards) | Handled by |
|---|---|---|---|---|
| Mobile data behind carrier-grade NAT (CGNAT) | Many subscribers share a few rotating public IPv4 addresses | False positive and instability | **Strangers see each other's content** | `shared_egress` (mobile ASN, IPv4 bound to several IPv6 /64s) |
| University, school, enterprise, hospital network | A whole organisation behind a few NAT addresses | False positive (or "same network", literally) | Classmates or co-workers see each other's local posts | `too_large` cap; R1/R2 |
| Café, hotel, airport, coworking guest Wi-Fi | All guests share one IP | True positive: they *are* on the same Wi-Fi | Strangers see content | **By design (R1).** Audience indicator. |
| Home guest network / holiday rental | The guest SSID shares the host's public IP | Same network, by the product's definition | Guests see the host's local posts | By design (R1) |
| Residential CGNAT, including some fixed-wireless/5G home internet | Many homes behind one IP | False positive | Neighbours see each other's posts | IPv4-with-several-IPv6 detection, `too_large`; residual R2 |
| Commercial or corporate VPN, Cloudflare WARP | Unrelated users share exit IPs, and the VPN device differs from the rest of the home | False positive and false negative | Strangers grouped, own devices split | `shared_egress` (VPN/hosting ASNs); R2, R5 |
| iCloud Private Relay (Safari for iCloud+ users) | A relay egress IP shared by many users, different from the laptop's IP on the same Wi-Fi | False positive and false negative | Same as VPN | `shared_egress` (Apple's list); R5 |
| Dual-stack home (IPv4 + IPv6) | The phone connects over IPv6, the laptop over IPv4 | False negative | Own devices don't see each other | Dual-stack binding (§3.4); R5 |
| IPv6 prefix layout | Usually one /64 per LAN, but some networks use several /64s (VLANs), and mobile networks give a /64 per device | False negative | Inconsistent grouping | R5 |
| Multi-WAN / load-balanced NAT | Same LAN, alternating public IPs | False negative / flapping | Local content appears and disappears | R5 |
| Dynamic IP reassignment | Yesterday's address now belongs to another customer | False positive over time | The new holder sees content still live on that key | Short default expiry (Q-030); R3 |
| Misconfigured proxy trust | Attacker sends `X-Forwarded-For: <victim IP>`, or bypasses the CDN with a forged `CF-Connecting-IP` | Targeted false positive | **An attacker reads any network's local content** | Origin lock (§3.3). Must never happen. |
| Different textual forms | `::ffff:203.0.113.7`, NAT64 `64:ff9b::cb00:7107`, `203.0.113.7` | False negative if not normalized | Split networks | Normalization (§3.2) |

### 2.4 Can browser APIs identify LAN membership?

| Browser capability | Available to a public website? | Assessment |
|---|---|---|
| Wi-Fi SSID/BSSID, gateway MAC | **No API exists** | Intentionally withheld for privacy |
| Network Information API (`navigator.connection`) | Chromium only | Only connection type/speed hints. No identity. Absent in Safari and Firefox. |
| WebRTC ICE host candidates (local IP) | Local IPs are **masked as random `*.local` mDNS hostnames** in Chrome, Firefox and Safari unless the page holds camera/microphone permission | Can't read the LAN IP. Even raw private IPs (`192.168.1.x`) are reused by millions of homes. |
| WebRTC connection using only host candidates | Technically possible between two browsers online at the same time | Proves **local reachability, not trust** (café strangers pass). Fails under client/AP isolation, blocked multicast, VPNs, and some mobile OS behaviour. Needs another device online. **Chrome is prototyping Local Network Access restrictions for WebRTC**, which may add a permission prompt. Not used (SP-05 withdrawn by CR-001). |
| Requests to router or LAN devices (`http://192.168.1.1`) | Blocked or prompted. Mixed content and CORS apply, and **Chrome 142+ asks permission** ("Look for and connect to any device on your local network") for public sites reaching local addresses. | Scary prompt, fingerprinting-like, unreliable. Not acceptable. |
| Web Bluetooth / Web NFC / Wi-Fi Direct | Bluetooth: Chromium only with a chooser prompt, not iOS Safari. NFC: Android Chrome only. No Wi-Fi Direct API. | Not cross-platform, and still needs an explicit user action |
| Geolocation | Permission prompt | Physical proximity ≠ same network. Privacy cost. Spoofable. |
| Audio/ultrasonic pairing | Microphone permission | Invasive and unreliable |

### 2.5 Conclusion

> **The server cannot see a LAN. It sees a public IP address, which only approximates "the same network".**
>
> - Public-IP matching produces **false positives** (unrelated networks behind one IP) and **false negatives** (one network appearing under several IPs).
> - Browsers intentionally prevent LAN identification. WebRTC proves only adjacency, and may soon need a permission prompt.
>
> **Owner decision (2026-09-23, DEC-031, CR-001):** local mode keeps the product's original rule. Everyone on the same network sees local content automatically, with no approval step. The rest of this document designs the safest version of that rule:
>
> 1. The **server decides the network on every request**, from a client IP that only Cloudflare can set (§3.2–§3.4).
> 2. Wherever one public IP is known or suspected to cover several networks, **local mode switches itself off** (fail closed) (§3.5).
> 3. **Leaving the network ends access on the next request.** Nothing is remembered (§3.6).
> 4. **Uploaders are told who can see a post** before they post it (§3.7).
> 5. What cannot be prevented is stated plainly (§3.8).
>
> Identifying the actual LAN, rather than the public IP, would need native apps using mDNS/Bonjour, as AirDrop and LocalSend do (Q-025).

---

## 3. Local mode: automatic same-network visibility (DEC-031, DEC-032, DEC-033)

### 3.1 The rule and design principles

The owner's rule (DEC-031, **ACCEPTED**):

| Situation | Behaviour |
|---|---|
| Same Wi-Fi / network | Anyone on that network automatically sees the files, text and images posted to it. No approval, PIN, QR code or link. |
| Different network | Sees nothing automatically, not even that local content exists |
| Remote access | Only through an explicit share link, its QR code, or a short share code (§4) |

| # | Principle |
|---|---|
| P1 | **The server decides the network.** It is derived from the Cloudflare-verified client IP on every request. No endpoint accepts a network or space identifier from the client. |
| P2 | **Visibility is evaluated per request, never remembered.** Local mode has no memberships. |
| P3 | **Fail closed.** When the server cannot trust that an IP stands for one network, local mode is off there, for viewing and for posting. |
| P4 | **Tell the uploader who can see it** before they post. |
| P5 | **Minimal network data.** Keyed hashes only, short-lived presence, no raw IPs in the app's tables, query parameters or logs. |

### 3.2 Network key derivation (DEC-032)

1. **Obtain the trusted client IP** (§3.3). If unavailable, `networkStatus` is `unavailable` and local mode is off.
2. **Normalize:**
   - IPv4 → canonical dotted quad.
   - IPv4-mapped IPv6 `::ffff:a.b.c.d` → IPv4. NAT64 well-known prefix `64:ff9b::/96` → embedded IPv4.
   - IPv6 → **/64 prefix** (configurable `NETWORK_IPV6_PREFIX_LEN`, default 64).
   - **Reject non-global addresses** (private, loopback, link-local, `100.64.0.0/10`, `fc00::/7`, documentation ranges). This indicates a proxy misconfiguration: log an alert and return `unavailable`.
3. **Key:** `networkKey = HMAC-SHA256(NETWORK_KEY_SECRET[version], family + "|" + normalized)`. Store the 32-byte digest and the key version.
   - *Why a keyed HMAC:* the IPv4 space has only 2³² values, so a plain SHA-256 of an IP can be reversed by brute force in minutes. The secret lives only in server environment variables.
4. **Resolve the network space:** upsert `app.network_spaces` for the key. There is one space per key. A space has no owner, members or name; the UI calls it "This network".
5. **Classify** the space (§3.5) and **record presence** (§3.6).

**Key rotation:** a space must stay stable while its content lives (up to 90 days on Pro). Rotate the secret yearly or after an incident. During a rotation both versions are computed for 100 days, and a space is re-keyed the first time it is seen under the new version.

### 3.3 Trusted client IP and origin lock (DEC-004)

**Under DEC-031 this is the access boundary for local content.** A forged client IP would show an attacker the local content of any network.

```mermaid
flowchart LR
  C["Client"] -->|"HTTPS"| CF["Cloudflare proxy<br/>sets CF-Connecting-IP<br/>Transform Rule sets X-Origin-Auth"]
  CF -->|"HTTPS (Full strict)"| O["Origin: Next.js<br/>proxy.ts verifies X-Origin-Auth<br/>then trusts CF-Connecting-IP"]
  A["Attacker bypassing CDN"] -.->|"direct to origin hostname"| O
  O -.->|"403: missing or invalid origin secret"| A
```

Rules:

1. In production, `proxy.ts` rejects **every** request without a valid `X-Origin-Auth` value, using a timing-safe comparison. Two secrets are accepted during rotation.
2. Only after that check is `CF-Connecting-IP` read. `X-Forwarded-For` and `X-Real-IP` are **ignored** by default.
3. **Preferred on a VPS:** Cloudflare Tunnel (`cloudflared`), so the origin has no public ingress at all. The header check stays as defense in depth.
4. A test override (`X-Test-Client-IP`) is honoured only when `NODE_ENV !== "production"` **and** `ALLOW_TEST_CLIENT_IP=1`. The production boot sequence refuses to start if the flag is set.
5. **SP-01 must verify on Hostinger:**
   - Cloudflare overwrites client-supplied `CF-Connecting-IP` and `X-Origin-Auth`.
   - Hostinger's front proxy passes both headers through unchanged.
   - Direct requests to the Hostinger hostname are rejected.
   - TLS works in Full (strict) mode.

### 3.4 Dual-stack binding (conditional on SP-04)

**Problem:** a dual-stack home reaches the server over IPv4 or IPv6 depending on the connection. Devices on the same Wi-Fi can then land in different spaces, and one device can flip between them.

**Design:**

1. `POST /api/v1/network/observe` on the main host returns a single-use **probe nonce** (60 s).
2. The client calls `GET https://v4.{domain}/api/v1/network/probe?n={nonce}` and `GET https://v6.{domain}/api/v1/network/probe?n={nonce}`. Each hostname resolves in only one address family. Each probe records `(nonce, family, network key)` on the server, carries no cookies and returns only `204`.
3. The client calls `observe` again with the nonce. The server accepts the pair **only if the current request's own key is one of the probed keys**, then stores a **network binding** (server-side, 10-minute lifetime) holding both keys.
4. On every later request the server derives the current key:
   - If that key belongs to the device's live binding, the device's current network is **both** keys.
   - Otherwise the binding is discarded and only the current key counts. Moving to another network therefore never carries the old keys along.
5. Each binding also records an **IPv4 ↔ IPv6 link**, which detects carrier-grade NAT (§3.5).

**Placement:** a new local share goes into the uploader's **most specific** eligible space: the IPv6 /64 when present, otherwise the IPv4 address. Viewing covers every eligible space in the device's current network. A device with only IPv4, on a home where others use IPv6, therefore sees posts from other IPv4-only devices but may miss posts from IPv6 devices (a documented false negative, R5). This bias is deliberate: IPv4 addresses are far more often shared between unrelated homes.

**Phase 1 as built (2026-10-15): not adopted.** SP-04 has not run, so only the current request's key counts (phase 1 DV1-3); there is no probe endpoint and no binding table. normally answer both A and AAAA records ("IPv6 compatibility"), so single-family probe hostnames may need a separate zone or configuration. **If SP-04 finds this infeasible:** only the current request's key counts. Dual-stack devices may then flip between spaces (reduced by HTTP connection reuse). SP-04 records the resulting false-negative rate (RISK-013), and CGNAT detection relies on the ASN and crowding signals only.

### 3.5 Eligibility: classification and fail-closed guards (DEC-032)

| `networkStatus` | Detection | Local mode |
|---|---|---|
| `ok` | Default | **On:** view and post |
| `shared_egress` | (a) Address in Apple's iCloud Private Relay egress list or the Tor exit list. (b) Client ASN on a curated list: VPN and hosting providers (both families), and **mobile carriers for IPv4 only**, because carriers put many subscribers behind one IPv4 address but usually give each phone its own IPv6 /64. (c) An IPv4 key bound to **two or more different IPv6 /64s within one hour**: a strong carrier-NAT signal (needs §3.4). | **Off** |
| `too_large` | More than **50** distinct devices seen on the space in 24 h (tunable, Q-029). Catches shared IPs the lists miss (campus, enterprise NAT, residential CGNAT) and very large Wi-Fi networks. | **Off** |
| `blocked` | Operator action or abuse response | **Off** |
| `unavailable` | No trusted IP, a non-global address, the kill switch, or (staging/production) missing or stale egress lists | **Off** |

Rules:

- **Fail closed for existing content too.** When a space leaves `ok`, its shares stop being visible to anyone on that network until it returns to `ok`. Creators still see them under "My uploads" and can share them by link. A space that becomes `too_large` or `shared_egress` stays so for at least 7 days.
- Status copy: *"Local sharing is off on this network. It looks like a mobile, VPN, relay or very large shared network, where other people may share your internet address. Use a link, QR code or share code instead."*
- **ASN data:** Cloudflare's rules engine knows the client's ASN. Whether a Transform Rule can forward it to the origin on the chosen Cloudflare plan is verified in SP-04 (Q-013). The ASN list must be licensed for commercial use. Without ASN data, Phase 1 relies on (a), (c) and `too_large`, and ASN classification arrives in Phase 6.
- **Phase 1 as built (2026-10-15):** (a) via `app.network_egress_ranges`, loaded with `pnpm egress:load` ([runbook](runbooks/egress-lists.md)), and `too_large`. The client address never reaches the database: the app asks for the ranges overlapping its IPv4 /24 or IPv6 /48 (`app.egress_ranges_overlapping`, which refuses longer prefixes), matches the exact address itself and passes only the result to `app.observe_network` (Phase 1 F1-13); no ASN list (needs SP-04) and no (c) (needs §3.4). The cap is the runtime flag `network_large_cap` (default 50, Q-029 assumed), shared by `observe` and the status job. Statuses are applied in `app.observe_network()` and `app.refresh_network_status()`; every change is audited and signalled as `network.changed`. That denies convenience only, and is accepted.
- **Missing or stale egress lists fail closed (Phase 1 security review, M2):** in staging and production, local sharing is off everywhere (`unavailable`, reason `classification_unavailable`) while the lists were never loaded or the last load is older than 14 days (`lib/server/network/egress.ts`). Locally and in tests the lists are optional. A `shared_egress` space is lifted only by an observe after its sticky period, because only an observe knows the address to re-check; the status job never lifts it.
- The crowding threshold rose from 12 (the rejected discovery-only design) to 50, because under DEC-031 an ordinary office or café Wi-Fi is meant to work.

### 3.6 Visibility rule and presence

Checked on every request that touches a local share, the local feed, or a local file:

```text
current  = network keys of this request (+ the bound other-family key, §3.4)
eligible = { space(k) : k in current and space.status = 'ok' }

visible(share) =
      share.scope = 'network'
  and share.expires_at > now()
  and ( share.status = 'active'
        or (share.status = 'claimed' and caller is the claimant, §5) )
  and ( share.network_space_id in eligible
        or share.created_by_user_id = caller.user_id )
```

- Not visible → **404**, with the same body as for a share that doesn't exist.
- **No endpoint takes a network or space ID as input.** The feed (`GET /api/v1/local/shares`) returns only shares whose space is in `eligible`.
- **Presence** (`app.network_presence`) is written by `observe`: every 5 minutes while the app is open, and on `focus`/`online` events. A device counts as present for 10 minutes after its last observe. Observing from a different network ends its presence elsewhere immediately. Presence authorizes the realtime topic `net:{spaceId}` ([04 §6.2](04-database-and-storage-design.md#62-realtime-policies)), and feeds the "N devices here now" line and the `too_large` count.
- **Leaving the network:** the next API request derives a different key, so the old network's shares return 404. The client re-observes on `online`, `focus` and connection changes, drops the old channel and subscribes to the new one.

### 3.7 Posting to the network (DEC-033)

- **Destination picker** in the composer: **This network** (the default when the status is `ok`) or **Link only** (Phase 2; never visible on any network). Pro/Team add private and workspace rooms (Phase 4–5).
- **Audience line** before posting, under the composer: *"Visible to everyone on this network"*; the status bar shows *"This network · 3 devices here now"* (Phase 1 copy, owner decision 2026-10-15). A one-time notice explains that everyone connected to the same Wi-Fi, including guests, can see and download what is posted here.
- Posting to the network is disabled when the status is not `ok`.
- **Permissions:** anyone present can view, download, copy text and report. Only the creator can edit text, delete, and create or revoke links (Q-021).
- **My uploads:** the creator sees all their shares from any network, and can create links there.

### 3.8 Isolation guarantees

**Guaranteed (by design, covered by tests in [09](09-testing-strategy.md)):**

| ID | Guarantee |
|---|---|
| G1 | A local share's metadata, text, files and URLs are returned only to (a) devices whose current, server-derived network includes the share's space while that space is eligible, (b) its creator, or (c) a valid link-grant holder for that share. |
| G2 | Clients cannot choose, forge or replay a network. Keys come only from the Cloudflare-verified IP. Dual-stack bindings are server-side, short-lived, and honoured only while the current IP is part of them. |
| G3 | Leaving a network ends access on the next request. Local mode remembers nothing. |
| G4 | Link viewers can access only the link's target. They cannot list other shares, spaces, devices or presence. |
| G5 | Local mode is off, for viewing and posting, on networks classified `shared_egress`, `too_large`, `blocked` or `unavailable`. |
| G6 | Realtime channels are private and authorized by presence (or, from Phase 4, room membership). Payloads contain IDs only. |
| G7 | Nothing about a network's local content, not even whether any exists, is exposed to a device that is not on that network. |

**Not guaranteed (residual risks, inherent to DEC-031):**

| ID | Residual | Risk |
|---|---|---|
| R1 | **Everyone on the same Wi-Fi sees local content**: guests, café or hotel customers, co-workers, neighbours who know the password. This is the product rule. | RISK-025 |
| R2 | Different networks behind one public IP that is **not yet recognized as shared** (small-ISP CGNAT, enterprise proxies, VPNs missing from the lists) see each other's local content. The guards shrink this but cannot remove it. | RISK-001 |
| R3 | When an ISP reassigns an IP address or IPv6 prefix, its next holder sees local content still live on that key. | RISK-026 |
| R4 | A device that left the network may receive ID-only realtime signals until its token refreshes. | RISK-007 |
| R5 | Your own devices on the same Wi-Fi may not see each other (IPv4/IPv6 split without §3.4, VPN or Private Relay on one device, multi-WAN). Local mode is off on mobile data, most hotspots and large networks. Fallback: link, QR code or share code. | RISK-013 |
| R6 | Anyone who downloaded something can keep and forward it. | Inherent |

### 3.9 How this maps to the owner's requirements

| Requirement | Design |
|---|---|
| Same Wi-Fi → everyone sees uploads automatically | Opening the site on the Wi-Fi shows the "This network" feed with everything posted there. New posts appear in realtime. No join step. |
| No QR code or link for same-network access | None needed |
| Different network → nothing visible automatically | Per-request network check (G1, G3, G7) and fail-closed guards (G5) |
| Remote access only through QR code, link or share code | §4: links to one share (Pro/Team: also to a private or workspace room) |
| Brief: "public IP must not be treated as authorization" | **No longer fully true for local mode.** Under DEC-031 the network, which the server knows only through the public IP, is the access rule for local content. The design narrows this to a Cloudflare-verified IP with fail-closed guards and states the residual risk (R2). |

### 3.10 Options considered

| Option | Outcome |
|---|---|
| "Discover automatically, admit once, remember" (approval, PIN or open-join window; the earlier DEC-002) | **Rejected by the owner** on 2026-09-23 (CR-001) |
| Automatic visibility with no guards | Rejected: mobile-carrier, VPN and relay IPs would expose content between strangers immediately |
| Keep access after leaving the network | Rejected: contradicts "a different network sees nothing" and breaks when IPs change |
| WebRTC LAN proof | Withdrawn: needs another device online, can trigger a permission prompt (Chrome Local Network Access), and doesn't fit fully automatic visibility |
| Router probing / local IP discovery | Blocked or prompted by browsers. Unreliable. Invasive. |
| Native apps with mDNS | Future option (Q-025) |

---

## 4. Remote sharing design

### 4.1 Share links (DEC-013)

**Format:** `https://{domain}/s/{linkId}#k={secret}`

| Part | Spec | Rationale |
|---|---|---|
| `linkId` | 12 random bytes → 16-character base64url | Unguessable. Lets logs and abuse reports reference a link without the secret. |
| `secret` | 32 random bytes → 43-character base64url, stored only as `HMAC-SHA256(LINK_PEPPER, secret)` | 256-bit bearer secret. The pepper prevents offline verification if the database leaks. |
| Fragment (`#k=`) | Browsers never send the fragment in HTTP requests | Keeps secrets out of Cloudflare and host logs and out of `Referer`. The page strips the fragment from the address bar after unlocking. |

The share page `/s/[linkId]` is a static shell: `noindex`, `Referrer-Policy: no-referrer`, strict CSP, **no third-party scripts**.

**Link-preview bots** fetch `/s/{linkId}` without the fragment and receive generic metadata ("A file was shared with you"). They learn nothing and consume nothing.

Link fields: `expires_at` (≤ share expiry and ≤ plan maximum), `revoked_at`, optional password (Pro), `allow_download`, creator, plan snapshot.

**Phase 2 as built (2026-10-15):** as specified, with the HMAC bound to the link ID (`HMAC(LINK_PEPPER[v], linkId | secret)`), a revocation reason (`creator`, `share_ended`, `blocked`), and the URL built from `NEXT_PUBLIC_APP_ORIGIN`, never the request's Host. A link lasts until its share expires unless a shorter option is chosen (phase 2 DV2-13); a database trigger refuses one that would outlive its share. Password columns wait for Phase 4. Summary: [ARCHITECTURE.md §9](ARCHITECTURE.md#9-remote-sharing).

### 4.2 Link grants (viewer sessions)

`POST /api/v1/links/{linkId}/unlock { secret, password?, turnstileToken? }`:

1. Rate-limit by `linkId`, network key and link session.
2. Load the link. Compute the HMAC of the supplied secret **even if the link doesn't exist**, then compare timing-safely. A missing link or wrong secret returns a generic **404 `LINK_UNAVAILABLE`**.
3. **Only after the secret is proven**, reveal state: revoked, expired or consumed returns **410 `LINK_EXPIRED`**.
4. Verify the password if one is set (Phase 4, §4.7).
5. Create or refresh the viewer session:
   - Cookie `__Host-link_session`: 256-bit random, httpOnly, Secure, SameSite=Lax, Path=/. It is stored hashed in `app.link_sessions`.
   - A grant row in `app.link_grants (session_id, link_id, password_version, expires_at = min(now() + 12 h, link.expires_at))`.
6. Return the viewer DTO.

Every viewer endpoint re-checks: grant valid, link active, `password_version` current, target still active.

**Viewers never receive:** network space or room IDs, presence, member or device info, other shares, uploader identity (except Team branding).

**Who may create a link:** only the share's creator (DEC-033), from any network. A link to a local share lets someone off the network open that one share; nothing else on the network becomes reachable.

Link viewers get **no Supabase user**. This avoids auth MAU costs (RISK-006). Viewer pages poll instead of subscribing to realtime.

**Phase 2 as built (2026-10-15):**

- Steps 1–3 and 5–6 as specified (no passwords before Phase 4). The cookie is `__Host-link_session` on HTTPS origins and plain `link_session` on the plain-HTTP origins of local development and tests (DV2-3), Max-Age 12 h, refreshed by each unlock or code.
- **Session fixation:** a presented cookie is reused only if its hash is a live stored session; any other value is ignored and a fresh one issued.
- **Grant expiry:** `min(now() + 12 h, link.expires_at, share.expires_at)`, also enforced by a check constraint. A grant holder whose link was revoked or expired, or whose share ended, gets `410 LINK_EXPIRED`; a grant that only timed out gets `404` (the link is needed again).
- Share and code pages run with a query client only: no Supabase client is ever created there (separate route-group layouts, DV2-12).

### 4.3 QR codes

- Generated **in the browser** from the full URL, including the fragment, with a local library. **Never use a third-party QR image API**, which would receive the secret.
- Displayed with the expiry time and the warning *"Anyone who scans this can open the share."*
- Error correction level M. A URL of about 80 characters fits a small, easily scanned code.
- **Phase 2 as built:** the `qr` library (no dependencies, DV2-8), drawn as one SVG path with a 4-module quiet zone; tests decode the rendered code back to the URL. Real phone scans are a manual step ([phase 2 procedure](phases/phase-2-manual-verification.md)).

### 4.4 Short codes (DEC-014)

| Property | Spec |
|---|---|
| Alphabet | Crockford Base32 (digits and letters without I, L, O, U) |
| Length | **10 characters (50 bits)**, displayed `7KQ4M-X9D2P` |
| Normalization | Uppercase. Strip spaces and hyphens. Map O→0 and I/L→1. |
| Storage | `HMAC-SHA256(CODE_PEPPER, normalized)`, unique among active codes. Plaintext is shown only at creation; "Generate new code" replaces it. |
| Validity | Default 1 h. Options 10 min / 1 h / 24 h (Free); up to 7 days (Pro). Never beyond the link's expiry. |
| Resolution | `POST /api/v1/codes/resolve { code }` creates a link grant (≤ 12 h) and returns only `linkId`. **The long-lived link secret is never revealed by a code.** Password-protected links still require the password. |
| Limits | Per device/session and per network key: 5 failures / 10 min, then Turnstile is required. 20 failures / day per network key gives a 24 h block. Global failure-rate alerting. |
| **Phase 2 as built** | As specified, with: only failures are counted; the 24 h block runs 24 hours from the 20th failure; without Turnstile configured (local only) the escalation is a wait until the window ends (DV2-19); the global alert is the error log `code.resolve_failure_spike` at 1,000 failures per 10 minutes; a code's expiry is clamped to its link's (DV2-14); "Generate new code" is `POST /api/v1/links/{linkId}/code` (DV2-5); expired codes are cleared by `purge-ephemeral`. |

**Entropy check:**

- With **1,000,000** active codes, one random guess succeeds with probability 10⁶ / 2⁵⁰ ≈ **8.9 × 10⁻¹⁰**.
- A botnet making **10⁶ guesses per day** despite per-IP limits expects ≈ 9 × 10⁻⁴ hits per day.
- With the diagram's 8-character `ABCD-1234` style (40 bits), the same attack expects ≈ **0.9 hits per day**. That is why 10 characters plus a short validity is recommended.

### 4.5 Private-room invites and QR pairing (Pro, Phase 4)

Local mode has no rooms or invites. Pro **private rooms** are membership-based and never visible on any network. Devices join them only through an invite:

- `https://{domain}/j/{inviteId}#k={secret}`. `inviteId` is 96-bit random. The secret is 256-bit, stored as an HMAC.
- **Pairing invites** (shown as a QR code): single use, 10 minutes. **Invite links:** multi-use, up to 7 days.
- Accepting requires the secret, creates membership (`joined_via = 'invite'`), and is rate-limited per invite and per network key. Invites are revocable.

### 4.6 Read-only room links (Pro, Phase 4)

- Created by the owner of a **private or workspace room**. They grant read-only access to the room's **current and future active shares** until the link expires or is revoked.
- **There is no link to a whole network's feed** (DEC-033, Q-028). It would show other people's local posts to someone who is not on the network.
- Viewers never see members. A burn share opened through a room link follows the normal claim rules.
- The UI warns: *"Anyone with this link can see everything posted to this room until it expires."*

### 4.7 Password-protected links (Pro, Phase 4; DEC-021)

- Passwords protect **links**, not room membership. A viewer needs **both** the link secret and the password.
- Hashing: **Argon2id** (m = 19 MiB, t = 2, p = 1, the OWASP baseline), stored as a PHC string.
- Minimum length 8, with a warning for very common passwords.
- Limits: 10 failures / 15 min per link, then a 15-minute lock for that link and Turnstile. 20 failures / hour per network key. Audit event `link.password_failed`.
- Changing or removing a password increments `password_version`, which invalidates existing grants.
- Passwords are never logged or returned.

### 4.8 Revocation and expiry

- Revoking a link sets `revoked_at`. Grants stop working on the **next request**. Presigned GET URLs already issued stay valid for at most 60 s (bearer semantics, RISK-009).
- Share deletion, expiry, claim or block invalidates all of its links.
- Creators (and, from Phase 4, room owners) can list and revoke active links.
- **Phase 2 as built:** `end_share` (deletion, expiry, upload failure, takedown) revokes every link of the share and clears its codes in the same transaction; every viewer request re-checks the link and the share, so this takes effect on the next request (tested, T-031).

### 4.9 Enumeration and probing defenses

- High-entropy identifiers: UUIDv4 for rows, 96-bit IDs for links and invites. No sequential numbers anywhere in the UI or API.
- Uniform **404** for "doesn't exist" and "not yours". Detailed state only after the credential is proven.
- Timing-safe comparisons, with the HMAC computed even when the record is missing.
- Rate limits keyed by link, invite, network key, device and session.
- `robots.txt` disallows `/s/`, `/j/`, `/c`, `/rooms`. `X-Robots-Tag: noindex, nofollow` on those routes.
- No endpoint accepts a network or space identifier. Listing endpoints return only what the caller's current network, membership or grant allows.

---

## 5. One-time download ("burn after download") — DEC-015

### 5.1 Why not "delete after the first *completed successful* download"

| Problem | Detail |
|---|---|
| Completion is unobservable | Bytes flow browser ↔ R2 directly. The server cannot tell whether a download finished or the file was saved. |
| Bypass | If only completion consumed the share, a recipient could abort at 99%, keeping almost all the bytes while leaving it available. |
| Races | Invalidating only on completion lets two people start simultaneously and both finish. |
| Bots | Email security scanners and link unfurlers open links automatically and could trigger consumption. |

**Recommended semantics:** *the first download request claims the share*. Only the claiming device (or link session) can fetch it during a short **grace window** for retries. After that the content is deleted.

### 5.2 State machine

```mermaid
stateDiagram-v2
  [*] --> pending_upload
  pending_upload --> active: all files verified
  pending_upload --> failed: upload timeout or rejected
  active --> claimed: first non-creator download request (atomic)
  active --> expired: expires_at reached
  active --> deleted: creator or owner deletes
  active --> blocked: abuse takedown
  claimed --> consumed: grace window ended or claimant confirmed receipt
  claimed --> blocked: abuse takedown
  expired --> [*]
  consumed --> [*]
  deleted --> [*]
  failed --> [*]
  blocked --> [*]
```

### 5.3 Atomic claim

```sql
-- One statement: no read-then-write gap.
update app.shares
   set status                  = 'claimed',
       claimed_at              = now(),
       claimed_by_user_id      = $actor_user_id,      -- null for link viewers
       claimed_device_id       = $actor_device_id,    -- null for link viewers
       claimed_link_session_id = $link_session_id,    -- null for devices on the network or room members
       claim_grace_until       = now() + $grace
 where id = $share_id
   and status = 'active'
   and burn_after_download
   and expires_at > now()
returning id, claim_grace_until;
```

- **Zero rows returned:** re-read the share. Issue a URL only if `status = 'claimed'`, the claimant matches (device or link session), `now() < claim_grace_until`, and issuances for that file are fewer than 3. Otherwise return **410 `ALREADY_DOWNLOADED`**.
- **Why it is race-free:** under READ COMMITTED, a concurrent second `UPDATE` waits for the first transaction's row lock, then re-evaluates the `WHERE` clause against the committed row. `status` is no longer `'active'`, so it updates zero rows. Exactly one claimant wins. [09](09-testing-strategy.md) requires a 50-way concurrency test.

### 5.4 Rules

| Rule | Detail |
|---|---|
| Grace window | `15 min + ceil(total_bytes / 1 MiB)` seconds, capped at 6 h, so slow downloads of large files can finish. Presigned GET URLs live 60 s, with at most 3 issuances per file during grace. |
| Deletion | A cron transition to `consumed` after `claim_grace_until`, plus a 5-minute margin, enqueues object deletion. The claimant may end grace early via `confirm-received`. |
| Creator exemption | Downloads by the share's creator (same user) never claim. |
| No previews | Burn shares have no thumbnails or inline previews. Text burn shares require a **Reveal** click, which is the claim. |
| POST only | Claims happen only through `POST` with a JSON body and an Origin check. Bots issuing GETs cannot consume. The share page asks for confirmation: *"This will be deleted after you open it."* |
| Multi-file | One claim covers the whole share. The claimant gets URLs for each file during grace. |
| Network and room behaviour | Once claimed, the share disappears for everyone else on the network (or in the room) via `share.changed`. On a busy network the first device to open it wins; the composer says so. |
| Plan | Pro feature per the plan list. Q-008 asks whether Free should get it. |

### 5.5 Residual risks

- The claimant can forward a presigned URL within its 60 s life.
- The claimant can keep the file forever (inherent).
- If the claimant's device fails and grace ends, the content is gone. The UI says so.

---

## 6. Download authorization and signed URLs

| Check (every issuance) | Device path (local share, or room share from Phase 4) | Link-viewer path |
|---|---|---|
| Authenticated principal | Supabase session plus device ownership | Valid `link_session` plus grant |
| Scope | **Local share:** the visibility rule in §3.6 (current eligible network, or creator). **Room share:** active membership in `file.room_id`. | `file.share_id = link.share_id` (share link) or `file.room_id = link.room_id` (room link) |
| Share state | `active`, or `claimed` by this device within grace | Same, with the link session as claimant |
| Time | `share.expires_at > now()` and, for links, `link.expires_at > now()` | Same |
| File state | `upload_status = 'verified'`, not blocked. Scan policy satisfied (Phase 6). | Same |
| Burn | Atomic claim (§5.3) unless the requester is the creator | Atomic claim |
| Rate limit | Per device and per network space | Per link session and per link |
| Log | `downloads` row (`url_issued`) | Same, with `link_id` |

**Presigned GET rules:**

- TTL **60 s** for downloads, **300 s** for image previews. GET only, one object.
- Objects carry `Content-Type` and `Content-Disposition: attachment; filename="<ascii-fallback>"; filename*=UTF-8''<percent-encoded>`, **fixed at upload through signed headers**. The design does not depend on `response-content-disposition` overrides, whose R2 support is uncertain (verified in SP-02, RISK-011).
- Downloads are served from R2's S3 hostname, **a different origin from the app**. Active content cannot touch app cookies or the DOM.
- **Previews:** only raster images whose magic bytes match JPEG, PNG, GIF, WebP or AVIF, ≤ 20 MB, rendered with `<img>`. No `next/image` optimization, which would route and cache private bytes on the web server. **No inline SVG, HTML, PDF or video in the MVP.**
- **Text** is rendered as plain text (React-escaped). No Markdown or HTML rendering. Auto-linked URLs get `rel="noopener noreferrer nofollow ugc"`.
- Presigned URLs are bearer tokens reusable until expiry, hence short TTLs (RISK-009).
- **Future option (Phase 6+):** a Cloudflare Worker download gateway using the R2 binding. It would enable a custom download domain, exact completion tracking and per-link bandwidth caps.

---

## 7. Upload validation and content safety (DEC-025)

### 7.1 At upload initialization (server)

- File count, per-file size, total size and daily upload bytes against entitlements.
- Expiry choice, burn flag and link options against entitlements.
- Declared MIME type and extension against the policy in §7.4.
- Filename sanitization (§7.2).
- Turnstile for anonymous users when risk rules trigger (for example, above N shares per day). *(Not in Phase 1: Turnstile guards anonymous sign-in only.)*
- **Signed PUT (Phase 1 as built).** Each file gets one presigned `PUT` (15 min, never beyond the upload deadline or the share's expiry; each expiry is recorded in `files.upload_url_expires_at` before the URL is handed out) that signs `Content-Type`, `Content-Disposition`, `Cache-Control`, **`Content-Length`** (storage refuses any other size, DV1-15) and **`If-None-Match: *`** (write-once: the object can't be replaced once it exists, DV1-18). Storage keeps headers the signature doesn't cover, so §7.3 checks them.

### 7.2 Filename sanitization

- Unicode NFC normalization.
- Strip control characters (U+0000–U+001F, U+007F), **bidirectional overrides** (U+202A–U+202E, U+2066–U+2069, used for `invoice‮fdp.exe` spoofing) and zero-width characters.
- Replace `/ \ : * ? " < > |`. Trim leading and trailing dots and spaces. Avoid Windows reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1–9`, `LPT1–9`).
- ≤ 255 UTF-8 bytes, preserving the extension. Show a double-extension warning (`report.pdf.exe`).
- Original names are stored only in Postgres, **never in object keys or realtime payloads**.

### 7.3 At upload completion

- `HeadObject` size must **equal** the declared size and be within limits. Otherwise the object is deleted and the file rejected.
- The share must still be `pending_upload` and unexpired, and the upload deadline not passed, checked under lock with the database clock (Phase 1 F1-15).
- The stored `Content-Type`, `Content-Disposition` and `Cache-Control` must equal the signed values, and there must be **no `Content-Encoding`** (a browser would decode it on download). Otherwise the object is deleted and the file rejected (`metadata_mismatch`; Phase 1 security review M1).
- Ranged GET of the first 4,100 bytes for magic-byte detection. This sets `detected_mime` and `preview_kind`.
- If the declared type is image but the bytes are not, the file is kept as a generic file with no preview.

### 7.4 Executable and risky file policy (proposal; Q-010)

| Context | Executables, scripts, installers, disk images | Archives |
|---|---|---|
| Local share (visible to everyone on the network) | Allowed, with a warning badge and a confirmation before download (*"Anyone on this network could have posted this"*) | Allowed, with a warning |
| Remote link from a Free/anonymous user | **Blocked** until malware scanning exists (Phase 6) | Allowed, with a warning |
| Remote link from Pro/Team | Allowed with a warning. After Phase 6, a `clean` scan is required before remote download. | Allowed, with a warning |

Detection uses extension **and** magic bytes: PE/MZ, ELF, Mach-O, MSI/OLE, APK/JAR (ZIP with a manifest), `.bat .cmd .ps1 .vbs .js .jse .wsf .hta .scr .lnk .reg .sh .command`, `.iso .img .dmg`.

**Phase 2 as built (`lib/server/security/file-policy.ts`; Q-010 answered by the owner on 2026-10-16: block for anonymous/Free remote sharing, archives allowed with a warning, local sharing unchanged):** Free (every user) blocks `executable`, `script` and `disk_image` flags in remote links (`422 REMOTE_FILE_BLOCKED` at link creation, and again before any viewer URL); link-only shares refuse them by name at upload start and by content at completion. Archives pass with the `archive` flag, and the share page asks before downloading them. Content detection gained APK/JAR (a ZIP whose first entry is the manifest) and the installer extensions `pkg`, `mpkg`, `appimage`, `xapk` (DV2-18). MSI/OLE content is not sniffed (it would also flag old Office documents); `.msi` is caught by extension. Local shares are unchanged.

### 7.5 Malware scanning (Phase 6)

- Asynchronous scanning (for example ClamAV in a container on a small VPS or Cloudflare Containers) for files up to a size limit. Records `scan_status`.
- **Do not send user files to public multi-scanner services** such as VirusTotal: submitted files can be shared with third parties.

### 7.6 Illegal content and abuse handling

- Report button on share pages, local feed items and room items → `POST /api/v1/reports` (Turnstile) → `app.abuse_reports` → operator notification.
- Operator actions: block the share or link (`status = 'blocked'`, links revoked, objects deleted or quarantined as legal advice requires), block a whole network space (`network_spaces.status = 'blocked'`), audit, reporter follow-up.
- **Legal obligations vary by jurisdiction.** For example, US providers must report apparent child sexual abuse material to NCMEC once aware (18 U.S.C. § 2258A). The EU Digital Services Act imposes notice-and-action duties. **Legal review is required before public launch** (RISK-005, Q-022). Hash-matching tools are evaluated in Phase 6.
- **Phase 2 as built:** `POST /api/v1/reports` (a device that can see the share, or a link viewer holding the link's grant; Turnstile where configured; 10 an hour per network key and per reporter); each report is stored, audited (`report.created`) and logged as the warn event `abuse.report_received`. **Nothing notifies a person:** Phase 2 has no email, chat, SMS or pager alert (owner decision 2026-10-16); the alert, its channel and the named operator are future operational requirements (Q-022, DV2-11). Takedown is `app.admin_block_share` / `app.admin_block_link`, run from the dashboard per the [takedown runbook](runbooks/takedown.md). **Not built:** quarantine or evidence preservation; blocked files are queued for deletion like any ended share (RISK-031).

### 7.7 Deleting objects while upload URLs are live (Phase 1 as built)

A presigned upload URL can't be revoked before it expires. If a deleted object's key were simply freed, its write-once URL could create the object again (Phase 1 F1-12). So:

- Each URL's expiry is recorded (`files.upload_url_expires_at`) before the URL is handed out, and no URL outlives the upload deadline or the share's expiry.
- Ending a share or rejecting a file queues its object in the outbox as before. When the executor claims it (`app.claim_object_deletions`) while a URL may still be live (its expiry plus 5 min of clock-skew grace), it **overwrites the object with an empty tombstone** instead of deleting it. The content is gone at once; the key stays taken, so storage refuses the URL (412). The tombstone is deleted when the hold ends.
- Completion re-checks the share and the deadline under lock, so a deleted, failed or expired share never comes back.
- Every executor (the Phase 1 request-time executor and sweep, the Phase 3 janitor) must follow this rule.

---

## 8. Authentication and session security

| Topic | Design |
|---|---|
| Devices | Supabase anonymous sign-in with CAPTCHA/Turnstile. Enabling CAPTCHA in Supabase applies to all auth flows, so account forms need tokens too. |
| Accounts (Phase 4) | Email magic link and/or OAuth (Q-014). Optional TOTP MFA. MFA **required** for operator accounts. |
| API keys | Publishable key in the browser. **Secret key only on the server and Edge Function.** Supabase rejects secret keys from browsers. Legacy `anon`/`service_role` keys disabled after setup (deprecated by end of 2026). |
| JWT | Verified server-side on every request (JWKS / `getClaims`, confirmed in SP-03). Consider a 30-minute expiry (instead of 1 h) to shorten realtime revocation lag. |
| Session transport | **As built in Phase 1 (DV1-14):** the browser keeps its Supabase session and sends the access token as `Authorization: Bearer`; the server verifies it on every request and never refreshes it (no refresh-token rotation races; the header can't be sent cross-site). Planned originally: `@supabase/ssr` cookies refreshed in `proxy.ts`. Link sessions (Phase 2): `__Host-link_session`, httpOnly. |
| Device binding | `X-Device-Id` must belong to `auth.uid()`. Revoked devices get 401 and the client resets. |
| CSRF | Exact Origin allow-list on mutations, JSON-only bodies (a body-less DELETE needs only the Origin), bearer header that other sites can't send, no GET mutations |
| Anonymous → account | `linkIdentity`/`updateUser` keeps the user ID. Signing into an **existing** account runs a merge flow that requires the still-valid anonymous access token as proof (Phase 4, RISK-024). |
| Operator tools | Phase 2–3: takedown SQL functions run only from the MFA-protected Supabase dashboard, each call writing an audit event. Phase 4+: optional web admin for allow-listed operator accounts with **required** MFA. Every action is audited. |

---

## 9. Authorization matrix

Legend: ✅ allowed · ⚙️ allowed if a setting or entitlement permits · ❌ denied (404 wherever the caller must not learn that the item exists) · — not applicable.

"Same network" always means the server-derived current network with status `ok` (§3.6).

**Local mode (Phase 1+):**

| Action | Device on the same network | Device on another network | Share creator (any network) | Link viewer | Operator |
|---|---|---|---|---|---|
| See the local feed and local share details | ✅ | ❌ 404 | ✅ own shares ("My uploads") | ❌ | ❌ (reports only) |
| Post to the network | ✅ | ❌ | — | ❌ | ❌ |
| Get download/preview URL for a local share | ✅ | ❌ 404 | ✅ | ✅ within target | ❌ |
| Edit a local text share | ❌ (Q-021) | ❌ 404 | ✅ | ❌ | ❌ |
| Delete a local share | ❌ | ❌ 404 | ✅ | ❌ | ✅ (block) |
| Create or revoke a link for a share | ❌ | ❌ 404 | ✅ | ❌ | ✅ (revoke) |
| Set a link password (Pro) | ❌ | ❌ | ✅ entitlement | ❌ | ❌ |
| See devices present ("N devices here now", labels) | ✅ | ❌ | — | ❌ | ❌ |
| Report content | ✅ | ❌ | — | ✅ | — |
| Block a share, link or network space | ❌ | ❌ | ❌ | ❌ | ✅ |

**Phase 2 as built:** the link-viewer column holds, and is tested route by route in `tests/integration/authz-matrix.test.ts` with two viewer actors (this share's link, another share's link). A link viewer reports a share through its link; creating, listing, revoking and re-coding links are creator-only (403 `NOT_CREATOR` on the share's network, 404 elsewhere). Blocking is SQL-only (no operator endpoint before Phase 4).

**Rooms (Phase 4–5):**

| Action | Non-member | Private-room member | Room owner | Share creator | Link viewer | Workspace admin (Phase 5) | Operator |
|---|---|---|---|---|---|---|---|
| List room shares | ❌ 404 | ✅ | ✅ | — | ⚙️ room link only | ✅ | ❌ (reports only) |
| Create a share in the room | ❌ | ✅ | ✅ | — | ❌ | ✅ | ❌ |
| Edit a text share | ❌ | ✅ (Q-021) | ✅ | ✅ | ❌ | ✅ | ❌ |
| Delete a share | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ (block) |
| Create a share link | ❌ | ⚙️ own shares | ✅ | ✅ | ❌ | ✅ (policy) | ❌ |
| Create a room link / invite | ❌ | ❌ | ✅ entitlement | — | ❌ | ✅ (policy) | ❌ |
| Remove member | ❌ | self only | ✅ | — | ❌ | ✅ | ❌ |
| Change room settings / delete room | ❌ | ❌ | ✅ | — | ❌ | ✅ | ❌ |

**Account (Phase 4+):** transfer history is visible to its own user (Pro) and within workspace scope to Team admins. Operators see audit data only.

---

## 10. Rate limiting and abuse protection

Initial values are proposals; tune them from production data. Implemented as `app.rate_limit_hit(key, limit, window)`, an atomic fixed-window upsert in Postgres (DEC-020), plus one coarse Cloudflare edge rule on `/api/`.

| Action | Keys | Initial limit | On exceed |
|---|---|---|---|
| Anonymous sign-in | IP (Supabase built-in) | 30/h per IP (Supabase default; may need raising for CGNAT, since Turnstile is the main control) | 429 from Supabase |
| Register device | user | 10/h | 429 |
| Network observe | device | 30/min | 429, client backs off |
| Network probe (dual-stack) | nonce, network key | 1 per nonce and family · 60/min per network key | 429 |
| Local feed | device | 60/min | 429 |
| Create share (upload init) | user, network key | Free: 30/h, 2 GB/day/user, 10 GB/day/network key · Pro: 300/h, 200 GB/day | 429 / `QUOTA_EXCEEDED` |
| Complete upload | user | 120/min | 429 |
| Text create/edit | user, network space or room | 60/min/user · 300/min per space or room | 429 |
| Download/preview URL | device or link session, link, network space | 120/min per device/session · Free links: 500 issuances/day per link | 429 / Turnstile |
| Create link | user | Free: 30/h · Pro: 300/h | 429 |
| Unlock link | link, network key | 30/10 min per link · 60/10 min per network key | 429 |
| Resolve short code | session/device, network key, global | 5 fails/10 min then Turnstile · 20 fails/day/network key gives a 24 h block · global alert | 429 / challenge |
| Password attempt (Phase 4) | link, network key | 10 fails/15 min/link, then 15 min lock + Turnstile · 20 fails/h/network key | 423 / 429 |
| Invite accept (Phase 4) | invite, network key | 10/10 min per invite · 30/h per network key | 429 |
| Abuse report | network key | 10/h + Turnstile | 429 |

**Phase 2 as built (`lib/server/ratelimit/limits.ts`):** create link 30/h per user; list links 60/min per device; revoke 60/min per user; new code 30/h per user; unlock 30/10 min per link and 60/10 min per network key; viewer content 60/min per link session; viewer URLs 120/min per link session plus 500/day per link (downloads and previews together, DV2-15; from the link's entitlement snapshot); codes as in §4.4; reports 10/h per network key and 10/h per reporter. Network keys for these limits are derived per request (`lib/server/network/requester.ts`), never stored with a session. Kill switches `remote_links_enabled` and `short_codes_enabled` are in the table and answer `503`. **Accepted by the owner as implemented (Q-027, 2026-10-16):** no limit is loosened or added. Two consequences to know: the per-link unlock limit counts every attempt, so at most 30 new browsers can open one link in 10 minutes (RISK-033); and only failed code attempts are counted, so successful resolutions are limited only by Cloudflare's per-IP rule (RISK-032).

**Phase 1 as built:** `lib/server/ratelimit/limits.ts` implements register device (10/h per user), rename (20/h), observe (30/min per device), local feed and My uploads (60/min per device), share detail (120/min per device), create share (30/h per user plus daily volume 2 GB per user and 10 GB per network space, counted in KiB), complete (120/min per user), text create/edit (60/min per user, 300/min per space), delete (60/min per user) and download/preview URLs (120/min per device). Every 429 carries `Retry-After`.: `uploads_enabled`, `anonymous_uploads_enabled`, `local_sharing_enabled`, `remote_links_enabled`, `short_codes_enabled`. Also per-network blocks (`network_spaces.status = 'blocked'`) and per-user suspension (`app.user_flags`).

---

## 11. Web security headers and Content Security Policy

Set in `proxy.ts`. Nonces require dynamic rendering, which app pages already use.

| Header | Value |
|---|---|
| `Content-Security-Policy` | See below |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` (enable `preload` only once the domain is final) |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` for the app, **`no-referrer`** on `/s`, `/j`, `/c` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()` (revisit if in-app QR scanning is added) |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `X-Frame-Options` | `DENY` (legacy, alongside CSP `frame-ancestors 'none'`) |
| `Cache-Control` | `no-store` on API responses and pages with user data |
| `X-Robots-Tag` | `noindex, nofollow` on `/s`, `/j`, `/c`, `/rooms` |
| `X-Powered-By` | Removed (`poweredByHeader: false`) |

CSP (app and share pages; hosts filled from env at build/boot):

```text
default-src 'self';
script-src 'self' 'nonce-{nonce}' 'strict-dynamic' https://challenges.cloudflare.com;
style-src 'self' 'nonce-{nonce}';
style-src-attr 'unsafe-inline';
img-src 'self' blob: data: https://{r2-s3-host};
connect-src 'self' https://{project}.supabase.co wss://{project}.supabase.co https://{r2-s3-host};
frame-src https://challenges.cloudflare.com;
font-src 'self';
object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none';
upgrade-insecure-requests
```

Notes:

- `{r2-s3-host}` must be the **exact** R2 S3 host used by presigned URLs, not `*.r2.cloudflarestorage.com`, which would allow any R2 account.
- **`style-src-attr 'unsafe-inline'` (verified and adopted in Phase 0, 2026-09-29, DEC-035).** Radix UI server-renders inline `style` attributes, which nonces cannot cover. A production build with a Radix Progress bar showed the browser blocking the attribute (`style-src-attr` violation) and the bar drawing at the wrong width. The directive allows only `style=""` attributes: they cannot run script, `<style>` elements still need the nonce, and `script-src` is unchanged. Development builds already allow inline styles, so only production builds show the problem ([phase 0 F-7](phases/phase-0-foundation.md#182-findings-during-implementation)).
- **Strict-CSP compatibility found in Phase 1 (F1-5):** zod 4 probes `new Function`, which the browser reports as a `script-src eval` violation even though zod catches it, so browser-side zod runs with `jitless`. Radix's scroll lock inserts a `<style>` tag; the root layout passes the request's nonce to `get-nonce` so the tag carries it. The multi-device E2E tests assert zero violations.

---

## 12. Secrets and key management

| Secret | Used by | Storage | Rotation | Blast radius if leaked |
|---|---|---|---|---|
| `SUPABASE_SECRET_KEY` | **Nothing yet.** The server validates it when set (`lib/server/env.ts`), but no code uses it. Planned for server admin operations and the Phase 3 storage janitor (not built). | Host env (and Edge Function secrets once the janitor exists) | 90 days / on incident | Full data access (bypasses RLS) |
| `DATABASE_URL` (least-privilege app role) | Server | Host env | 90 days | Application data |
| R2 access keys: **web** token (object read/write, one bucket), **janitor** token (separate) | Server; janitor | Env | 90 days | Bucket objects |
| `NETWORK_KEY_SECRET` (current + previous) | Server | Env | Yearly or on incident, with a 100-day overlap (§3.2) | De-anonymization of network keys (IPv4 keys can be brute-forced with the secret). It does **not** by itself grant access to local content, which also needs a request from that network. |
| `LINK_PEPPER`, `CODE_PEPPER`, `INVITE_PEPPER` (versioned) | Server: `LINK_PEPPER` and `CODE_PEPPER` since Phase 2 (link secrets, short codes; ≥ 32 characters, different from each other, required when deployed); `INVITE_PEPPER` from Phase 4 | Env (`PEPPER_VERSION`, `*_PREVIOUS` during a rotation) | Rarely (version column allows it) | Offline verification of leaked hashes |
| `ORIGIN_SHARED_SECRET` (2 accepted during rotation) | Cloudflare Transform Rule and `proxy.ts` | Cloudflare and env | 90 days | Origin-lock bypass → IP spoofing |
| Turnstile secret key | Supabase Auth, which verifies the Turnstile token at anonymous sign-in; **since Phase 2 also the server** (`TURNSTILE_SECRET_KEY`: code-guessing escalation and reports, required when deployed, DV2-6) | The Supabase project's Auth captcha settings and the host env | Yearly / incident | Bot protection bypass |
| `JANITOR_TRIGGER_SECRET` | pg_cron (Vault) → Edge Function | Supabase Vault and function secrets | 90 days | Janitor triggering (it only deletes outbox entries) |
| Billing API key / webhook secret (Phase 4) | Server | Env | Per provider guidance | Billing tampering |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` (only if multi-instance) | Next.js | Env | On deploy policy | Action closure decryption |

Rules:

- Never prefix secrets with `NEXT_PUBLIC_`.
- Validate all environment variables at boot with zod. The process must not start with missing or placeholder secrets.
- Separate values per environment. Least-privilege tokens.
- Secret scanning in CI and GitHub push protection.
- Incident rotation runbook (Phase 6).

---

## 13. Privacy and data minimization

| Data | Retention | Notes |
|---|---|---|
| Raw IP addresses | **Not stored by the app**, and never sent to the database: the egress-list lookup sends only the IPv4 /24 or IPv6 /48 around the address (Phase 1 F1-13, tested with full statement logging) | Used transiently in memory to compute network keys and match the egress lists. **Supabase Auth stores the client IP of each session (`auth.sessions.ip`) and in its audit log**, for as long as the session exists (Phase 1 F1-14, Q-031). Cloudflare and the host may log it per their settings (08 §4–§5). |
| Network spaces (network key, status, device counts) | Until 30 days after the last active share or presence | Pseudonymous personal data, stated in the privacy policy |
| Network presence | 10 min "present"; rows deleted 24 h after last seen | Needed for realtime authorization and the large-network cap |
| Dual-stack bindings, probe nonces, IPv4↔IPv6 links | 10 min · 60 s · 7 days | CGNAT detection |
| IP-derived HMACs in logs/audit | ≤ 7 days (security logs) | Rate-limit keys expire with their windows |
| File bytes | Deleted when a share is deleted or a file rejected (tombstone first while an upload URL may be live, deleted ≤ 20 min later). After expiry: at the next storage sweep (Phase 1) or by the janitor (Phase 3). Backstop: lifecycle rule per class, 8 / 31 / 91 days | — |
| Text content | **Nulled** in the same transaction that ends the share | — |
| Share/file metadata tombstones | Free: 30 days after end (abuse handling). Pro/Team: per history retention (Q-015). | — |
| Download log | Free: 30 days. Pro/Team: per plan. | — |
| Audit events | Security events ≥ 90 days. Team: per workspace policy. | — |
| Anonymous users | Deleted after 30 days of inactivity | Cascades devices and presence |
| Realtime messages | Supabase keeps broadcast-from-DB messages ≥ 72 h and ≤ 4 days | Hence ID-only payloads |
| Link viewer sessions (Phase 2) | Cookie 12 h from the last unlock or code; the stored SHA-256 is deleted 24 h after expiry by `purge-ephemeral` | No viewer identity, network key or IP is stored with a session (DV2-10) |
| Link grants (Phase 2) | ≤ 12 h; deleted after expiry by `purge-ephemeral` | — |
| Link and code hashes (Phase 2) | Link rows stay with their share until the Phase 3 tombstone purge; code HMACs are cleared once the code expires | Secrets and codes are never stored in clear |
| Downloads by link viewers (Phase 2) | As the download log (30 days, purge in Phase 3), with the link ID and browser family only | — |
| Abuse reports and evidence | Per legal advice. As built (Phase 2): category, details, optional email, reporter kind, the reporting anonymous user for devices; kept until reviewed, no retention job (Q-022). No evidence preservation (RISK-031). | — |
| Rate counters keyed by network key (Phase 2) | Until their window ends; a code block 24 h | Keyed hashes, not addresses |

GDPR and similar laws: hashed identifiers are still personal data. Before public launch you need:

- A privacy policy and a subprocessor list (Supabase, Cloudflare, host, billing, email, error monitoring).
- A deletion process, and an export process in Phase 4/6.
- A data processing agreement for Team customers.

Keep app and share pages free of third-party trackers. If analytics are needed, use a privacy-friendly tool behind consent where required.

---

## 14. Logging, audit and security monitoring

- **Audit events:**
  - Networks: `network.status_changed{from, to, reason}` (for example to `shared_egress` or `too_large`), `network.blocked`.
  - Rooms and membership (Phase 4+): `room.created`, `member.joined{via}`, `member.removed`, `invite.created`/`accepted`/`revoked`.
  - Shares: `share.created{scope}`/`deleted`/`claimed`/`blocked`.
  - Links and downloads: `link.created`/`revoked`, `link.unlock_failed` (aggregated), `link.password_failed`, `code.resolve_failed` (aggregated), `download.url_issued`.
  - Operations: `report.created`, `admin.block`.
- **Phase 2 as built:** audit events `link.created`, `link.revoked`, `link.code_created`, `report.created` (actor `device` or `link_viewer`), `code.resolve_failed` and `code.resolve_blocked` (at the challenge and block thresholds, without network data), `admin.block` (actor `operator`, with the operator's name and reason), and `share.ended` with reason `blocked`. Unlock failures are aggregated by the rate limiter (log `link.unlock_rate_limited`); download URLs are recorded in `downloads`, not as audit events. Log events that future alerts will watch (Phase 2 delivers none, Q-022): `abuse.report_received`, `code.resolve_failures`, `code.resolve_blocked`, `code.resolve_failure_spike`, `link.unlock_rate_limited`.
- **Redaction:** cookies, `authorization`, `x-origin-auth`, `secret`, `code`, `password`, probe nonces, URL fragments and `X-Amz-Signature` query values are removed before logging and before sending errors to monitoring.
- **Alerts:**
  - Spikes in code or password failures.
  - Origin-lock rejections (possible bypass attempts). **Any** request reaching application code without a valid origin secret in production is a critical alert, because it could mean a spoofed network.
  - `unavailable` network spikes (proxy misconfiguration).
  - Spikes in spaces switching to `shared_egress` or `too_large` (classification drift or abuse).
  - Janitor backlog or failures.
  - Abuse report volume.
  - Unusual per-link download volume.

---

## 15. Security testing requirements

Defined in [09-testing-strategy.md](09-testing-strategy.md). At minimum:

- Cross-network isolation (G1–G7), including leaving a network and dual-stack binding replay.
- IDOR matrix per endpoint.
- Header spoofing and origin bypass.
- Eligibility guards fail closed (`shared_egress`, `too_large`, `blocked`, `unavailable`).
- Code and password brute-force limits.
- 50-way burn-claim race.
- Storage reservation race.
- CSRF and Origin checks.
- Realtime channel authorization.
- Enumeration response uniformity.
- Filename spoofing.
- Unfurler non-consumption.
