-- Phase 1: anonymous local sharing (DEC-031, DEC-032, DEC-033). 04 §3–§11.
--
-- Built without SP-04: only the current request's network key counts (no dual-stack probe
-- or binding tables) and there is no ASN list (03 §3.4–§3.5 fallback, phase 1 DV1-3).
--
-- Ownership: application objects belong to app_owner. Tables that reference auth.users are
-- created by the migration role (which may reference auth.users; app_owner cannot be granted
-- that) and then handed to app_owner. Trigger functions that call realtime.send stay owned by
-- the migration role, because realtime.messages has RLS that only it bypasses.

-- Functions are executable by PUBLIC by default. The baseline's per-schema
-- "alter default privileges ... in schema app revoke" has no effect: per-schema defaults can
-- only add to the global defaults, never remove them (phase 1 F1-1). A global default for
-- app_owner does work; existing functions are revoked explicitly at the end of this file.
alter default privileges for role app_owner revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Tables referencing auth.users (created by the migration role, owned by app_owner)
-- ---------------------------------------------------------------------------

-- One row per browser installation acting for an (anonymous) user (04 §3.2).
create table app.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  label text not null check (char_length(label) between 1 and 40),
  platform text not null default '' check (char_length(platform) <= 60),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index devices_user_id_idx on app.devices (user_id);
alter table app.devices owner to app_owner;

create table app.user_flags (
  user_id uuid primary key references auth.users (id) on delete cascade,
  suspended_at timestamptz,
  reason text,
  upload_restricted boolean not null default false,
  notes text,
  updated_at timestamptz not null default now()
);
alter table app.user_flags owner to app_owner;

create table app.idempotency_keys (
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null check (char_length(endpoint) between 1 and 100),
  key_hash bytea not null check (octet_length(key_hash) = 32),
  response jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  primary key (user_id, endpoint, key_hash)
);
create index idempotency_keys_expires_idx on app.idempotency_keys (expires_at);
alter table app.idempotency_keys owner to app_owner;

-- ---------------------------------------------------------------------------
-- Network spaces and presence (04 §4)
-- ---------------------------------------------------------------------------
set role app_owner;

create table app.network_spaces (
  id uuid primary key default gen_random_uuid(),
  network_key bytea not null check (octet_length(network_key) = 32),
  key_version smallint not null check (key_version > 0),
  family smallint not null check (family in (4, 6)),
  status text not null default 'ok'
    check (status in ('ok', 'shared_egress', 'too_large', 'blocked', 'unavailable')),
  status_reason text check (char_length(status_reason) <= 100),
  status_until timestamptz,
  devices_24h integer not null default 0 check (devices_24h >= 0),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_share_at timestamptz,
  unique (key_version, network_key)
);
create index network_spaces_status_until_idx on app.network_spaces (status_until) where status_until is not null;
create index network_spaces_last_seen_idx on app.network_spaces (last_seen_at);

create table app.network_presence (
  space_id uuid not null references app.network_spaces (id) on delete cascade,
  device_id uuid not null references app.devices (id) on delete cascade,
  user_id uuid not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  present_until timestamptz not null,
  primary key (space_id, device_id)
);
create index network_presence_user_idx on app.network_presence (user_id, space_id, present_until);
create index network_presence_space_seen_idx on app.network_presence (space_id, last_seen_at);
create index network_presence_device_idx on app.network_presence (device_id);

-- Relay, Tor, VPN and hosting egress ranges (03 §3.5 (a)). Loaded manually in Phase 1.
create table app.network_egress_ranges (
  id bigint generated always as identity primary key,
  cidr cidr not null,
  source text not null check (source in ('private_relay', 'tor', 'vpn', 'hosting')),
  updated_at timestamptz not null default now(),
  unique (cidr, source)
);
create index network_egress_ranges_cidr_idx on app.network_egress_ranges using gist (cidr inet_ops);

reset role;

