-- Phase 4A: accounts (phase 4 §17.5, §17.9, §17.12; tasks P4-02 and P4-03).
--
-- Device-session binding (C4-2). A permanent account is several browsers, and an access token only
-- names the user and the Auth session. Each device row now records the session it belongs to
-- (devices.auth_session_id, the token's session_id claim), set at registration. One session has one
-- device. Every API request (requireCaller), Realtime's net: authorization and revocation use it:
-- a device of an account can only reach the network data of its own session. Phase 1–3 rows are
-- unbound until their browser's next registration, which the client makes at every start.
--
-- Revocation (C4-3) is real: it records why, deletes the device's Auth session (its refresh token
-- dies) and ends its presence. The access token stays valid until it expires (≤ 1 h), so the API
-- answers 401 DEVICE_REVOKED and Realtime refuses that session on (re)join.
--
-- No passwords (D4-2; P4-00 finding). Supabase's email provider accepts passwords whether or not the
-- app offers them. Someone could sign an address up with a password before its owner does; the owner
-- later confirms the address by code, and the password still works (a pre-hijack). Registration of an
-- account therefore removes any password and ends the sessions a password opened, and the app and
-- Realtime refuse password sessions outright.
--
-- The merge (§17.5.4, threat model §17.9) moves an anonymous user's data into an existing account in
-- one transaction, against a proof created before sign-in (a merge intent). Object keys contain no
-- user (DEC-010), so no storage moves.
--
-- Ownership follows the earlier migrations. Functions that touch the auth schema are owned by the
-- migration role (app_owner can't reach it). merge_intents keeps both user IDs without foreign keys:
-- the completed row must outlive the anonymous user it describes (30 days of audit context).

-- ---------------------------------------------------------------------------
-- Devices: session binding and revocation
-- ---------------------------------------------------------------------------
alter table app.devices
  add column auth_session_id uuid,
  add column revoked_reason text check (revoked_reason in ('user', 'merge', 'account_deleted', 'operator')),
  add column revoked_by_device_id uuid,
  add constraint devices_revocation check ((revoked_at is null) = (revoked_reason is null));
-- One session, one active device.
create unique index devices_active_session_idx on app.devices (auth_session_id)
  where revoked_at is null and auth_session_id is not null;
-- Realtime looks up a token's session among revoked devices too.
create index devices_session_idx on app.devices (auth_session_id) where auth_session_id is not null;
create index devices_revoked_idx on app.devices (revoked_at) where revoked_at is not null;

-- ---------------------------------------------------------------------------
-- Profiles (§17.5.5): one per permanent user. Created by the migration role (references auth.users).
-- ---------------------------------------------------------------------------
create table app.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) between 1 and 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deletion_requested_at timestamptz,
  deletion_scheduled_for timestamptz,
  constraint profiles_deletion check ((deletion_requested_at is null) = (deletion_scheduled_for is null))
);
create index profiles_deletion_idx on app.profiles (deletion_scheduled_for) where deletion_scheduled_for is not null;
alter table app.profiles owner to app_owner;

set role app_owner;

-- ---------------------------------------------------------------------------
-- Merge intents (§17.5.4): the proof, created by the anonymous session before sign-in. The secret is
-- returned once and stored only as HMAC-SHA256 under the versioned link pepper ("merge|{id}|{secret}").
-- ---------------------------------------------------------------------------
create table app.merge_intents (
  id uuid primary key,
  anon_user_id uuid not null,
  anon_device_id uuid not null,
  secret_hmac bytea not null check (octet_length(secret_hmac) = 32),
  pepper_version smallint not null check (pepper_version > 0),
  status text not null default 'open' check (status in ('open', 'completed', 'revoked', 'expired')),
  target_user_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  completed_at timestamptz,
  -- Counts only.
  result jsonb,
  constraint merge_intents_expiry check (expires_at > created_at and expires_at <= created_at + interval '24 hours'),
  constraint merge_intents_completion check (
    (status = 'completed') = (completed_at is not null) and (status <> 'completed' or target_user_id is not null))
);
create unique index merge_intents_one_open_idx on app.merge_intents (anon_user_id) where status = 'open';
create index merge_intents_expiry_idx on app.merge_intents (expires_at) where status = 'open';
create index merge_intents_ended_idx on app.merge_intents (coalesce(completed_at, expires_at)) where status <> 'open';

