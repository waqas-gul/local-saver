-- Phase 0 baseline (04 §1, §6.1, §12): schemas, roles, deny-by-default grants,
-- extensions, runtime flags and the Postgres rate limiter (DEC-006, DEC-020).
--
-- Passwords are never set in migrations. Per environment, an operator runs:
--   alter role app_server with login password '<generated>';
-- and stores DATABASE_URL in the host's secret store (08 §5).

-- Extensions used by later phases (04 §9, DEC-017).
create extension if not exists citext with schema extensions;
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Roles. app_owner owns the objects; app_server is what the Next.js server uses.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_owner') then
    create role app_owner nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_server') then
    create role app_server nologin;
  end if;
end
$$;

-- A new login role gets the server default search_path ("$user", public), which misses
-- extensions (citext). Same value Supabase sets for postgres (phase 0 F-9).
alter role app_server set search_path = "$user", public, extensions;

-- The migration role must be a member to create objects owned by app_owner.
grant app_owner to current_user;

create schema if not exists app authorization app_owner;
create schema if not exists app_realtime authorization app_owner;

-- Nothing in app is reachable by client roles. The schema is also absent from the
-- Data API's exposed schemas (supabase/config.toml [api] schemas).
revoke all on schema app from public, anon, authenticated;
revoke all on schema app_realtime from public, anon;
grant usage on schema app to app_server;
-- citext's operators live in extensions. Without USAGE the schema is skipped on the search_path
-- and citext columns silently compare as case-sensitive text (phase 0 F-9).
grant usage on schema extensions to app_server;
-- Realtime policies (Phase 1) call SECURITY DEFINER helpers in app_realtime.
grant usage on schema app_realtime to authenticated;

-- New functions in app are not executable by PUBLIC unless granted explicitly.
alter default privileges for role app_owner in schema app revoke execute on functions from public;

-- Create the objects as app_owner (plain SET ROLE: works with or without a wrapping transaction).
set role app_owner;

-- Kill switches and runtime settings (03 §10). Read by the server, cached ≤ 30 s.
create table app.runtime_flags (
  key text primary key check (key ~ '^[a-z0-9_]{1,64}$'),
  enabled boolean not null default true,
  value jsonb not null default '{}'::jsonb,
  note text,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- Fixed-window counters for rate limits and daily volumes (DEC-020, 04 §8.8).
create table app.rate_counters (
  key text not null check (char_length(key) between 1 and 200),
  window_start timestamptz not null,
  value bigint not null default 0 check (value >= 0),
  expires_at timestamptz not null,
  primary key (key, window_start)
);
create index rate_counters_expires_at_idx on app.rate_counters (expires_at);

-- Atomic fixed-window hit. One upsert: concurrent callers serialize on the row.
create function app.rate_limit_hit(
  p_key text,
  p_limit integer,
  p_window interval,
  p_cost integer default 1
)
returns table (allowed boolean, current_value bigint, reset_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_window_start timestamptz;
  v_value bigint;
begin
  if p_limit is null or p_limit < 1 or p_cost is null or p_cost < 1
     or p_window is null or p_window <= interval '0' then
    raise exception 'invalid rate limit arguments' using errcode = '22023';
  end if;

  v_window_start := date_bin(p_window, now(), timestamptz '2000-01-01 00:00:00+00');

  insert into app.rate_counters as rc (key, window_start, value, expires_at)
  values (p_key, v_window_start, p_cost, v_window_start + p_window)
  on conflict (key, window_start) do update set value = rc.value + excluded.value
  returning rc.value into v_value;

  return query select v_value <= p_limit, v_value, v_window_start + p_window;
end
$$;

reset role;

-- Row level security everywhere, with explicit server-only policies (04 §6.1).
alter table app.runtime_flags enable row level security;
alter table app.rate_counters enable row level security;

create policy app_server_all on app.runtime_flags
  for all to app_server using (true) with check (true);
create policy app_server_all on app.rate_counters
  for all to app_server using (true) with check (true);

grant select, insert, update, delete on app.runtime_flags to app_server;
grant select, insert, update, delete on app.rate_counters to app_server;

revoke execute on function app.rate_limit_hit(text, integer, interval, integer) from public;
grant execute on function app.rate_limit_hit(text, integer, interval, integer) to app_server;