-- ---------------------------------------------------------------------------
-- Shares (04 §7.1). Phase 1 has only scope 'network'; link_only (Phase 2) and room (Phase 4)
-- widen the check later.
-- ---------------------------------------------------------------------------
create table app.shares (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('network')),
  network_space_id uuid references app.network_spaces (id) on delete restrict,
  kind text not null check (kind in ('files', 'text')),
  title text check (char_length(title) <= 120),
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_by_device_id uuid references app.devices (id) on delete set null,
  billing_subject_type text not null check (billing_subject_type in ('user')),
  billing_subject_id uuid not null,
  status text not null check (status in (
    'pending_upload', 'active', 'claimed', 'consumed', 'expired', 'deleted', 'blocked', 'failed')),
  retention_class text not null check (retention_class in ('d7', 'd30', 'd90', 'ws')),
  expires_at timestamptz,
  burn_after_download boolean not null default false,
  file_count integer not null default 0 check (file_count >= 0),
  total_bytes bigint not null default 0 check (total_bytes >= 0),
  entitlement_snapshot jsonb not null,
  ended_at timestamptz,
  end_reason text check (end_reason in (
    'expired', 'consumed', 'deleted_by_creator', 'deleted_by_owner', 'blocked', 'upload_failed',
    'room_deleted', 'account_deleted')),
  metadata_purge_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shares_network_scope check ((scope = 'network') = (network_space_id is not null)),
  constraint shares_expiry check (expires_at is not null or retention_class = 'ws'),
  constraint shares_claim_requires_burn check (status <> 'claimed' or burn_after_download),
  constraint shares_open_status check ((status in ('pending_upload', 'active', 'claimed')) = (ended_at is null)),
  constraint shares_end_reason check ((ended_at is null) = (end_reason is null))
);
create index shares_feed_idx on app.shares (network_space_id, created_at desc) where status in ('pending_upload', 'active');
create index shares_expiry_idx on app.shares (expires_at) where status in ('pending_upload', 'active');
create index shares_creator_idx on app.shares (created_by_user_id, created_at desc);
create index shares_purge_idx on app.shares (metadata_purge_after) where ended_at is not null;
alter table app.shares owner to app_owner;

set role app_owner;

-- One R2 object per row (04 §7.2). Object keys never contain names (DEC-010).
create table app.files (
  id uuid primary key default gen_random_uuid(),
  share_id uuid not null references app.shares (id) on delete cascade,
  -- Order the uploader listed the files in (display and upload-target order).
  position smallint not null default 0 check (position >= 0),
  network_space_id uuid,
  object_key text not null unique
    check (object_key ~ '^(d7|d30|d90|ws)/[0-9]{4}/[0-9]{2}/[0-9]{2}/[0-9a-f-]{36}$'),
  original_name text not null check (char_length(original_name) >= 1 and octet_length(original_name) <= 255),
  extension text not null default '' check (char_length(extension) <= 32),
  declared_mime text not null check (char_length(declared_mime) <= 255),
  stored_content_type text not null check (char_length(stored_content_type) <= 255),
  detected_mime text,
  declared_size_bytes bigint not null check (declared_size_bytes > 0),
  size_bytes bigint check (size_bytes > 0),
  upload_mode text not null default 'single' check (upload_mode in ('single')),
  upload_status text not null default 'pending' check (upload_status in ('pending', 'verified', 'rejected', 'deleted')),
  upload_expires_at timestamptz not null,
  -- Latest expiry of any presigned PUT issued for this file. URLs cannot be revoked, so storage
  -- deletion holds the key with a tombstone until then (claim_object_deletions, review M1).
  upload_url_expires_at timestamptz,
  rejection_reason text,
  preview_kind text not null default 'none' check (preview_kind in ('image', 'none')),
  risk_flags text[] not null default '{}',
  scan_status text not null default 'not_scanned' check (scan_status in ('not_scanned')),
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  object_deleted_at timestamptz,
  constraint files_verified_size check (upload_status <> 'verified' or size_bytes = declared_size_bytes)
);
create index files_share_idx on app.files (share_id);
create index files_pending_deadline_idx on app.files (upload_expires_at) where upload_status = 'pending';

-- Versioned text, erased when the share ends (04 §7.3, DEC-027).
create table app.text_items (
  share_id uuid primary key references app.shares (id) on delete cascade,
  network_space_id uuid,
  content text,
  content_bytes integer not null check (content_bytes between 0 and 1048576),
  version integer not null default 1 check (version >= 1),
  updated_at timestamptz not null default now(),
  updated_by_device_id uuid
);

-- URL issuances (04 §7.6). Completed downloads are not observable (bytes come from R2).
create table app.downloads (
  id bigint generated always as identity primary key,
  share_id uuid not null references app.shares (id) on delete cascade,
  file_id uuid references app.files (id) on delete cascade,
  network_space_id uuid,
  actor_kind text not null check (actor_kind in ('network_device', 'creator')),
  user_id uuid,
  device_id uuid,
  event text not null check (event in ('url_issued', 'preview_issued')),
  created_at timestamptz not null default now(),
  url_expires_at timestamptz,
  user_agent_family text check (char_length(user_agent_family) <= 60),
  retention_until timestamptz not null
);
create index downloads_share_idx on app.downloads (share_id, created_at);
create index downloads_user_idx on app.downloads (user_id, created_at desc);
create index downloads_retention_idx on app.downloads (retention_until);

