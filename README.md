# Local Saver

*Working name until Q-020 is answered.*

A web app for moving text, images and files between devices:

- **Local mode:** every device on the same Wi-Fi or network automatically sees what is posted there.
- **Remote mode:** a device on another network gets access only through a secure link, its QR code or a share code.

**Status:** Phase 1 (local sharing) is implemented and under review; remote sharing (Phase 2) has not started. The plan, decisions and phase status live in [`project-docs-workthrough/`](project-docs-workthrough/README.md); start there.

## Requirements

- Node.js 22 (see `.node-version`; Node 24 is decided by spike SP-01)
- pnpm 12.4.2 (pinned in `package.json`; `corepack enable` picks it up)
- Docker Desktop, for the local stack (Supabase and RustFS)

## Getting started

```bash
pnpm install
pnpm stack:start                  # Supabase (Postgres, Auth, Realtime) and RustFS (local stand-in for R2)
pnpm stack:env > .env.local       # local-only values for every variable
pnpm dev                          # http://localhost:3000
```

The app validates its environment at startup (`lib/server/env.ts`) and refuses to start when it is misconfigured. Locally, `TEST_CLIENT_IP_DEFAULT` puts every browser on one simulated network, so two browser windows (or a normal and a private window) see each other's posts. Without the stack, the app still starts and shows that sharing isn't set up.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js development server, production build, production server |
| `pnpm typecheck` / `pnpm lint` | Route type generation + TypeScript, and ESLint |
| `pnpm test` | Unit tests (Node) and component tests (jsdom) with Vitest |
| `pnpm test:integration` | API integration tests against a real `next start` on the local stack (needs `pnpm build` and `pnpm stack:start`) |
| `pnpm test:e2e` | Playwright against the production build: Phase 0 smoke tests, and the Phase 1 multi-device and emulated-phone tests when the stack is running (first time: `pnpm exec playwright install chromium webkit`) |
| `pnpm stack:start` / `pnpm stack:stop` | Start or stop Supabase and RustFS |
| `pnpm stack:env` | Print a `.env.local` for the local stack |
| `pnpm db:reset` / `pnpm db:test` | Re-apply migrations and seed / run the pgTAP database tests |
| `pnpm db:types` | Regenerate `lib/server/db/types.gen.ts` from the local database |
| `pnpm check` | Typecheck, lint and unit/component tests |

## Layout

| Path | Contents |
|---|---|
| `app/` | Pages ("This network" home, My uploads) and `app/api/v1/**`, thin JSON route handlers |
| `proxy.ts` | Origin lock, request ID, CSP nonce and security headers for every request |
| `instrumentation.ts` | Boot-time environment validation |
| `lib/server/` | Server-only code (`import "server-only"`): environment, auth, network keys and guards, shares, storage, rate limits, database |
| `lib/shared/` | API contracts (zod) and plan limits shared by server and browser |
| `lib/client/` | Browser code: Supabase and API clients, TanStack Query, Zustand stores, Realtime bridge, uploader |
| `components/` | `ui/` (shadcn/ui, Radix base) and `local/` (the Phase 1 interface) |
| `supabase/` | Supabase CLI config, SQL migrations, local seed, pgTAP tests |
| `scripts/` | Local stack helper |
| `infra/` | Cloudflare and R2 configuration as code |
| `tests/` | `unit/`, `component/`, `integration/`, `e2e/` |

## Security notes

- Production traffic must come through Cloudflare. With `TRUST_PROXY_MODE=cloudflare` the app rejects any request without the origin secret, and only then trusts `CF-Connecting-IP` ([infra/cloudflare/README.md](infra/cloudflare/README.md)). That IP decides which network's posts a device sees.
- Never set `ALLOW_TEST_CLIENT_IP` or `TEST_CLIENT_IP_DEFAULT` outside tests and local development; a production build refuses to start with them.
- `.env*` files are git-ignored except `.env.example`, which lists variable names only.
- Development builds allow inline styles and `eval`; production builds don't. Check new UI against a production build (`pnpm build && pnpm test:e2e`); the E2E tests fail on CSP violations on the pages they visit.