-- ---------------------------------------------------------------------------
-- end_share (04 §9.1, DEC-016), Phase 4 version: room_deleted and account_deleted end a share as
-- deleted (the share check allowed both since Phase 1; end_share refused them). Otherwise as Phase 3.
-- ---------------------------------------------------------------------------
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
    when 'room_deleted' then 'deleted'
    when 'account_deleted' then 'deleted'
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
      insert into app.object_deletions (object_key, reason, source_file_id, not_before)
      values (f.object_key, 'share_ended', f.id,
              case when p_reason = 'consumed' then now() + interval '5 minutes' else now() end)
      on conflict (object_key) where completed_at is null do nothing;
    end if;
  end loop;

  if p_reason = 'blocked' then
    perform app.hold_share_objects(p_share_id, 'takedown');
  end if;

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

-- ---------------------------------------------------------------------------
-- Realtime topic authorization (04 §6.2), Phase 4 version (C4-2):
--   net:{space}  presence of the device bound to this token's session (not the user's other devices),
--                that device not revoked, the user not suspended, the space ok;
--   user:{id}    as before, but not for a revoked device's session.
-- Password sessions are refused everywhere (D4-2, P4-00). Everything else is denied, as before.
-- ---------------------------------------------------------------------------
create or replace function app_realtime.can_access_topic(p_topic text)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_claims jsonb;
  v_uid uuid;
  v_session uuid;
  v_kind text;
  v_id uuid;
begin
  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    v_uid := (v_claims ->> 'sub')::uuid;
    v_session := (v_claims ->> 'session_id')::uuid;
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

  if jsonb_typeof(v_claims -> 'amr') = 'array'
     and exists (select 1 from jsonb_array_elements(v_claims -> 'amr') a where a ->> 'method' = 'password') then
    return false;
  end if;
  -- A revoked device's access token is valid until it expires; its session gets nothing on (re)join.
  if v_session is not null
     and exists (select 1 from app.devices d where d.auth_session_id = v_session and d.revoked_at is not null) then
    return false;
  end if;

  if v_kind = 'user' then
    return v_id = v_uid;
  elsif v_kind = 'net' then
    return v_session is not null
       and coalesce((select f.enabled from app.runtime_flags f where f.key = 'local_sharing_enabled'), true)
       and not exists (select 1 from app.user_flags uf where uf.user_id = v_uid and uf.suspended_at is not null)
       and exists (
         select 1
           from app.devices d
           join app.network_presence p on p.device_id = d.id
           join app.network_spaces s on s.id = p.space_id
          where d.auth_session_id = v_session and d.user_id = v_uid and d.revoked_at is null
            and p.space_id = v_id and p.present_until > now() and s.status = 'ok');
  end if;
  return false;
end
$$;

-- ---------------------------------------------------------------------------
-- Account deletion (§17.5.7). The request and cancel functions; the grace length is the caller's
-- (D4-6). The API, the daily job's schedule and the UI come with P4-22.
-- ---------------------------------------------------------------------------
create function app.request_account_deletion(p_user_id uuid, p_grace interval)
returns timestamptz
language plpgsql security invoker set search_path = ''
as $$
declare
  v_when timestamptz;
begin
  if p_user_id is null or p_grace is null or p_grace < interval '0' or p_grace > interval '90 days' then
    raise exception 'invalid deletion arguments' using errcode = '22023';
  end if;
  update app.profiles p
     set deletion_requested_at = now(), deletion_scheduled_for = now() + p_grace, updated_at = now()
   where p.user_id = p_user_id and p.deletion_requested_at is null
  returning p.deletion_scheduled_for into v_when;
  if v_when is not null then
    insert into app.audit_events (actor_kind, actor_user_id, action, target_type, target_id, metadata)
    values ('device', p_user_id, 'account.deletion_requested', 'user', p_user_id::text,
            jsonb_build_object('scheduledFor', v_when));
  end if;
  -- Null: no account profile, or a deletion is already pending.
  return v_when;