-- ---------------------------------------------------------------------------
-- Storage quota ledger (04 §8.8, DEC-019)
-- ---------------------------------------------------------------------------
create table app.storage_usage (
  subject_type text not null check (subject_type in ('user')),
  subject_id uuid not null,
  bytes_committed bigint not null default 0 check (bytes_committed >= 0),
  bytes_reserved bigint not null default 0 check (bytes_reserved >= 0),
  files_committed integer not null default 0 check (files_committed >= 0),
  updated_at timestamptz not null default now(),
  primary key (subject_type, subject_id)
);

create table app.storage_reservations (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('user')),
  subject_id uuid not null,
  file_id uuid references app.files (id) on delete set null,
  bytes bigint not null check (bytes > 0),
  status text not null default 'active' check (status in ('active', 'committed', 'released')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  settled_at timestamptz
);
create index storage_reservations_due_idx on app.storage_reservations (expires_at) where status = 'active';
create unique index storage_reservations_active_file_idx on app.storage_reservations (file_id) where status = 'active';

-- ---------------------------------------------------------------------------
-- Operations (04 §10.4)
-- ---------------------------------------------------------------------------
-- Deletion outbox. One bucket per environment, so no bucket column. Executed best-effort by
-- request paths in Phase 1 and durably by the Phase 3 janitor.
create table app.object_deletions (
  id bigint generated always as identity primary key,
  object_key text not null check (object_key ~ '^(d7|d30|d90|ws)/[0-9]{4}/[0-9]{2}/[0-9]{2}/[0-9a-f-]{36}$'),
  reason text not null check (reason in ('share_ended', 'upload_rejected', 'upload_timeout')),
  source_file_id uuid,
  requested_at timestamptz not null default now(),
  not_before timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  locked_until timestamptz,
  last_error text,
  -- Content overwritten by an empty tombstone while an upload URL may still be live; the
  -- tombstone itself is deleted once not_before (URL expiry plus grace) has passed.
  tombstoned_at timestamptz,
  completed_at timestamptz
);
create unique index object_deletions_pending_key_idx on app.object_deletions (object_key) where completed_at is null;
create index object_deletions_due_idx on app.object_deletions (not_before) where completed_at is null;

