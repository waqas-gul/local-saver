# Email (Supabase Auth)

What sends email, how each environment is set up, and the DNS records a sending domain needs ([phase 4 §17.5.8](../../project-docs-workthrough/phases/phase-4-pro-accounts.md#1758-email-delivery), [§30](../../project-docs-workthrough/phases/phase-4-pro-accounts.md#30-phase-4d-tenth-task-p4-23-email-2026-10-18)).

**Status.**
- **Built and tested locally**, with mailpit (P4-23).
- **Nothing here has been applied to staging or production yet.** That needs the SMTP provider (D4-8), the domain (Q-020) and the staging project.
- Replace `example.invalid` with the real domain once Q-020 is answered. `.invalid` can never resolve, so a forgotten placeholder fails safely.
- Provider names, hosts and record shapes below are as each provider published them in October 2026. **The provider's dashboard is authoritative**: copy its exact values.

## 1. What sends email

**Only Supabase Auth** (D4-7). The app sends nothing in Phase 4: it has no email SDK and no SMTP credential. Billing receipts and dunning come from the billing provider (merchant of record).

| Auth email (`config.toml` key) | Sent when | Carries | Subject |
|---|---|---|---|
| `confirmation` | The first code to a new address (`signInWithOtp` creates the account) | The 6-digit code, and the link | Your Local Saver sign-up code |
| `magic_link` | A sign-in to an existing account. Also P4-22's deletion re-authentication. | The code and the link | Your Local Saver sign-in code |
| `email_change` | Adding an email to an anonymous browser (the upgrade), or changing an account's email. Both addresses get one (secure email change). | The code and the link (one per address) | Confirm your email for Local Saver |
| `reauthentication` | Supabase's own step-up (`reauthenticate()`). The app doesn't use it. | The code only | Your Local Saver confirmation code |
| `recovery` | A password-reset request, which anyone can make for any address | **Nothing to sign in with**: the app has no passwords (D4-2). It says so, and links to `/login`. | Local Saver has no password to reset |

**Not customised:**
- `invite`: only an operator with the secret key can send it, and accounts are made by signing in, so operators never invite.
- Supabase's security notifications (password changed, identity linked, MFA enrolled…): off. Turning on "identity linked" and "MFA factor enrolled" notices is an owner option (P4-24 touches MFA).

**The templates** are `supabase/templates/*.html`, referenced from `supabase/config.toml`. The same files go to every environment (§3).

## 2. Rules every template follows

These rules are checked by `tests/unit/email-templates.test.ts`. Delivery is checked by `tests/integration/email.test.ts`.

- **The code is in the body only**, never in the subject, where lock screens show it.
- **The link never points at Supabase's verify URL.**
  - It is `{{ .RedirectTo }}#confirm={{ .ConfirmationURL }}`: this app's `/auth/callback`, carrying Supabase's link in the fragment.
  - The page follows the link only after the person presses **Continue**, and only to this Supabase project's `/auth/v1/verify`.
  - **Why:** mail scanners (Microsoft Defender Safe Links, Mimecast and others) open every link in an email. Opening Supabase's link uses up the token, and with it the code in the same email: the person then gets "That code isn't right or has expired". This was reproduced locally (§30, finding 1). Supabase's email-template guide describes the same problem and this remedy.
  - **The fragment** never reaches the app's server or a `Referer` header. The page also sends `Referrer-Policy: no-referrer`, `Cache-Control: no-store` and `noindex` (`/auth/*`).
- **Plain HTML, nothing remote:**
  - no images, scripts, stylesheets, forms or tracking;
  - no address written into a template; every link comes from Auth's variables.
- **Internal notes are Go template comments** (`{{- /* … */ -}}`), which Auth drops. HTML comments would reach the recipient.
- **The stated lifetime ("It expires in 1 hour.") matches `otp_expiry` (3600 s).** Changing one means changing the other, in every environment.

## 3. Environments

| Setting | Local | Staging | Production |
|---|---|---|---|
| Delivery | mailpit (`http://127.0.0.1:54324`), started by `pnpm stack:start` | Custom SMTP, provider D4-8 | Custom SMTP, same provider |
| Sender | `Local Saver <no-reply@local-saver.test>` (`[local_smtp]`) | `Local Saver (staging) <no-reply@mail.staging.example.invalid>` | `Local Saver <no-reply@mail.example.invalid>` |
| Templates and subjects | `config.toml` | Pasted into the dashboard from `supabase/templates/*` (§4) | Same |
| `otp_length` / `otp_expiry` | 6 / 3600 | 6 / 3600 | 6 / 3600 |
| Per-address interval (`max_frequency`) | 1 s (tests ask for several codes) | **60 s**: the UI's resend timer assumes it (`RESEND_SECONDS`) | **60 s** |
| Emails per hour (project) | 5000 (tests) | Raised from the custom-SMTP default (§6) | Raised (§6) |
| Site URL | `http://127.0.0.1:3000` | `https://staging.example.invalid` | `https://app.example.invalid` |
| Redirect allow-list | `/auth/callback` on 3000, 3102, 3200 | `https://staging.example.invalid/auth/callback` only | `https://app.example.invalid/auth/callback` only |
| Confirm email, secure email change, manual linking | On | On | On (08 §5) |
| Captcha (Turnstile) | Off | On | On |

**The template link relies on the allow-list.** `{{ .RedirectTo }}` is the redirect the app asked for (always `<origin>/auth/callback`). If that redirect isn't on the list, Auth substitutes the Site URL: the link then opens the home page and does nothing, though the code still works.

**Never push the local `config.toml` to a hosted project** (`supabase config push`). It holds local-only values: the 1 s interval, 5000 per hour, the local Site URL. Set hosted values in the dashboard.

## 4. Configuring a hosted project (staging first)

1. **SMTP** (Authentication → Emails → SMTP Settings), from the provider's values (§5):
   - sender email and name (§3);
   - host, port, username;
   - password: the provider credential. **It lives only in Supabase**: the app never has it, and it is in no `.env` (08 §8).
   - minimum interval between emails: **60 s**.
2. **Templates** (Authentication → Emails → Templates): for each of the five emails in §1, the subject and the body of `supabase/templates/<file>.html`, pasted exactly, template comment included (Auth drops it).
   - Check: send each email to a test inbox and compare with mailpit's copy of the same email locally.
3. **Rate limits** (Authentication → Rate Limits): emails per hour (§6); keep the per-IP sign-in and verification limits at 30 per 5 minutes.
4. **URL configuration:** the Site URL and the allow-list from §3.
5. **Providers → Email:** confirm email on, secure email change on, OTP expiry 3600, OTP length 6.
6. **Attack protection:** captcha (Turnstile) on, with the secret key ([cloudflare §6](../cloudflare/README.md#6-turnstile-phase-1-phase-2)).
7. **The checks of §7**, with the evidence written into the staging verification log.

## 5. Provider (D4-8) and DNS (Q-020)

**Sending domain:** a subdomain, `mail.example.invalid` (`mail.staging.example.invalid` for staging). It keeps the reputation of sign-in email separate from the apex and from any future marketing mail.

**SMTP values, by candidate.** These are as each provider published them in October 2026; confirm them in the provider's dashboard.

| Provider | Host | Port | Username | Password |
|---|---|---|---|---|
| Resend | `smtp.resend.com` | 465 (TLS) or 587 (STARTTLS) | `resend` | An API key with sending access only |
| Postmark | `smtp.postmarkapp.com` | 587 (or 2525) | The server API token | The same token (transactional stream) |
| Amazon SES | `email-smtp.<region>.amazonaws.com` | 587 (STARTTLS) or 465 | SES SMTP credentials (generated in SES, not an IAM access key) | Same. Production access (out of the sandbox) is needed before launch. |

**DNS records for `mail.example.invalid`.** The provider shows the exact names and values when the domain is added; copy them.

In Cloudflare these are **DNS only** (grey cloud):
- MX and TXT records can't be proxied;
- a proxied DKIM CNAME breaks DKIM.

| Purpose | Type | Name (relative to `mail.example.invalid`) | Value |
|---|---|---|---|
| **DKIM** (the provider signs as this domain) | TXT (Resend, Postmark) or 3 × CNAME (SES) | Resend: `resend._domainkey`. Postmark: `<selector>pm._domainkey`. SES: `<token>._domainkey` ×3. | Resend and Postmark: the public key from the dashboard. SES: `<token>.dkim.amazonses.com`. |
| **Return path** (bounces) | MX (Resend, SES) or CNAME (Postmark) | Resend: `send`. SES: the custom MAIL FROM subdomain, for example `bounce`. Postmark: `pm-bounces`. | Resend and SES: `feedback-smtp.<region>.amazonses.com`, priority 10. Postmark: `pm.mtasv.net`. |
| **SPF** (on the return-path domain) | TXT | Resend: `send`. SES: `bounce`. Postmark: none needed, the CNAME covers it. | `v=spf1 include:amazonses.com ~all` (Resend, SES) |
| **DMARC** | TXT | `_dmarc` | Warm-up: `v=DMARC1; p=none; rua=mailto:dmarc-reports@example.invalid; adkim=r; aspf=r`. After 2–4 weeks of clean reports: `p=quarantine`. |

**Alignment.**
- DKIM's `d=` is `mail.example.invalid`, the From domain.
- SPF passes on the return-path subdomain, which is relaxed-aligned with it.
- Either one passing aligned is enough for DMARC; both should pass.

**Anti-spoofing for the rest of the domain** (owner's choice):
- if the apex `example.invalid` sends no mail, publish `v=spf1 -all` on it;
- give the apex a DMARC policy, with `sp=` for subdomains that don't send.

## 6. Rate limits and abuse

- **Per address:** one email per 60 s (`max_frequency`). The UI's **Send a new code** counts down 60 s after each code (P4-23). A request within the interval gets `over_email_send_rate_limit`, shown as "Too many attempts. Please wait a minute and try again."
- **Per project:** emails per hour.
  - When custom SMTP is first turned on, Supabase sets a low default: 30 per hour at the time of writing.
  - **Raise it** to about twice the expected peak hour of sign-ins, within the provider plan's limit. Otherwise every sign-in fails once the hour's budget is spent.
  - Watch it after launch.
- **Captcha (Turnstile)** on sign-in, sign-up and password-reset requests limits who can make Auth send mail.
- **Per IP:** sign-ins and verifications, 30 per 5 minutes (Supabase default).
  - Guessing a code from one address means 360 tries an hour against a million codes.
  - Many addresses together could try more. A shorter `otp_expiry` would reduce that; it is an owner option, and the emails' wording changes with it (§2).
- **Enumeration:** a password-reset request answers the same whether or not the address has an account, and mails only real accounts (tested). Supabase reveals an existing account in two other places: the upgrade's `email_exists`, and `otp_disabled` when a merge sign-in uses an unknown address. That is RISK-042, accepted pending the owner.

## 7. Staging delivery checks (not done yet)

These are the checks that §17.21 names for P4-23. Each one needs a real provider, domain and inbox; record the evidence here or in the staging log.

| # | Check | Evidence |
|---|---|---|
| E-1 | Each of the five emails of §1 arrives in Gmail, Outlook.com and iCloud, in the inbox. The headers show `spf=pass`, `dkim=pass` with `d=mail.staging.example.invalid`, `dmarc=pass`. | [OWNER] |
| E-2 | A deliverability checker (a mail-tester-style service) scores the sign-in email without spam warnings | [OWNER] |
| E-3 | **Link scanners:** in a Microsoft 365 mailbox with Safe Links, typing the code works after the email was scanned. Clicking the link shows **Continue**, then signs in. | [OWNER] |
| E-4 | The link opened in the browser that asked signs in. Opened in another browser, it says the link didn't work (PKCE), and the code still works where it was asked for. | [OWNER] |
| E-5 | A second code within 60 s is refused; the resend timer matches | [OWNER] |
| E-6 | Bounces: a send to a non-existent address at a real domain shows as a bounce at the provider and lands on its suppression list | [OWNER] |
| E-7 | Bounce and complaint alerts reach the alert recipient (D-5) | [OWNER] |
| E-8 | The dashboard templates match the repository's (§4.2) | [OWNER] |
| E-9 | DMARC aggregate reports arrive at the `rua` address | [OWNER] |

## 8. Monitoring and incidents (RISK-019)

- **Provider dashboard:** bounce rate and complaint rate. Starting alert thresholds, **[OWNER] to confirm**:
  - bounces above 2%;
  - complaints above 0.1%, well inside Gmail's and Yahoo's 0.3% sender rule.
- **Auth logs:** `over_email_send_rate_limit` across many addresses means the hourly budget (§6) is spent.
- **Provider outage:** sign-in by email code stops, and Google sign-in still works where configured.
  - Follow the [incident runbook](../../project-docs-workthrough/runbooks/incident.md).
  - Changing provider means new SMTP values, new DNS records, and DKIM propagation time. Keep the second candidate's account ready if the owner wants a quick switch.

## 9. Secrets

| Secret | Where | Rotation |
|---|---|---|
| SMTP password (the provider's API key or SMTP credential) | The Supabase project's SMTP settings only | Create a new key at the provider, set it in Supabase, send a test sign-in, then revoke the old key |

## 10. What is verified, and where

| Verified locally (P4-23) | Test |
|---|---|
| Every template's rules (§2) | `tests/unit/email-templates.test.ts` |
| Delivery to mailpit of the five emails: sender, subject, code, links only to this app | `tests/integration/email.test.ts` |
| A scanner opening the link leaves the code working; a used code spends the link; the token never reaches the app's server log | Same |
| A code works once, only for its address; a newer one replaces it; one older than 1 hour is refused; a second request at once is refused | Same |
| Auth's answers never carry the code; a reset request answers the same for unknown addresses and mails nobody | Same |
| The callback's **Continue** follows only this Supabase project's verify URL; the resend timer | `tests/component/account-ui.test.tsx` |
| In a real browser: a scanner that runs the page's script, then **Continue**, signs in | `tests/e2e/local-accounts.spec.ts` |

**Not verified** (staging and production): real SMTP delivery, the sending domain, SPF, DKIM and DMARC, inbox placement, real link scanners, bounces and complaints, and the production sender. §7 lists the checks.
