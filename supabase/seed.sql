-- Local development and CI only (supabase db reset). Never applied to hosted projects.
-- The Next.js server connects as app_server (04 §1); hosted environments set a generated
-- password per environment instead (see the note at the top of the baseline migration).
alter role app_server with login password 'app-server-local-only';

-- Phase 3: the storage janitor and the egress-list loader have their own least-privilege roles
-- (phase 3 §17.11). Hosted environments enable their logins in the janitor runbook.
alter role app_janitor with login password 'app-janitor-local-only';
alter role app_egress_loader with login password 'app-egress-loader-local-only';

-- The cron trigger reads the janitor's URL and shared secret from Vault (phase 3 §17.5). These
-- are local-only values: the URL is the local stack's Kong gateway as seen from the database
-- container, and the secret matches supabase/functions/.env written by `pnpm stack:start`.
select vault.create_secret('http://kong:8000/functions/v1/storage-janitor', 'storage_janitor_url',
                           'Local stack only: where pg_net posts janitor runs');
select vault.create_secret('local-only-janitor-trigger-secret-0000000000000001', 'storage_janitor_secret',
                           'Local stack only: bearer secret for the storage-janitor function');

-- Phase 4C: billing reconciliation (phase 4 §17.7.7). pg_net posts to the web app's reconcile route
-- with this bearer secret, only while the billing_reconcile runtime flag is on (off by default). Local
-- values only: the URL is `pnpm dev` as seen from the database container, and the secret matches
-- LOCAL.billingReconcileSecret in scripts/local-stack.cjs.
select vault.create_secret('http://host.docker.internal:3000/api/v1/internal/billing/reconcile', 'billing_reconcile_url',
                           'Local stack only: where pg_net posts billing reconciliation runs');
select vault.create_secret('local-only-billing-reconcile-secret-00000000000001', 'billing_reconcile_secret',
                           'Local stack only: bearer secret for the billing reconcile route');