-- Security and lifecycle events (03 §14). No IP data, no secrets, no content.
create table app.audit_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_kind text not null check (actor_kind in ('device', 'system', 'operator')),
  actor_user_id uuid,
  actor_device_id uuid,
  network_space_id uuid,
  action text not null check (char_length(action) between 1 and 64),
  target_type text check (char_length(target_type) <= 32),
  target_id text check (char_length(target_id) <= 64),
  metadata jsonb not null default '{}'::jsonb,
  retention_until timestamptz not null default (now() + interval '90 days')
);
create index audit_events_occurred_idx on app.audit_events (occurred_at);
create index audit_events_retention_idx on app.audit_events (retention_until);
create index audit_events_space_idx on app.audit_events (network_space_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Runtime flags (kill switches and the large-network cap)
-- ---------------------------------------------------------------------------
insert into app.runtime_flags (key, enabled, value, note) values
  ('local_sharing_enabled', true, '{}', 'Kill switch: local feed, posting and net: topics (03 §10)'),
  ('uploads_enabled', true, '{}', 'Kill switch: new file uploads'),
  ('anonymous_uploads_enabled', true, '{}', 'Kill switch: uploads and text posts by anonymous users'),
  ('network_large_cap', true, '{"value": 50}', 'too_large above this many distinct devices per 24 h (Q-029, assumed)'),
  ('egress_ranges', true, '{}', 'Set by scripts/load-egress-ranges.cjs ({"loadedAt", "rows"}). Staging and production switch local sharing off when it is missing or stale.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Functions (SECURITY INVOKER: they run with the caller's privileges, normally app_server)
-- ---------------------------------------------------------------------------
create function app.large_network_cap()
returns integer
language sql stable security invoker set search_path = ''
as $$
  select coalesce(
    (select (f.value ->> 'value')::integer from app.runtime_flags f where f.key = 'network_large_cap'),
    50);
$$;

-- Change a space's status. shared_egress and too_large are sticky for 7 days (03 §3.5).
create function app.set_space_status(p_space_id uuid, p_status text, p_reason text)
returns app.network_spaces
language plpgsql security invoker set search_path = ''
as $$
declare
  v_old text;
  v_row app.network_spaces;
begin
  select s.status into v_old from app.network_spaces s where s.id = p_space_id for update;
  if v_old is null then
    raise exception 'unknown network space' using errcode = '22023';
  end if;

  update app.network_spaces s
     set status = p_status,
         status_reason = p_reason,
         status_until = case when p_status in ('shared_egress', 'too_large') then now() + interval '7 days' end
   where s.id = p_space_id
  returning s.* into v_row;

  if v_old is distinct from p_status then
    insert into app.audit_events (actor_kind, network_space_id, action, target_type, target_id, metadata)
    values ('system', p_space_id, 'network.status_changed', 'network_space', p_space_id::text,
            jsonb_build_object('from', v_old, 'to', p_status, 'reason', p_reason));
  end if;
  return v_row;
end
$$;

-- Derive the caller's space for this request's network key, classify it and record presence
-- (03 §3.2, §3.5, §3.6). The client address never reaches the database (review L5): the app
-- matches it against egress_ranges_overlapping() and passes only the result, p_egress_source
-- (the list the address is on, or null).
create function app.observe_network(
  p_device_id uuid,
  p_user_id uuid,
  p_network_key bytea,
  p_key_version integer,
  p_family integer,
  p_egress_source text
)
returns table (space_id uuid, status text, status_reason text, devices_here integer)
language plpgsql security invoker set search_path = ''
as $$
declare
  v_space app.network_spaces;
  v_cap integer := app.large_network_cap();
  v_devices_24h integer;
  v_here integer;
begin
  if p_device_id is null or p_user_id is null or p_network_key is null or octet_length(p_network_key) <> 32
     or p_key_version is null or p_key_version < 1 or p_family not in (4, 6)
     or (p_egress_source is not null and p_egress_source not in ('private_relay', 'tor', 'vpn', 'hosting')) then
    raise exception 'invalid observe arguments' using errcode = '22023';
  end if;

  insert into app.network_spaces as s (network_key, key_version, family)
  values (p_network_key, p_key_version::smallint, p_family::smallint)
  on conflict (key_version, network_key) do update set last_seen_at = now()
  returning s.* into v_space;

  -- Leaving a network ends presence there immediately (G3).
  update app.network_presence p
     set present_until = now()
   where p.device_id = p_device_id and p.space_id <> v_space.id and p.present_until > now();

  insert into app.network_presence as p (space_id, device_id, user_id, present_until)
  values (v_space.id, p_device_id, p_user_id, now() + interval '10 minutes')
  on conflict on constraint network_presence_pkey do update
     set last_seen_at = now(), present_until = excluded.present_until, user_id = excluded.user_id;

  update app.devices d set last_seen_at = now() where d.id = p_device_id;

  select count(*)::integer into v_devices_24h
    from app.network_presence p
   where p.space_id = v_space.id and p.last_seen_at > now() - interval '24 hours';
  update app.network_spaces s set devices_24h = v_devices_24h where s.id = v_space.id;

  -- Classify ok spaces, and re-check shared_egress spaces whose sticky period has ended: only an
  -- observe comes with a fresh egress lookup, so only an observe may lift shared_egress.
  if v_space.status = 'ok' or (v_space.status = 'shared_egress' and v_space.status_until <= now()) then
    if p_egress_source is not null then
      v_space := app.set_space_status(v_space.id, 'shared_egress', 'egress_list:' || p_egress_source);
    elsif v_devices_24h > v_cap then
      v_space := app.set_space_status(v_space.id, 'too_large', 'devices_24h_over_cap');
    elsif v_space.status <> 'ok' then
      v_space := app.set_space_status(v_space.id, 'ok', 'sticky_period_ended');
    end if;
  end if;

  select count(*)::integer into v_here
    from app.network_presence p
   where p.space_id = v_space.id and p.present_until > now();

  return query select v_space.id, v_space.status, v_space.status_reason, v_here;
end
$$;

-- Key rotation (03 §3.2): while both secrets are configured, the server moves a space found
-- under the previous key version to the current one, so its id and content stay put.
create function app.rekey_network_space(
  p_old_key bytea,
  p_old_version integer,
  p_new_key bytea,
  p_new_version integer
)
returns boolean
language plpgsql security invoker set search_path = ''
as $$
begin
  update app.network_spaces s
     set network_key = p_new_key, key_version = p_new_version::smallint
   where s.key_version = p_old_version and s.network_key = p_old_key
     and not exists (
       select 1 from app.network_spaces n where n.key_version = p_new_version and n.network_key = p_new_key);
  return found;
end
$$;

-- Egress-list lookup without the client address (review L5): the app sends only the IPv4 /24 or
-- IPv6 /48 around it (the usual anonymization granularity) and checks exact containment itself.
-- Longer prefixes are refused, so this path cannot carry a full address. The loader collapses
-- adjacent ranges, which keeps the answer small (at most about 100 rows per prefix).
create function app.egress_ranges_overlapping(p_prefix cidr)
returns table (cidr cidr, source text)
language plpgsql stable security invoker set search_path = ''
as $$
begin
  if p_prefix is null
     or (family(p_prefix) = 4 and masklen(p_prefix) > 24)
     or (family(p_prefix) = 6 and masklen(p_prefix) > 48) then
    raise exception 'egress lookups take an IPv4 /24 or IPv6 /48 at most' using errcode = '22023';
  end if;
  return query select r.cidr, r.source from app.network_egress_ranges r where r.cidr && p_prefix;
end
$$;

-- Status job body (04 §9.2 refresh-network-status): recount devices, apply the cap, end
-- expired too_large periods. shared_egress is left to observe_network, which gets a fresh
-- egress lookup from the app.
create function app.refresh_network_status(p_batch integer)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  v_cap integer := app.large_network_cap();
  v_changed integer := 0;
  r record;
begin
  for r in
    select s.id, s.status, s.status_until,
           (select count(*)::integer from app.network_presence p
             where p.space_id = s.id and p.last_seen_at > now() - interval '24 hours') as n
      from app.network_spaces s
     where s.status in ('ok', 'too_large')
       and (s.last_seen_at > now() - interval '25 hours' or s.status_until <= now())
     order by s.last_seen_at desc
     limit p_batch
     for update of s skip locked
  loop
    update app.network_spaces set devices_24h = r.n where id = r.id;
    if r.status = 'ok' and r.n > v_cap then
      perform app.set_space_status(r.id, 'too_large', 'devices_24h_over_cap');
      v_changed := v_changed + 1;
    elsif r.status = 'too_large' and r.status_until <= now() then
      if r.n > v_cap then
        perform app.set_space_status(r.id, 'too_large', 'devices_24h_over_cap');
      else
        perform app.set_space_status(r.id, 'ok', 'sticky_period_ended');
      end if;
      v_changed := v_changed + 1;
    end if;
  end loop;
  return v_changed;
end
$$;

-- Atomic quota reservation (04 §8.8): never exceeds the quota. Returns null when it would.
create function app.reserve_storage(
  p_subject_type text,
  p_subject_id uuid,
  p_file_id uuid,
  p_bytes bigint,
  p_quota bigint,
  p_ttl interval default interval '3 hours'
)
returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_bytes is null or p_bytes <= 0 or p_quota is null or p_quota < 0 or p_ttl is null or p_ttl <= interval '0' then
    raise exception 'invalid reservation arguments' using errcode = '22023';
  end if;

  insert into app.storage_usage (subject_type, subject_id) values (p_subject_type, p_subject_id)
  on conflict do nothing;

  update app.storage_usage u
     set bytes_reserved = u.bytes_reserved + p_bytes, updated_at = now()
   where u.subject_type = p_subject_type and u.subject_id = p_subject_id
     and u.bytes_committed + u.bytes_reserved + p_bytes <= p_quota;
  if not found then
    return null;
  end if;

  insert into app.storage_reservations (subject_type, subject_id, file_id, bytes, expires_at)
  values (p_subject_type, p_subject_id, p_file_id, p_bytes, now() + p_ttl)
  returning id into v_id;
  return v_id;
end
$$;

-- Move a reservation's bytes to committed. Single PUT: actual bytes must equal the reservation.
create function app.commit_reservation(p_reservation_id uuid, p_actual_bytes bigint)
returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare
  r app.storage_reservations;
begin
  select * into r from app.storage_reservations where id = p_reservation_id for update;
  if not found or r.status <> 'active' then
    return false;
  end if;
  if p_actual_bytes is distinct from r.bytes then
    raise exception 'committed bytes must equal the reservation' using errcode = '22023';
  end if;

  update app.storage_usage u
     set bytes_reserved = u.bytes_reserved - r.bytes,
         bytes_committed = u.bytes_committed + r.bytes,
         files_committed = u.files_committed + 1,
         updated_at = now()
   where u.subject_type = r.subject_type and u.subject_id = r.subject_id;
  update app.storage_reservations set status = 'committed', settled_at = now() where id = r.id;
  return true;
end
$$;

create function app.release_reservation(p_reservation_id uuid)
returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare
  r app.storage_reservations;
begin
  select * into r from app.storage_reservations where id = p_reservation_id for update;
  if not found or r.status <> 'active' then
    return false;
  end if;
  update app.storage_usage u
     set bytes_reserved = greatest(u.bytes_reserved - r.bytes, 0), updated_at = now()
   where u.subject_type = r.subject_type and u.subject_id = r.subject_id;
  update app.storage_reservations set status = 'released', settled_at = now() where id = r.id;
  return true;
end
$$;

-- The single path that ends content (04 §9.1, DEC-016): status and reason, text erased,
-- committed bytes released, reservations released, objects queued for deletion. Idempotent.
create function app.end_share(p_share_id uuid, p_reason text)
returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare
  v_share app.shares;
  v_status text;
  f record;
begin
  v_status := case p_reason
    when 'expired' then 'expired'
    when 'consumed' then 'consumed'
    when 'deleted_by_creator' then 'deleted'
    when 'deleted_by_owner' then 'deleted'
    when 'blocked' then 'blocked'
    when 'upload_failed' then 'failed'
  end;
  if v_status is null then
    raise exception 'invalid end reason' using errcode = '22023';
  end if;

  select * into v_share from app.shares where id = p_share_id for update;
  if not found or v_share.ended_at is not null then
    return false;
  end if;

  for f in select * from app.files where share_id = p_share_id order by id for update loop
    if f.upload_status = 'verified' then
      update app.storage_usage u
         set bytes_committed = greatest(u.bytes_committed - f.size_bytes, 0),
             files_committed = greatest(u.files_committed - 1, 0),
             updated_at = now()
       where u.subject_type = v_share.billing_subject_type and u.subject_id = v_share.billing_subject_id;
      update app.files set upload_status = 'deleted' where id = f.id;
    elsif f.upload_status = 'pending' then
      perform app.release_reservation(r.id)
         from app.storage_reservations r where r.file_id = f.id and r.status = 'active';
      update app.files set upload_status = 'rejected', rejection_reason = 'share_ended' where id = f.id;
    end if;
    if f.upload_status in ('verified', 'pending') then
      insert into app.object_deletions (object_key, reason, source_file_id)
      values (f.object_key, 'share_ended', f.id)
      on conflict (object_key) where completed_at is null do nothing;
    end if;
  end loop;

  update app.text_items set content = null where share_id = p_share_id;

  update app.shares
     set status = v_status,
         ended_at = now(),
         end_reason = p_reason,
         updated_at = now(),
         metadata_purge_after = now()
           + make_interval(days => coalesce((v_share.entitlement_snapshot ->> 'historyRetentionDays')::integer, 30))
   where id = p_share_id;

  insert into app.audit_events (actor_kind, network_space_id, action, target_type, target_id, metadata)
  values ('system', v_share.network_space_id, 'share.ended', 'share', p_share_id::text,
          jsonb_build_object('reason', p_reason));
  return true;
end
$$;

-- Storage deletions due now (04 §9.2), claimed for two minutes so concurrent executors skip them.
-- A presigned PUT cannot be revoked: while one may still be live for the object (its latest
-- expiry plus 5 minutes of clock-skew grace), hold_until is set and the executor overwrites the
-- object with an empty tombstone instead of deleting it. The key stays taken, so the write-once
-- URL (If-None-Match: *) cannot put bytes back; the tombstone is deleted after hold_until
-- (review M1). p_share_id null claims due deletions of any share (the sweep).
create function app.claim_object_deletions(p_share_id uuid, p_limit integer)
returns table (id bigint, object_key text, source_file_id uuid, hold_until timestamptz, tombstoned boolean)
language sql volatile security invoker set search_path = ''
as $$
  with due as (
    select od.id, f.upload_url_expires_at
      from app.object_deletions od
      left join app.files f on f.id = od.source_file_id
     where od.completed_at is null
       and od.not_before <= now()
       and (od.locked_until is null or od.locked_until <= now())
       and (p_share_id is null or f.share_id = p_share_id)
     order by od.not_before, od.id
     limit greatest(p_limit, 0)
       for update of od skip locked
  ), claimed as (
    update app.object_deletions od
       set locked_until = now() + interval '2 minutes'
      from due
     where od.id = due.id
    returning od.id, od.object_key, od.source_file_id, od.tombstoned_at, due.upload_url_expires_at
  )
  select c.id, c.object_key, c.source_file_id,
         case when c.upload_url_expires_at + interval '5 minutes' > now()
              then c.upload_url_expires_at + interval '5 minutes' end,
         c.tombstoned_at is not null
    from claimed c;
$$;

-- Job: expire-shares (every minute). Access already ended at expires_at (request-time checks).
create function app.expire_due_shares(p_batch integer)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  for v_id in
    select s.id from app.shares s
     where s.status in ('pending_upload', 'active') and s.expires_at <= now()
     order by s.expires_at
     limit p_batch
     for update skip locked
  loop
    if app.end_share(v_id, 'expired') then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end
$$;

-- Job: fail-stale-uploads (every 5 min). A share is all-or-nothing (DV1-10).
-- Lock order everywhere: share, then files, then the storage ledger (as end_share and the
-- completion endpoint), so the job can't deadlock with a completion or a delete.
create function app.fail_stale_uploads(p_batch integer)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  v_share uuid;
  f record;
  v_count integer := 0;
begin
  for v_share in
    select distinct fi.share_id from app.files fi
     where fi.upload_status = 'pending' and fi.upload_expires_at <= now()
     limit p_batch
  loop
    perform 1 from app.shares s where s.id = v_share for update skip locked;
    if not found then
      continue;
    end if;
    for f in
      select fi.id, fi.object_key from app.files fi
       where fi.share_id = v_share and fi.upload_status = 'pending' and fi.upload_expires_at <= now()
       order by fi.id
       for update
    loop
      update app.files set upload_status = 'rejected', rejection_reason = 'upload_timeout' where id = f.id;
      perform app.release_reservation(r.id)
         from app.storage_reservations r where r.file_id = f.id and r.status = 'active';
      insert into app.object_deletions (object_key, reason, source_file_id)
      values (f.object_key, 'upload_timeout', f.id)
      on conflict (object_key) where completed_at is null do nothing;
      v_count := v_count + 1;
    end loop;
    perform app.end_share(v_share, 'upload_failed');
  end loop;
  return v_count;
end
$$;

-- Job: release-stale-reservations (every 10 min).
create function app.release_stale_reservations(p_batch integer)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  for v_id in
    select r.id from app.storage_reservations r
     where r.status = 'active' and r.expires_at <= now()
     limit p_batch
     for update skip locked
  loop
    if app.release_reservation(v_id) then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end
$$;

-- Job: purge-ephemeral (every 10 min): presence 24 h after last seen, expired counters and keys.
create function app.purge_ephemeral()
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  v_total integer := 0;
  v_n integer;
begin
  delete from app.network_presence where last_seen_at < now() - interval '24 hours';
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app.rate_counters where expires_at < now();
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app.idempotency_keys where expires_at < now();
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  return v_total;
end
$$;

-- Job: purge-idle-spaces (daily): no shares (any state) and no presence for 30 days.
create function app.purge_idle_spaces(p_batch integer)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from app.network_spaces s
   where s.id in (
     select s2.id from app.network_spaces s2
      where s2.last_seen_at < now() - interval '30 days'
        and s2.status <> 'blocked'
        and not exists (select 1 from app.shares sh where sh.network_space_id = s2.id)
        and not exists (select 1 from app.network_presence p where p.space_id = s2.id)
      limit p_batch
      for update skip locked);
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- ---------------------------------------------------------------------------
-- Realtime topic authorization (04 §6.2). Reads the JWT claims Realtime sets for the
-- connection; app_owner has no access to the auth schema, so auth.uid() is not used.
-- ---------------------------------------------------------------------------
create function app_realtime.can_access_topic(p_topic text)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid;
  v_kind text;
  v_id uuid;
begin
  begin
    v_uid := (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
    v_id := split_part(p_topic, ':', 2)::uuid;
  exception when others then
    return false;
  end;
  if v_uid is null or v_id is null then
    return false;
  end if;
  v_kind := split_part(p_topic, ':', 1);
  if p_topic <> v_kind || ':' || v_id::text then
    return false;
  end if;

  if v_kind = 'user' then
    return v_id = v_uid;
  elsif v_kind = 'net' then
    return coalesce((select f.enabled from app.runtime_flags f where f.key = 'local_sharing_enabled'), true)
       and exists (
         select 1
           from app.network_presence p
           join app.network_spaces s on s.id = p.space_id
          where p.space_id = v_id and p.user_id = v_uid
            and p.present_until > now() and s.status = 'ok');
  end if;
  return false;
end
$$;

reset role;

-- ---------------------------------------------------------------------------
-- Realtime signals (04 §6.3). ID-only payloads; owned by the migration role (see header).
-- ---------------------------------------------------------------------------
create function app.emit_share_changed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_payload jsonb;
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    v_payload := jsonb_build_object('v', 1, 'type', 'share.changed', 'shareId', new.id, 'status', new.status);
    if new.scope = 'network' then
      perform realtime.send(v_payload, 'share.changed', 'net:' || new.network_space_id::text, true);
    end if;
    if new.created_by_user_id is not null then
      perform realtime.send(v_payload, 'share.changed', 'user:' || new.created_by_user_id::text, true);
    end if;
  end if;
  return null;
end
$$;

create function app.emit_text_changed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_payload jsonb;
  v_creator uuid;
  v_space uuid;
begin
  if new.version is distinct from old.version then
    select s.created_by_user_id, s.network_space_id into v_creator, v_space
      from app.shares s where s.id = new.share_id;
    v_payload := jsonb_build_object('v', 1, 'type', 'share.changed', 'shareId', new.share_id, 'version', new.version);
    if v_space is not null then
      perform realtime.send(v_payload, 'share.changed', 'net:' || v_space::text, true);
    end if;
    if v_creator is not null then
      perform realtime.send(v_payload, 'share.changed', 'user:' || v_creator::text, true);
    end if;
  end if;
  return null;
end
$$;

create function app.emit_network_changed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    perform realtime.send(
      jsonb_build_object('v', 1, 'type', 'network.changed', 'spaceId', new.id, 'status', new.status),
      'network.changed', 'net:' || new.id::text, true);
  end if;
  return null;
end
$$;

create trigger shares_emit_changed
  after insert or update of status on app.shares
  for each row execute function app.emit_share_changed();
create trigger text_items_emit_changed
  after update of version on app.text_items
  for each row execute function app.emit_text_changed();
create trigger network_spaces_emit_changed
  after update of status on app.network_spaces
  for each row execute function app.emit_network_changed();

-- Receive broadcasts and presence on authorized topics. Clients may track presence on net:
-- topics but may not send broadcasts: there is no other insert policy (DEC-011).
create policy local_saver_receive_authorized_topics on realtime.messages
  for select to authenticated
  using (app_realtime.can_access_topic((select realtime.topic())));
create policy local_saver_track_presence on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and split_part((select realtime.topic()), ':', 1) = 'net'
    and app_realtime.can_access_topic((select realtime.topic()))
  );

-- ---------------------------------------------------------------------------
-- Grants (04 §6.1): RLS everywhere with server-only policies.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'devices', 'user_flags', 'idempotency_keys', 'network_spaces', 'network_presence', 'network_egress_ranges',
    'shares', 'files', 'text_items', 'downloads', 'storage_usage', 'storage_reservations', 'object_deletions',
    'audit_events'
  ] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('create policy app_server_all on app.%I for all to app_server using (true) with check (true)', t);
    execute format('grant select, insert, update, delete on app.%I to app_server', t);
  end loop;
