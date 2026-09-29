# Local Saver

*Working name until Q-020 is answered.*

A web app for moving text, images and files between devices:

- **Local mode:** every device on the same Wi-Fi or network automatically sees what is posted there.
- **Remote mode:** a device on another network gets access only through a secure link, its QR code or a share code.

**Status:** Phase 0 (foundation). No user-facing features yet. The plan, decisions and phase status live in [`project-docs-workthrough/`](project-docs-workthrough/README.md); start there.

## Requirements

- Node.js 22 (see `.node-version`; Node 24 is decided by spike SP-01)
- pnpm 12.4.2 (pinned in `package.json`; `corepack enable` picks it up)
- Docker Desktop, for the local Supabase database

## Getting started

```bash
pnpm install
cp .env.example .env.local        # empty values are fine for local development
pnpm dev                          # http://localhost:3000
```

The app validates its environment at startup (`lib/server/env.ts`) and refuses to start when it is misconfigured.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js development server, production build, production server |
| `pnpm typecheck` / `pnpm lint` | TypeScript and ESLint |
| `pnpm test` | Unit tests (Node) and component tests (jsdom) with Vitest |
| `pnpm test:e2e` | Playwright smoke tests against the production build (run `pnpm build` first; first time: `pnpm exec playwright install chromium`) |
| `pnpm db:start` / `pnpm db:stop` | Start or stop the local Postgres (Supabase CLI, Docker) |
| `pnpm db:reset` / `pnpm db:test` | Re-apply migrations / run the pgTAP database tests |
| `pnpm db:types` | Regenerate `lib/server/db/types.gen.ts` from the local database |
| `pnpm check` | Typecheck, lint and tests |

## Layout

| Path | Contents |
|---|---|
| `app/` | Routes. `app/api/v1/**` holds thin JSON route handlers. |
| `proxy.ts` | Origin lock, request ID, CSP nonce and security headers for every request |
| `instrumentation.ts` | Boot-time environment validation |
| `lib/server/` | Server-only code (`import "server-only"`): environment, security, network, HTTP wrapper, database |
| `lib/client/` | Browser code: TanStack Query client, Zustand stores, providers |
| `components/ui/` | shadcn/ui components (Radix base, `components.json`). Add more with `pnpm dlx shadcn@latest add <name>` |
| `supabase/` | Supabase CLI config, SQL migrations, pgTAP tests |
| `infra/` | Cloudflare and R2 configuration as code |
| `tests/` | `unit/`, `component/`, `e2e/` |

## Security notes

- Production traffic must come through Cloudflare. With `TRUST_PROXY_MODE=cloudflare` the app rejects any request without the origin secret, and only then trusts `CF-Connecting-IP` ([infra/cloudflare/README.md](infra/cloudflare/README.md)).
- Never set `ALLOW_TEST_CLIENT_IP` outside tests; a production build refuses to start with it.
- `.env*` files are git-ignored except `.env.example`, which lists variable names only.
- Development builds allow inline styles and `eval`; production builds don't. Check new UI against a production build (`pnpm build && pnpm test:e2e`); the smoke test fails on CSP violations on the pages it visits.
