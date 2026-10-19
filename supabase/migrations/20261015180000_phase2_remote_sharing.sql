-- Phase 2: remote secure sharing (DEC-013, DEC-014, DEC-025, DEC-031, DEC-033). 04 §7.4–§7.6, §10.4.
--
-- A device on another network reaches one share only through a share link, its QR code or a
-- short code. Links target exactly one share: there are no room links before Phase 4 and never a
-- link to a network's feed (Q-028). Secrets and codes are stored only as peppered HMACs; viewer
-- sessions only as SHA-256 hashes of their cookie.
--
-- Ownership follows the Phase 1 migration: tables that reference auth.users are created by the
-- migration role and handed to app_owner; everything else is created as app_owner. Functions are
-- created as app_owner, so the global default (Phase 1, F1-1) keeps them from PUBLIC.

-- ---------------------------------------------------------------------------
-- shares.scope gains link_only: never in any network feed or net: topic (DEC-033). The
-- existing shares_network_scope check keeps a network space for network shares only.
-- ---------------------------------------------------------------------------
alter table app.shares drop constraint shares_scope_check;
alter table app.shares add constraint shares_scope_check check (scope in ('network', 'link_only'));

-- ---------------------------------------------------------------------------
-- Share links (04 §7.4). Created by the migration role: it references auth.users.
-- ---------------------------------------------------------------------------
create table app.share_links (
  -- 96 random bits as 16 base64url characters (03 §4.1). Appears in the URL path and in logs;
  -- grants nothing on its own.
  id text primary key check (id ~ '^[A-Za-z0-9_-]{16}$'),
  -- Phase 4 adds room links; there is never a network-feed target (Q-028).
  target_type text not null default 'share' check (target_type in ('share')),
  share_id uuid not null references app.shares (id) on delete cascade,
  -- HMAC-SHA256(LINK_PEPPER[pepper_version], link id | secret). The secret itself is never stored.
  secret_hmac bytea not null check (octet_length(secret_hmac) = 32),
  pepper_version smallint not null check (pepper_version > 0),
  -- HMAC-SHA256(CODE_PEPPER[version], normalized code) while a short code is live (DEC-014).
  short_code_hmac bytea check (octet_length(short_code_hmac) = 32),
  short_code_pepper_version smallint check (short_code_pepper_version > 0),
  short_code_expires_at timestamptz,
  allow_download boolean not null default true,
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_by_device_id uuid references app.devices (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by_user_id uuid references auth.users (id) on delete set null,
  revoke_reason text check (revoke_reason in ('creator', 'share_ended', 'blocked')),
  unlock_count integer not null default 0 check (unlock_count >= 0),
  last_unlocked_at timestamptz,
  entitlement_snapshot jsonb not null,
  constraint share_links_code_complete check (
    (short_code_hmac is null) = (short_code_expires_at is null)
    and (short_code_hmac is null) = (short_code_pepper_version is null)),
  constraint share_links_revocation check ((revoked_at is null) = (revoke_reason is null)),
  constraint share_links_expiry check (expires_at > created_at)
);
-- Unique among live codes; the purge job clears expired ones.
create unique index share_links_short_code_idx on app.share_links (short_code_hmac) where short_code_hmac is not null;
create index share_links_share_idx on app.share_links (share_id, created_at desc);
create index share_links_code_expiry_idx on app.share_links (short_code_expires_at) where short_code_expires_at is not null;
alter table app.share_links owner to app_owner;

-- Abuse reports (04 §10.4, 03 §7.6). Kept until reviewed; their retention follows legal advice
-- (Q-022), so no job deletes them. Created by the migration role, which may use the citext type
-- in the extensions schema; app_owner may not.
create table app.abuse_reports (
  id uuid primary key default gen_random_uuid(),
  link_id text references app.share_links (id) on delete set null,
  share_id uuid references app.shares (id) on delete set null,
  -- The reported share's network, so an operator can block a network that keeps posting abuse.
  network_space_id uuid,
  category text not null check (category in (
    'malware', 'phishing', 'illegal', 'child_safety', 'copyright', 'harassment', 'spam', 'other')),
  details text check (char_length(details) <= 2000),
  reporter_email extensions.citext check (char_length(reporter_email) <= 254),
  reporter_kind text not null check (reporter_kind in ('device', 'link_viewer')),
  -- The reporting device's anonymous user; null for link viewers, who have none.
  reporter_user_id uuid,
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text check (char_length(resolved_by) <= 100),
  action_taken text check (char_length(action_taken) <= 200),
  constraint abuse_reports_resolution check ((status = 'open') = (resolved_at is null))
);
create index abuse_reports_open_idx on app.abuse_reports (created_at) where status = 'open';
create index abuse_reports_share_idx on app.abuse_reports (share_id);
create index abuse_reports_link_idx on app.abuse_reports (link_id);
alter table app.abuse_reports owner to app_owner;

set role app_owner;

-- Viewer sessions (04 §7.5): one per browser that unlocked a link or entered a code. Link viewers
-- get no Supabase user (RISK-006). Only the SHA-256 of the cookie value is stored.
create table app.link_sessions (
  id_hash bytea primary key check (octet_length(id_hash) = 32),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index link_sessions_expires_idx on app.link_sessions (expires_at);

-- What a session may open: one row per (session, link), at most 12 hours (03 §4.2).
create table app.link_grants (
  session_id_hash bytea not null references app.link_sessions (id_hash) on delete cascade,
  link_id text not null references app.share_links (id) on delete cascade,
  -- Password-protected links arrive in Phase 4; a password change will invalidate grants.
  password_version integer not null default 0 check (password_version >= 0),
  granted_via text not null check (granted_via in ('secret', 'code')),
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (session_id_hash, link_id),
  constraint link_grants_max_lifetime check (expires_at <= granted_at + interval '12 hours')
);
create index link_grants_expires_idx on app.link_grants (expires_at);
create index link_grants_link_idx on app.link_grants (link_id);

-- ---------------------------------------------------------------------------
-- Link viewers in existing tables
-- ---------------------------------------------------------------------------
alter table app.downloads drop constraint downloads_actor_kind_check;
alter table app.downloads add constraint downloads_actor_kind_check
  check (actor_kind in ('network_device', 'creator', 'link_viewer'));
alter table app.downloads add column link_id text references app.share_links (id) on delete set null;
create index downloads_link_idx on app.downloads (link_id, created_at) where link_id is not null;

alter table app.audit_events drop constraint audit_events_actor_kind_check;
alter table app.audit_events add constraint audit_events_actor_kind_check
  check (actor_kind in ('device', 'system', 'operator', 'link_viewer'));

-- ---------------------------------------------------------------------------
-- Kill switches (03 §10)
-- ---------------------------------------------------------------------------
insert into app.runtime_flags (key, enabled, value, note) values
  ('remote_links_enabled', true, '{}', 'Kill switch: link creation, link-only posting, unlock, viewer content and downloads, code resolution (03 §10)'),
  ('short_codes_enabled', true, '{}', 'Kill switch: creating and resolving short codes (03 §10)')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

-- Database backstop for "link expiry ≤ share expiry" (07 §3); the service checks it first.
create function app.check_link_expiry()
returns trigger
language plpgsql security invoker set search_path = ''
as $$
begin
  if new.expires_at > (select s.expires_at from app.shares s where s.id = new.share_id) then
    raise exception 'a link cannot outlive its share' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger share_links_check_expiry
  before insert or update of expires_at, share_id on app.share_links
  for each row execute function app.check_link_expiry();

-- end_share (04 §9.1, DEC-016) now also invalidates the share's links (03 §4.8): revoked with
-- the reason, and their short codes cleared. Grants stay until they expire, but every viewer
-- request checks the link and the share, so access ends at once. Otherwise unchanged.
create or replace function app.end_share(p_share_id uuid, p_reason text)
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

  update app.share_links l
     set revoked_at = now(),
         revoke_reason = case when p_reason = 'blocked' then 'blocked' else 'share_ended' end,
         short_code_hmac = null,
         short_code_pepper_version = null,
         short_code_expires_at = null
   where l.share_id = p_share_id and l.revoked_at is null;

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

-- Job: purge-ephemeral (every 10 min), with the Phase 2 clauses (04 §9.2): expired grants,
-- sessions 24 h after they expire, and expired short codes (cleared, so the plaintext's HMAC
-- leaves the unique index; the link itself keeps working).
create or replace function app.purge_ephemeral()
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
  delete from app.link_grants where expires_at < now();
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app.link_sessions where expires_at < now() - interval '24 hours';
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  update app.share_links
     set short_code_hmac = null, short_code_pepper_version = null, short_code_expires_at = null
   where short_code_expires_at < now();
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  return v_total;
end
$$;

-- Takedown (03 §7.6, 08 §11). Run by an operator from the MFA-protected Supabase dashboard,
-- following the takedown runbook; the app cannot call these (no grant to app_server). Each call
-- writes an admin.block audit event with the operator's name and reason, and resolves the open
-- reports it answers. Idempotent.

-- Block one share: it ends as 'blocked' (every link revoked, text erased, objects queued for
-- deletion), so the network, its creator and every link viewer lose access on their next request.
-- Returns what happened, including the queued object keys and how long each must be held while
-- an upload URL may still be live (03 §7.7), for the runbook's storage step.
create function app.admin_block_share(p_share_id uuid, p_reason text, p_operator text, p_report_id uuid default null)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_share app.shares;
  v_ended boolean;
  v_reports integer;
  v_objects jsonb;
begin
  if coalesce(trim(p_reason), '') = '' or coalesce(trim(p_operator), '') = '' then
    raise exception 'a reason and the operator''s name are required' using errcode = '22023';
  end if;
  select * into v_share from app.shares where id = p_share_id;
  if not found then
    raise exception 'unknown share' using errcode = '22023';
  end if;

  v_ended := app.end_share(p_share_id, 'blocked');
  -- A share that had already ended keeps its links revoked; make sure none is left.
  update app.share_links l
     set revoked_at = now(), revoke_reason = 'blocked',
         short_code_hmac = null, short_code_pepper_version = null, short_code_expires_at = null
   where l.share_id = p_share_id and l.revoked_at is null;

  update app.abuse_reports r
     set status = 'actioned', resolved_at = now(), resolved_by = left(p_operator, 100), action_taken = 'share_blocked'
   where r.status = 'open'
     and (r.share_id = p_share_id or r.id = p_report_id
          or r.link_id in (select l.id from app.share_links l where l.share_id = p_share_id));
  get diagnostics v_reports = row_count;

  insert into app.audit_events (actor_kind, network_space_id, action, target_type, target_id, metadata)
  values ('operator', v_share.network_space_id, 'admin.block', 'share', p_share_id::text,
          jsonb_build_object('operator', left(p_operator, 100), 'reason', left(p_reason, 500),
                             'reportId', p_report_id, 'previousStatus', v_share.status));

  select coalesce(jsonb_agg(jsonb_build_object(
           'objectKey', od.object_key,
           'holdUntil', case when f.upload_url_expires_at + interval '5 minutes' > now()
                             then f.upload_url_expires_at + interval '5 minutes' end)
           order by od.object_key), '[]'::jsonb)
    into v_objects
    from app.object_deletions od
    join app.files f on f.id = od.source_file_id
   where f.share_id = p_share_id and od.completed_at is null;

  return jsonb_build_object(
    'shareId', p_share_id,
    'status', (select s.status from app.shares s where s.id = p_share_id),
    'endedNow', v_ended,
    'linksRevoked', (select count(*) from app.share_links l where l.share_id = p_share_id and l.revoke_reason = 'blocked'),
    'reportsResolved', v_reports,
    'objects', v_objects);
end
$$;

-- Block one link: it is revoked at once (its viewers get 410), its short code stops working, and
-- the share and its other links stay as they are.
create function app.admin_block_link(p_link_id text, p_reason text, p_operator text, p_report_id uuid default null)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_link app.share_links;
  v_reports integer;
begin
  if coalesce(trim(p_reason), '') = '' or coalesce(trim(p_operator), '') = '' then
    raise exception 'a reason and the operator''s name are required' using errcode = '22023';
  end if;
  select * into v_link from app.share_links where id = p_link_id for update;
  if not found then
    raise exception 'unknown link' using errcode = '22023';
  end if;

  update app.share_links l
     set revoked_at = coalesce(l.revoked_at, now()), revoke_reason = 'blocked',
         short_code_hmac = null, short_code_pepper_version = null, short_code_expires_at = null
   where l.id = p_link_id;

  update app.abuse_reports r
     set status = 'actioned', resolved_at = now(), resolved_by = left(p_operator, 100), action_taken = 'link_blocked'
   where r.status = 'open' and (r.link_id = p_link_id or r.id = p_report_id);
  get diagnostics v_reports = row_count;

  insert into app.audit_events (actor_kind, action, target_type, target_id, metadata)
  values ('operator', 'admin.block', 'link', p_link_id,
          jsonb_build_object('operator', left(p_operator, 100), 'reason', left(p_reason, 500),
                             'reportId', p_report_id, 'shareId', v_link.share_id));

  return jsonb_build_object('linkId', p_link_id, 'shareId', v_link.share_id, 'reportsResolved', v_reports);
end
$$;

reset role;

-- ---------------------------------------------------------------------------
-- Grants (04 §6.1): RLS everywhere with server-only policies.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['share_links', 'link_sessions', 'link_grants', 'abuse_reports'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('create policy app_server_all on app.%I for all to app_server using (true) with check (true)', t);
    execute format('grant select, insert, update, delete on app.%I to app_server', t);
  end loop;
end
$$;

revoke execute on all functions in schema app from public;
-- admin_block_share and admin_block_link are deliberately not granted: operators run them as the
-- dashboard's database owner, never through the app.