end
$$;

revoke execute on all functions in schema app from public;
revoke execute on all functions in schema app_realtime from public;

grant execute on function
  app.large_network_cap(),
  app.set_space_status(uuid, text, text),
  app.observe_network(uuid, uuid, bytea, integer, integer, text),
  app.egress_ranges_overlapping(cidr),
  app.rekey_network_space(bytea, integer, bytea, integer),
  app.reserve_storage(text, uuid, uuid, bigint, bigint, interval),
  app.commit_reservation(uuid, bigint),
  app.release_reservation(uuid),
  app.end_share(uuid, text),
  app.claim_object_deletions(uuid, integer)
to app_server;

grant execute on function app_realtime.can_access_topic(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Jobs (04 §9.2, Phase 1 rows). Phase 1 executes the storage outbox from the API: a share's
-- own deletions right after it ends, plus a small sweep of due ones after each delete. The
-- Phase 3 janitor takes over; the R2 lifecycle rule stays the backstop.
-- ---------------------------------------------------------------------------
select cron.schedule('expire-shares', '* * * * *', $$select app.expire_due_shares(500)$$);
select cron.schedule('fail-stale-uploads', '*/5 * * * *', $$select app.fail_stale_uploads(500)$$);
select cron.schedule('refresh-network-status', '*/5 * * * *', $$select app.refresh_network_status(1000)$$);
select cron.schedule('purge-ephemeral', '*/10 * * * *', $$select app.purge_ephemeral()$$);
select cron.schedule('release-stale-reservations', '*/10 * * * *', $$select app.release_stale_reservations(500)$$);
select cron.schedule('purge-idle-spaces', '17 3 * * *', $$select app.purge_idle_spaces(1000)$$);