end
$$;

create function app.cancel_account_deletion(p_user_id uuid)
returns boolean
language plpgsql security invoker set search_path = ''
as $$
begin
  update app.profiles p
     set deletion_requested_at = null, deletion_scheduled_for = null, updated_at = now()
   where p.user_id = p_user_id and p.deletion_requested_at is not null;
  if not found then
    return false;
  end if;
  insert into app.audit_events (actor_kind, actor_user_id, action, target_type, target_id)
  values ('device', p_user_id, 'account.deletion_cancelled', 'user', p_user_id::text);
  return true;
end
$$;

reset role;

-- ---------------------------------------------------------------------------
-- Functions owned by the migration role: they read or change the auth schema.
-- ---------------------------------------------------------------------------

-- No passwords (D4-2, P4-00): remove an account's password and end the sessions it opened. Internal:
-- called by register_device for accounts. Auth stores a random password hash for every passwordless
-- account, so a hash alone means nothing; removing it is harmless. Audited only when a password
-- session existed: someone signed in to this account with a password (for example after a sign-up
-- before the owner's).
create function app.end_password_sign_in(p_user_id uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_sessions integer;
begin
  update auth.users u set encrypted_password = ''
   where u.id = p_user_id and u.encrypted_password is not null and u.encrypted_password <> '';
  delete from auth.sessions s
   where s.user_id = p_user_id
     and exists (select 1 from auth.mfa_amr_claims c where c.session_id = s.id and c.authentication_method = 'password');
  get diagnostics v_sessions = row_count;
  if v_sessions > 0 then
    insert into app.audit_events (actor_kind, action, target_type, target_id, metadata)
    values ('system', 'account.password_removed', 'user', p_user_id::text, jsonb_build_object('sessionsEnded', v_sessions));
  end if;
  return v_sessions;
end
$$;

-- Device registration (§17.5.6, P4-02, P4-07). One call per browser start. Outcomes:
--   refreshed      the session already has its device
--   bound          the named own device moves to this session; its presence ends, so whoever binds
--                  it must observe from the network itself (C4-2)
--   created        a new device, bound to this session
--   revoked        the named device, or this session's device, was revoked (401 DEVICE_REVOKED)
--   limit          an account at the device cap (409 DEVICE_LIMIT; anonymous users have no cap)
--   suspended      403 USER_SUSPENDED
--   session_ended  the token is valid but its session was signed out, revoked or deleted (401)
-- The user's row is locked first, as the merge does, so registrations and merges into one account
-- count devices one at a time.
create function app.register_device(
  p_user_id uuid,
  p_session_id uuid,
  p_device_id uuid,
  p_device_cap integer,
  p_label text,
  p_platform text
)
returns table (outcome text, device_id uuid, label text, platform text, active_devices integer)
language plpgsql security definer set search_path = ''
as $$
declare
  v_anonymous boolean;
  v_device app.devices;
  v_active integer;
begin
  if p_user_id is null or p_session_id is null or p_device_cap is null or p_device_cap < 1
     or p_label is null or char_length(p_label) not between 1 and 40
     or p_platform is null or char_length(p_platform) > 60 then
    raise exception 'invalid register arguments' using errcode = '22023';
  end if;

  select u.is_anonymous into v_anonymous from auth.users u where u.id = p_user_id for no key update;
  if not found then
    return query select 'session_ended', null::uuid, null::text, null::text, null::integer;
    return;
  end if;
  if exists (select 1 from app.devices d
              where d.user_id = p_user_id and d.auth_session_id = p_session_id and d.revoked_at is not null) then
    return query select 'revoked', null::uuid, null::text, null::text, null::integer;
    return;
  end if;
  if not exists (select 1 from auth.sessions s where s.id = p_session_id and s.user_id = p_user_id) then
    return query select 'session_ended', null::uuid, null::text, null::text, null::integer;
    return;
  end if;
  if exists (select 1 from app.user_flags f where f.user_id = p_user_id and f.suspended_at is not null) then
    return query select 'suspended', null::uuid, null::text, null::text, null::integer;
    return;
  end if;

  if not v_anonymous then
    perform app.end_password_sign_in(p_user_id);
  end if;

  select * into v_device from app.devices d
   where d.auth_session_id = p_session_id and d.user_id = p_user_id and d.revoked_at is null;
  if found then
    update app.devices d set last_seen_at = now() where d.id = v_device.id;
    return query select 'refreshed', v_device.id, v_device.label, v_device.platform, null::integer;
    return;
  end if;

  if p_device_id is not null then
    select * into v_device from app.devices d where d.id = p_device_id and d.user_id = p_user_id for update;
    if found then
      if v_device.revoked_at is not null then
        return query select 'revoked', null::uuid, null::text, null::text, null::integer;
        return;
      end if;
      update app.devices d set auth_session_id = p_session_id, last_seen_at = now() where d.id = v_device.id;
      update app.network_presence p set present_until = now() where p.device_id = v_device.id and p.present_until > now();
      return query select 'bound', v_device.id, v_device.label, v_device.platform, null::integer;
      return;
    end if;
  end if;

  if not v_anonymous then
    select count(*)::integer into v_active from app.devices d where d.user_id = p_user_id and d.revoked_at is null;
    if v_active >= p_device_cap then
      return query select 'limit', null::uuid, null::text, null::text, v_active;
      return;
    end if;
  end if;

  insert into app.devices (user_id, label, platform, auth_session_id)
  values (p_user_id, p_label, p_platform, p_session_id)
  returning * into v_device;
  return query select 'created', v_device.id, v_device.label, v_device.platform, null::integer;
end
$$;

-- Revoke one of the user's devices (§17.5.6). False when it isn't theirs or is already revoked (404).
create function app.revoke_device(p_user_id uuid, p_device_id uuid, p_reason text, p_by_device_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_device app.devices;
begin
  if p_user_id is null or p_device_id is null or p_reason is null
     or p_reason not in ('user', 'merge', 'account_deleted', 'operator') then
    raise exception 'invalid revoke arguments' using errcode = '22023';
  end if;
  select * into v_device from app.devices d
   where d.id = p_device_id and d.user_id = p_user_id and d.revoked_at is null
     for update;
  if not found then
    return false;
  end if;

  update app.devices d
     set revoked_at = now(), revoked_reason = p_reason, revoked_by_device_id = p_by_device_id
   where d.id = v_device.id;
  if v_device.auth_session_id is not null then
    delete from auth.sessions s where s.id = v_device.auth_session_id and s.user_id = p_user_id;
  end if;
  update app.network_presence p set present_until = now() where p.device_id = v_device.id and p.present_until > now();

  insert into app.audit_events (actor_kind, actor_user_id, actor_device_id, action, target_type, target_id, metadata)
  values (case p_reason when 'operator' then 'operator' when 'user' then 'device' else 'system' end,
          p_user_id, p_by_device_id, 'device.revoked', 'device', v_device.id::text, jsonb_build_object('reason', p_reason));
  return true;
end
$$;

-- The profile of a permanent user, created on first sight (§17.5.5). Null for anonymous users.
create function app.ensure_profile(p_user_id uuid)
returns app.profiles
language plpgsql security definer set search_path = ''
as $$
declare
  v_row app.profiles;
begin
  if not exists (select 1 from auth.users u where u.id = p_user_id and not u.is_anonymous) then
    return null;
  end if;
  insert into app.profiles (user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into v_row from app.profiles p where p.user_id = p_user_id;
  return v_row;
end
$$;

-- A verified TOTP factor (§17.5.9): sensitive actions then need aal2 (D4-30).
create function app.mfa_enrolled(p_user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from auth.mfa_factors f where f.user_id = p_user_id and f.status = 'verified');
$$;

-- A merge intent (§17.5.4) for the caller's anonymous user and this browser's device. A new one
-- revokes the previous (one open per user). Outcomes: created, not_anonymous, suspended, device
-- (the device isn't the caller's, or isn't bound to the caller's session).
create function app.create_merge_intent(
  p_user_id uuid,
  p_session_id uuid,
  p_device_id uuid,
  p_intent_id uuid,
  p_secret_hmac bytea,
  p_pepper_version integer
)
returns table (outcome text, expires_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare
  v_anonymous boolean;
  v_expires timestamptz := now() + interval '24 hours';
begin
  if p_user_id is null or p_session_id is null or p_device_id is null or p_intent_id is null
     or p_secret_hmac is null or octet_length(p_secret_hmac) <> 32 or p_pepper_version is null or p_pepper_version < 1 then
    raise exception 'invalid intent arguments' using errcode = '22023';
  end if;
  select u.is_anonymous into v_anonymous from auth.users u where u.id = p_user_id for no key update;
  if v_anonymous is distinct from true then
    return query select 'not_anonymous', null::timestamptz;
    return;
  end if;
  if exists (select 1 from app.user_flags f where f.user_id = p_user_id and f.suspended_at is not null) then
    return query select 'suspended', null::timestamptz;
    return;
  end if;
  if not exists (select 1 from app.devices d
                  where d.id = p_device_id and d.user_id = p_user_id and d.revoked_at is null
                    and d.auth_session_id = p_session_id) then
    return query select 'device', null::timestamptz;
    return;
  end if;

  update app.merge_intents i set status = 'revoked' where i.anon_user_id = p_user_id and i.status = 'open';
  insert into app.merge_intents (id, anon_user_id, anon_device_id, secret_hmac, pepper_version, expires_at)
  values (p_intent_id, p_user_id, p_device_id, p_secret_hmac, p_pepper_version, v_expires);
  return query select 'created', v_expires;
end
$$;

-- The merge (§17.5.4; threat model §17.9). One transaction: any error rolls everything back and the
-- intent stays open. Every refusal returns before the first write. Outcomes: merged (with counts),
-- unavailable (404, uniform: unknown, wrong secret, wrong device, expired, revoked), conflict
-- (409: redeemed for another account), invalid (409), suspended (403), device_limit (409).
--
-- Lock order, as end_share and upload completion use it (no deadlocks): the intent, both users (UUID
-- order), the device, the source's shares, its active reservations, then both ledger rows.
create function app.merge_anonymous_user(
  p_intent_id uuid,
  p_secret_hmacs bytea[],
  p_target_user_id uuid,
  p_target_session_id uuid,
  p_device_id uuid,
  p_device_cap integer
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_intent app.merge_intents;
  v_source uuid;
  v_source_anonymous boolean;
  v_target_anonymous boolean;
  v_device app.devices;
  v_active integer;
  v_shares integer;
  v_links integer;
  v_committed bigint := 0;
  v_reserved bigint := 0;
  v_files integer := 0;
  v_result jsonb;
  r record;
begin
  if p_intent_id is null or p_secret_hmacs is null or p_target_user_id is null or p_target_session_id is null
     or p_device_id is null or p_device_cap is null or p_device_cap < 1 then
    raise exception 'invalid merge arguments' using errcode = '22023';
  end if;

  -- 1. The intent, locked: redemptions of one intent run one after another (M6). The secret and the
  -- device are the proof (M1, M2).
  select * into v_intent from app.merge_intents i where i.id = p_intent_id for update;
  if not found or not (v_intent.secret_hmac = any (p_secret_hmacs)) or v_intent.anon_device_id <> p_device_id then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  -- 2. Already redeemed: the same account gets the stored result (a retry, a double click, M4).
  if v_intent.status = 'completed' then
    if v_intent.target_user_id = p_target_user_id then
      return v_intent.result || jsonb_build_object('outcome', 'merged', 'replayed', true);
    end if;
    return jsonb_build_object('outcome', 'conflict');
  end if;
  if v_intent.status <> 'open' or v_intent.expires_at <= now() then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  v_source := v_intent.anon_user_id;

  -- 3. Both users, locked in UUID order (M7). The source is still anonymous, the target permanent, and
  -- the session is the target's own: only a signed-in session of the account can receive (M13).
  for r in select u.id, u.is_anonymous from auth.users u where u.id in (v_source, p_target_user_id) order by u.id for update loop
    if r.id = v_source then
      v_source_anonymous := r.is_anonymous;
    else
      v_target_anonymous := r.is_anonymous;
    end if;
  end loop;
  if v_source_anonymous is null then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  if v_source = p_target_user_id or v_source_anonymous is distinct from true or v_target_anonymous is distinct from false
     or not exists (select 1 from auth.sessions s where s.id = p_target_session_id and s.user_id = p_target_user_id) then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  select * into v_device from app.devices d where d.id = p_device_id for update;
  if not found or v_device.user_id <> v_source or v_device.revoked_at is not null then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  -- 4. Suspension on either side (M11, D4-4): a suspended user's data and record stay where they are.
  if exists (select 1 from app.user_flags f where f.user_id in (v_source, p_target_user_id) and f.suspended_at is not null) then
    return jsonb_build_object('outcome', 'suspended');
  end if;

  -- 5. Locks: the source's shares, its active reservations, both ledger rows (M8).
  perform 1 from app.shares s
   where s.created_by_user_id = v_source or (s.billing_subject_type = 'user' and s.billing_subject_id = v_source)
      or s.claimed_by_user_id = v_source
   order by s.id
     for update;
  perform 1 from app.storage_reservations res
   where res.subject_type = 'user' and res.subject_id = v_source and res.status = 'active'
   order by res.id
     for update;
  perform 1 from app.storage_usage u
   where u.subject_type = 'user' and u.subject_id in (v_source, p_target_user_id)
   order by u.subject_id
     for update;

  -- 6. The device cap (M12): the account's active devices plus the one moving in. A device the
  -- browser's new session already has (registered before the merge) is replaced, so not counted.
  select count(*)::integer into v_active
    from app.devices d
   where d.user_id = p_target_user_id and d.revoked_at is null and d.auth_session_id is distinct from p_target_session_id;
  if v_active + 1 > p_device_cap then
    return jsonb_build_object('outcome', 'device_limit', 'maxDevices', p_device_cap, 'activeDevices', v_active);
  end if;

  -- 7. Ownership (the coverage list: supabase/tests/phase4_accounts.test.sql, M10). Snapshots are
  -- unchanged: what the anonymous user created keeps its Free snapshot.
  update app.devices d
     set revoked_at = now(), revoked_reason = 'merge', revoked_by_device_id = p_device_id
   where d.user_id = p_target_user_id and d.auth_session_id = p_target_session_id and d.revoked_at is null;
  update app.shares s set created_by_user_id = p_target_user_id where s.created_by_user_id = v_source;
  get diagnostics v_shares = row_count;
  update app.shares s set billing_subject_id = p_target_user_id
   where s.billing_subject_type = 'user' and s.billing_subject_id = v_source;
  -- A burn claim moves with its device (M15).
  update app.shares s set claimed_by_user_id = p_target_user_id where s.claimed_by_user_id = v_source;
  update app.share_links l set created_by_user_id = p_target_user_id where l.created_by_user_id = v_source;
  get diagnostics v_links = row_count;
  update app.share_links l set revoked_by_user_id = p_target_user_id where l.revoked_by_user_id = v_source;
  update app.devices d
     set user_id = p_target_user_id, auth_session_id = p_target_session_id, last_seen_at = now()
   where d.id = p_device_id;
  update app.network_presence p set user_id = p_target_user_id where p.device_id = p_device_id;
  update app.downloads dl set user_id = p_target_user_id where dl.user_id = v_source;
  update app.abuse_reports ar set reporter_user_id = p_target_user_id where ar.reporter_user_id = v_source;
  if exists (select 1 from app.user_flags f where f.user_id = v_source and f.upload_restricted) then
    insert into app.user_flags (user_id, upload_restricted) values (p_target_user_id, true)
    on conflict (user_id) do update set upload_restricted = true, updated_at = now();
  end if;

  -- 8. The ledger: the source's committed and reserved bytes and files join the target's row.
  select u.bytes_committed, u.bytes_reserved, u.files_committed into v_committed, v_reserved, v_files
    from app.storage_usage u where u.subject_type = 'user' and u.subject_id = v_source;
  v_committed := coalesce(v_committed, 0);
  v_reserved := coalesce(v_reserved, 0);
  v_files := coalesce(v_files, 0);
  if v_committed > 0 or v_reserved > 0 or v_files > 0 then
    insert into app.storage_usage (subject_type, subject_id) values ('user', p_target_user_id) on conflict do nothing;
    update app.storage_usage u
       set bytes_committed = u.bytes_committed + v_committed,
           bytes_reserved = u.bytes_reserved + v_reserved,
           files_committed = u.files_committed + v_files,
           updated_at = now()
     where u.subject_type = 'user' and u.subject_id = p_target_user_id;
  end if;
  delete from app.storage_usage u where u.subject_type = 'user' and u.subject_id = v_source;
  update app.storage_reservations res set subject_id = p_target_user_id
   where res.subject_type = 'user' and res.subject_id = v_source and res.status = 'active';

  -- 9. Today's upload volume (M11): a merge can't reset the daily budget.
  insert into app.rate_counters as rc (key, window_start, value, expires_at)
  select 'upload_kib:user:' || p_target_user_id::text, c.window_start, c.value, c.expires_at
    from app.rate_counters c
   where c.key = 'upload_kib:user:' || v_source::text and c.expires_at > now()
  on conflict (key, window_start) do update set value = rc.value + excluded.value;
  delete from app.rate_counters c where c.key = 'upload_kib:user:' || v_source::text;

  -- 10. The anonymous user goes; its sessions, identities, other devices, flags and idempotency
  -- keys cascade. Its audit events keep its ID (history stays truthful).
  delete from auth.users u where u.id = v_source and u.is_anonymous;

  -- 11. Done (M16).
  v_result := jsonb_build_object('shares', v_shares, 'links', v_links, 'devices', 1, 'memberships', 0, 'bytes', v_committed);
  update app.merge_intents i
     set status = 'completed', target_user_id = p_target_user_id, completed_at = now(), result = v_result
   where i.id = p_intent_id;
  insert into app.audit_events (actor_kind, actor_user_id, actor_device_id, action, target_type, target_id, metadata)
  values ('device', p_target_user_id, p_device_id, 'account.merged', 'user', p_target_user_id::text,
          v_result || jsonb_build_object('anonUserId', v_source));
  return v_result || jsonb_build_object('outcome', 'merged');
end
$$;

-- ---------------------------------------------------------------------------
-- cleanup-anonymous-users (Phase 3), Phase 4 version: also skips users with an open merge intent,
-- whose data may be on its way to an account (RISK-043, M14). Otherwise as Phase 3.
-- ---------------------------------------------------------------------------
create or replace function app.cleanup_anonymous_users(p_batch integer)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  v_ids uuid[];
  v_deleted integer;
begin
  if p_batch is null or p_batch < 1 then
    raise exception 'invalid batch' using errcode = '22023';
  end if;

  select coalesce(array_agg(c.id), '{}') into v_ids
    from (
      select u.id
        from auth.users u
       where u.is_anonymous
         and u.created_at < now() - interval '30 days'
         and (u.last_sign_in_at is null or u.last_sign_in_at < now() - interval '30 days')
         and not exists (select 1 from auth.sessions se
                          where se.user_id = u.id
                            and greatest(se.created_at, coalesce(se.updated_at, se.created_at), coalesce(se.refreshed_at, se.created_at))
                                > now() - interval '30 days')
         and not exists (select 1 from app.devices d where d.user_id = u.id and d.last_seen_at > now() - interval '30 days')
         and not exists (select 1 from app.user_flags uf where uf.user_id = u.id and uf.suspended_at is not null)
         and not exists (select 1 from app.shares s where s.created_by_user_id = u.id and s.ended_at is null)
         and not exists (select 1 from app.shares s where s.claimed_by_user_id = u.id and s.status = 'claimed')
         and not exists (select 1 from app.storage_reservations res
                          where res.subject_type = 'user' and res.subject_id = u.id and res.status = 'active')
         and not exists (select 1 from app.storage_usage su
                          where su.subject_type = 'user' and su.subject_id = u.id and (su.bytes_committed > 0 or su.bytes_reserved > 0))
         and not exists (select 1 from app.merge_intents mi
                          where mi.anon_user_id = u.id and mi.status = 'open' and mi.expires_at > now())
       order by u.created_at
       limit p_batch
         for update of u skip locked
    ) c;

  delete from app.storage_usage su where su.subject_type = 'user' and su.subject_id = any (v_ids);
  delete from auth.users u where u.id = any (v_ids) and u.is_anonymous;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$$;

-- ---------------------------------------------------------------------------
-- delete-due-accounts (§17.5.7): runs as the migration role, which may delete from auth.users. For
-- each account past its grace: end its open shares (objects queued for the janitor, links revoked),
-- delete its devices, profile and ledger row, then the Auth user (sessions, identities and flags
-- cascade). Tombstones stay until their snapshot dates; reported shares under D-3. Suspended
-- accounts are left for an operator until the owner decides D4-6: their suspension record is
-- evidence (D-3, D-9). Not scheduled yet: the request API, the job and the UI are P4-22.
-- ---------------------------------------------------------------------------
create function app.delete_due_accounts(p_batch integer)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  r record;
  v_share uuid;
  v_ended integer;
  v_count integer := 0;
begin
  if p_batch is null or p_batch < 1 then
    raise exception 'invalid batch' using errcode = '22023';
  end if;
  for r in
    select p.user_id from app.profiles p
     where p.deletion_scheduled_for <= now()
       and not exists (select 1 from app.user_flags f where f.user_id = p.user_id and f.suspended_at is not null)
     order by p.deletion_scheduled_for
     limit p_batch
       for update of p skip locked
  loop
    perform 1 from auth.users u where u.id = r.user_id for update;
    v_ended := 0;
    for v_share in select s.id from app.shares s where s.created_by_user_id = r.user_id and s.ended_at is null order by s.id loop
      if app.end_share(v_share, 'account_deleted') then
        v_ended := v_ended + 1;
      end if;
    end loop;
    delete from app.devices d where d.user_id = r.user_id;
    delete from app.storage_usage u where u.subject_type = 'user' and u.subject_id = r.user_id;
    delete from app.profiles p where p.user_id = r.user_id;
    insert into app.audit_events (actor_kind, action, target_type, target_id, metadata)
    values ('system', 'account.deleted', 'user', r.user_id::text, jsonb_build_object('sharesEnded', v_ended));
    delete from auth.users u where u.id = r.user_id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

set role app_owner;

-- ---------------------------------------------------------------------------
-- purge-ephemeral (every 10 min), Phase 4 version: adds merge intents (marked expired when due,
-- deleted 30 days after they end) and revoked devices 30 days after revocation (04 §3.2). These live
-- here, not in purge_tombstones, whose result shape Phase 3 pins. Otherwise as Phase 2.
-- ---------------------------------------------------------------------------
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
  update app.merge_intents set status = 'expired' where status = 'open' and expires_at <= now();
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app.merge_intents where status <> 'open' and coalesce(completed_at, expires_at) < now() - interval '30 days';
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app.devices where revoked_at < now() - interval '30 days';
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  return v_total;
end
$$;

reset role;

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
alter table app.profiles enable row level security;
create policy app_server_all on app.profiles for all to app_server using (true) with check (true);
grant select, insert, update, delete on app.profiles to app_server;

-- Intents are written only by the definer functions above; the server reads them for its timing-safe check.
alter table app.merge_intents enable row level security;
create policy app_server_read on app.merge_intents for select to app_server using (true);
grant select on app.merge_intents to app_server;

revoke execute on all functions in schema app from public;
revoke execute on all functions in schema app_realtime from public;

grant execute on function
  app.register_device(uuid, uuid, uuid, integer, text, text),
  app.revoke_device(uuid, uuid, text, uuid),
  app.ensure_profile(uuid),
  app.mfa_enrolled(uuid),
  app.create_merge_intent(uuid, uuid, uuid, uuid, bytea, integer),
  app.merge_anonymous_user(uuid, bytea[], uuid, uuid, uuid, integer),
  app.request_account_deletion(uuid, interval),
  app.cancel_account_deletion(uuid)
to app_server;

grant execute on function app_realtime.can_access_topic(text) to authenticated;
-- delete_due_accounts and end_password_sign_in are granted to nobody: the job runs as the migration
-- role, and register_device calls the clean-up as its owner.
