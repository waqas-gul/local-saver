-- Local development and CI only (supabase db reset). Never applied to hosted projects.
-- The Next.js server connects as app_server (04 §1); hosted environments set a generated
-- password per environment instead (see the note at the top of the baseline migration).
alter role app_server with login password 'app-server-local-only';
