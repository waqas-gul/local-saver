-- Phase 4D, P4-17: private rooms (phase 4 §17.8.4, §17.8.4.1, §17.11, §17.12; D4-14, D4-15, D4-16, D4-18, D4-19).
--
-- A private room is a membership space reachable from any network. It is never a network feed: a room share
-- has scope 'room', its room and no network space (shares_room_scope and shares_network_scope), the local feed
-- reads scope 'network' only, and Realtime room topics are separate from net: topics and carry no presence.
--
--   rooms          one row per room: owner, label (generated, or custom on Pro), settings, the owner's
--                  entitlement snapshot at creation (its member cap, D4-14), soft deletion.
--   room_members   (room, user): role owner or member, how they joined, the device that joined (its label is
--                  shown for anonymous members, D4-15), removal (left, removed, room deleted). The opaque ID is
--                  the memberId the API shows (C4-18); a user ID never leaves the server.
--   room_invites   invite links, and the pairing kind QR pairing will use (P4-18). The secret is 256 bits, stored
--                  only as HMAC-SHA256 under the versioned link pepper ("invite|{id}|{secret}"); the service
--                  checks it timing-safely and app.accept_room_invite checks it again under the locks.
--
-- Authorization is the server's (DEC-006): every room route finds the room through the caller's membership
-- (app.room_role), so a room, member or invite ID alone opens nothing. RLS is the usual backstop.
--
-- Lock order everywhere, so nothing deadlocks: the room, then its invite, then member rows, then shares (end_share:
-- share, files, ledger). delete_room takes the room FOR UPDATE; accept and the merge FOR NO KEY UPDATE; posting
-- takes it FOR KEY SHARE and the poster's member row FOR SHARE, so a post waits for a deletion or a removal in
-- progress and then sees it.
--
-- Ownership follows the earlier migrations: tables that reference auth.users are created by the migration role
-- and handed to app_owner; Realtime trigger functions, merge_anonymous_user and delete_due_accounts stay owned by
-- the migration role.

-- ---------------------------------------------------------------------------
-- Tables (created by the migration role: they reference auth.users)
-- ---------------------------------------------------------------------------
create table app.rooms (
  id uuid primary key default gen_random_uuid(),
  -- 'workspace' is Phase 5.
  kind text not null default 'private' check (kind in ('private')),
  owner_user_id uuid references auth.users (id) on delete set null,
  label text not null check (char_length(label) between 1 and 60 and label is nfc normalized),
  label_is_custom boolean not null default false,
  members_can_create_links boolean not null default true,
  default_expiry_seconds integer check (default_expiry_seconds > 0),
  -- The owner's limits when the room was made (its member cap); never rewritten (§17.16, D4-14).
  entitlement_snapshot jsonb not null check (jsonb_typeof(entitlement_snapshot) = 'object'),
  created_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- An open room always has its owner: account deletion deletes the owner's rooms first (delete_due_accounts).
  constraint rooms_owner_while_open check (deleted_at is not null or owner_user_id is not null)
);
create index rooms_owner_idx on app.rooms (owner_user_id) where deleted_at is null;
create index rooms_deleted_idx on app.rooms (deleted_at) where deleted_at is not null;
alter table app.rooms owner to app_owner;

create table app.room_members (
  room_id uuid not null references app.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The opaque memberId (C4-18).
  id uuid not null default gen_random_uuid(),
  role text not null check (role in ('owner', 'member')),
  joined_via text not null check (joined_via in ('creator', 'pairing', 'invite_link')),
  -- No foreign key: invites are purged 7 days after they end, memberships outlive them.
  invite_id text check (invite_id ~ '^[A-Za-z0-9_-]{16}$'),
  joined_device_id uuid references app.devices (id) on delete set null,
  created_at timestamptz not null default now(),
  -- When the current membership began (a rejoin starts it again).
  joined_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by_user_id uuid,
  removed_reason text check (removed_reason in ('left', 'removed', 'room_deleted', 'account_deleted', 'merged')),
  primary key (room_id, user_id),
  constraint room_members_id_key unique (id),
  constraint room_members_removal check ((removed_at is null) = (removed_reason is null)),
  constraint room_members_owner_joined check ((role = 'owner') = (joined_via = 'creator')),
  constraint room_members_invite check ((joined_via = 'creator') = (invite_id is null)),
  -- The owner can't leave or be removed (D4-18): only the room's deletion ends the owner's membership.
  constraint room_members_owner_stays check (role <> 'owner' or removed_reason is null or removed_reason = 'room_deleted')
);
create unique index room_members_one_owner_idx on app.room_members (room_id) where role = 'owner' and removed_at is null;
create index room_members_user_idx on app.room_members (user_id) where removed_at is null;
create index room_members_active_idx on app.room_members (room_id, joined_at) where removed_at is null;
create index room_members_removed_idx on app.room_members (removed_at) where removed_at is not null;
alter table app.room_members owner to app_owner;

create table app.room_invites (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{16}$'),
  room_id uuid not null references app.rooms (id) on delete cascade,
  kind text not null check (kind in ('pairing', 'invite_link')),
  secret_hmac bytea not null check (octet_length(secret_hmac) = 32),
  pepper_version smallint not null check (pepper_version > 0),
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  max_uses integer check (max_uses > 0),
  use_count integer not null default 0 check (use_count >= 0),
  revoked_at timestamptz,
  -- Pairing: 10 minutes, one use (QR pairing, P4-18). Invite links: at most 7 days (§17.8.4.1).
  constraint room_invites_lifetime check (
    expires_at > created_at
    and expires_at <= created_at + case when kind = 'pairing' then interval '10 minutes' else interval '7 days' end),
  constraint room_invites_pairing_once check (kind <> 'pairing' or max_uses = 1),
  constraint room_invites_uses check (max_uses is null or use_count <= max_uses)
);
create index room_invites_room_idx on app.room_invites (room_id, created_at desc);
create index room_invites_expiry_idx on app.room_invites (expires_at);
alter table app.room_invites owner to app_owner;

-- ---------------------------------------------------------------------------
-- Shares and downloads (§17.12.2)
-- ---------------------------------------------------------------------------
alter table app.shares add column room_id uuid references app.rooms (id) on delete restrict;
alter table app.shares drop constraint shares_scope_check;
alter table app.shares add constraint shares_scope_check check (scope in ('network', 'link_only', 'room'));
-- A room share has its room and, by shares_network_scope, no network space (G-R2).
alter table app.shares add constraint shares_room_scope check ((scope = 'room') = (room_id is not null));
create index shares_room_feed_idx on app.shares (room_id, created_at desc) where status in ('pending_upload', 'active', 'claimed');
create index shares_room_idx on app.shares (room_id) where room_id is not null;

alter table app.downloads drop constraint downloads_actor_kind_check;
alter table app.downloads add constraint downloads_actor_kind_check
  check (actor_kind in ('network_device', 'creator', 'link_viewer', 'room_member'));
-- The room a download happened in (history context, §17.8.6); no foreign key, like network_space_id.
alter table app.downloads add column room_id uuid;

set role app_owner;

-- ---------------------------------------------------------------------------
-- app.room_role: the caller's role in an open room, or null (not a member, removed, or the room is deleted).
-- Every room route starts here (§17.11.2).
-- ---------------------------------------------------------------------------
create function app.room_role(p_room_id uuid, p_user_id uuid)
returns text
language sql stable security invoker set search_path = ''
as $$
  select m.role
    from app.room_members m
    join app.rooms r on r.id = m.room_id
   where m.room_id = p_room_id and m.user_id = p_user_id and m.removed_at is null and r.deleted_at is null
$$;

-- ---------------------------------------------------------------------------
-- app.create_room (E17, E18): the owner's open rooms stay under the cap, also for concurrent creations (one
-- at a time per owner, by a transaction-scoped advisory lock). The owner's membership is made with the room.
-- Outcomes: created (with the room), room_limit.
-- ---------------------------------------------------------------------------
create function app.create_room(
  p_owner_user_id uuid,
  p_device_id uuid,
  p_label text,
  p_label_is_custom boolean,
  p_snapshot jsonb,
  p_max_rooms integer
)
returns table (outcome text, room_id uuid)
language plpgsql volatile security invoker set search_path = ''
as $$
declare
  v_open integer;
  v_room uuid;
begin
  if p_owner_user_id is null or p_device_id is null or p_label is null or p_label_is_custom is null
     or p_snapshot is null or p_max_rooms is null or p_max_rooms < 0 then
    raise exception 'invalid room arguments' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('app.create_room|' || p_owner_user_id::text, 0));
  select count(*)::integer into v_open from app.rooms r where r.owner_user_id = p_owner_user_id and r.deleted_at is null;
  if v_open >= p_max_rooms then
    return query select 'room_limit'::text, null::uuid;
    return;
  end if;
  insert into app.rooms (owner_user_id, label, label_is_custom, entitlement_snapshot)
  values (p_owner_user_id, p_label, p_label_is_custom, p_snapshot)
  returning id into v_room;
  insert into app.room_members (room_id, user_id, role, joined_via, joined_device_id)
  values (v_room, p_owner_user_id, 'owner', 'creator', p_device_id);
  return query select 'created'::text, v_room;
end
$$;

-- ---------------------------------------------------------------------------
-- app.accept_room_invite (§17.8.4.1, E19). The service has already checked the secret timing-safely; it is
-- checked again here, under the locks, with the HMAC under each configured pepper. Outcomes:
--   unavailable     unknown invite or wrong secret (the API's uniform 404)
--   expired         after proof: revoked, expired, used up, or the room deleted (410)
--   already_member  the caller is an active member (idempotent 200; uses nothing)
--   member_limit    the room is at its snapshot's member cap (409)
--   joined          a new membership, or a removed member's again (rejoin with a valid invite)
-- ---------------------------------------------------------------------------
create function app.accept_room_invite(p_invite_id text, p_secret_hmacs bytea[], p_user_id uuid, p_device_id uuid)
returns table (outcome text, room_id uuid)
language plpgsql volatile security invoker set search_path = ''
as $$
declare
  v_room_id uuid;
  v_room app.rooms;
  v_invite app.room_invites;
  v_member app.room_members;
  v_active integer;
begin
  if p_invite_id is null or p_secret_hmacs is null or p_user_id is null or p_device_id is null then
    raise exception 'invalid invite arguments' using errcode = '22023';
  end if;
  select i.room_id into v_room_id from app.room_invites i where i.id = p_invite_id;
  if not found then
    return query select 'unavailable'::text, null::uuid;
    return;
  end if;
  select * into v_room from app.rooms r where r.id = v_room_id for no key update;
  select * into v_invite from app.room_invites i where i.id = p_invite_id for update;
  if not found or not (v_invite.secret_hmac = any (p_secret_hmacs)) then
    return query select 'unavailable'::text, null::uuid;
    return;
  end if;
  -- Proven: from here on the caller may learn the invite's state.
  if v_room.deleted_at is not null or v_invite.revoked_at is not null or v_invite.expires_at <= now() then
    return query select 'expired'::text, null::uuid;
    return;
  end if;
  select * into v_member from app.room_members m where m.room_id = v_room.id and m.user_id = p_user_id for update;
  if found and v_member.removed_at is null then
    return query select 'already_member'::text, v_room.id;
    return;
  end if;
  if v_invite.max_uses is not null and v_invite.use_count >= v_invite.max_uses then
    return query select 'expired'::text, null::uuid;
    return;
  end if;
  select count(*)::integer into v_active from app.room_members m where m.room_id = v_room.id and m.removed_at is null;
  if v_active + 1 > coalesce((v_room.entitlement_snapshot -> 'limits' ->> 'maxRoomMembers')::integer, 0) then
    return query select 'member_limit'::text, null::uuid;
    return;
  end if;
  update app.room_invites i set use_count = i.use_count + 1 where i.id = v_invite.id;
  insert into app.room_members as m (room_id, user_id, role, joined_via, invite_id, joined_device_id)
  values (v_room.id, p_user_id, 'member', v_invite.kind, v_invite.id, p_device_id)
  on conflict on constraint room_members_pkey do update
     set joined_via = excluded.joined_via, invite_id = excluded.invite_id, joined_device_id = excluded.joined_device_id,
         joined_at = now(), removed_at = null, removed_by_user_id = null, removed_reason = null
   where m.removed_at is not null and m.role = 'member';
  return query select 'joined'::text, v_room.id;
end
$$;

-- ---------------------------------------------------------------------------
-- app.delete_room (§17.8.4): the owner's (or, for account deletion, the job's) one path. Under the room's lock:
-- end every open share in the room (room_deleted: objects to the outbox, their links revoked), revoke its
-- invites, remove every member, soft-delete the room, audit. Returns the shares ended, or null when the room
-- doesn't exist, is already deleted or isn't p_by_user_id's. Room rows are purged later (purge_ephemeral).
-- ---------------------------------------------------------------------------
create function app.delete_room(p_room_id uuid, p_by_user_id uuid, p_reason text)
returns integer
language plpgsql volatile security invoker set search_path = ''
as $$
declare
  v_room app.rooms;
  v_share uuid;
  v_ended integer := 0;
begin
  if p_room_id is null or p_by_user_id is null or p_reason is null or p_reason not in ('deleted_by_owner', 'account_deleted') then
    raise exception 'invalid room deletion' using errcode = '22023';
  end if;
  select * into v_room from app.rooms r where r.id = p_room_id for update;
  if not found or v_room.deleted_at is not null or v_room.owner_user_id is distinct from p_by_user_id then
    return null;
  end if;
  for v_share in select s.id from app.shares s where s.room_id = p_room_id and s.ended_at is null order by s.id loop
    if app.end_share(v_share, 'room_deleted') then
      v_ended := v_ended + 1;
    end if;
  end loop;
  update app.room_invites i set revoked_at = now() where i.room_id = p_room_id and i.revoked_at is null;
  update app.room_members m
     set removed_at = now(), removed_by_user_id = p_by_user_id, removed_reason = 'room_deleted'
   where m.room_id = p_room_id and m.removed_at is null;
  update app.rooms r set deleted_at = now() where r.id = p_room_id;
  insert into app.audit_events (actor_kind, actor_user_id, action, target_type, target_id, metadata)
  values (case when p_reason = 'account_deleted' then 'system' else 'device' end, p_by_user_id, 'room.deleted', 'room',
          p_room_id::text, jsonb_build_object('reason', p_reason, 'sharesEnded', v_ended));
  return v_ended;
end
$$;

-- ---------------------------------------------------------------------------
-- claim_burn_share (Phase 3), P4-17 version: a room member's claim is logged as room_member, with the room
-- (DEC-015 unchanged: the first member other than the creator to download claims it). Otherwise as Phase 3.
-- ---------------------------------------------------------------------------
create or replace function app.claim_burn_share(
  p_share_id uuid,
  p_file_id uuid,
  p_purpose text,
  p_claimant_user_id uuid,
  p_claimant_device_id uuid,
  p_link_session_hash bytea,
  p_link_id text,
  p_url_ttl_seconds integer,
  p_user_agent_family text
)
returns table (outcome text, claim_grace_until timestamptz, issuance integer, by_you boolean)
language plpgsql volatile security invoker set search_path = ''
as $$
declare
  v_device boolean := p_claimant_user_id is not null or p_claimant_device_id is not null;
  v_viewer boolean := p_link_session_hash is not null;
  v_kind text := case p_purpose when 'file' then 'files' when 'text' then 'text' end;
  v_share app.shares;
  v_mine boolean;
  v_used integer;
  v_event text;
  v_won boolean := false;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'claim_burn_share must run under READ COMMITTED' using errcode = '25001';
  end if;
  if v_device = v_viewer
     or (v_device and (p_claimant_user_id is null or p_claimant_device_id is null))
     or (v_viewer and (octet_length(p_link_session_hash) <> 32 or p_link_id is null))
     or v_kind is null
     or ((p_purpose = 'file') <> (p_file_id is not null))
     or (p_purpose = 'file' and (p_url_ttl_seconds is null or p_url_ttl_seconds not between 1 and 300)) then
    raise exception 'invalid claim arguments' using errcode = '22023';
  end if;
  -- The caller found the file verified; it may have been ended since (then: already downloaded).
  if p_purpose = 'file' and not exists (select 1 from app.files f where f.id = p_file_id and f.share_id = p_share_id) then
    raise exception 'the file is not a file of this share' using errcode = '22023';
  end if;

  update app.shares s
     set status = 'claimed',
         claimed_at = now(),
         claimed_by_user_id = p_claimant_user_id,
         claimed_device_id = p_claimant_device_id,
         claimed_link_session_hash = p_link_session_hash,
         claimed_link_id = case when v_viewer then p_link_id end,
         claim_grace_until = least(now() + app.burn_grace(s.total_bytes), s.expires_at),
         updated_at = now()
   where s.id = p_share_id
     and s.status = 'active'
     and s.burn_after_download
     and s.kind = v_kind
     and s.expires_at > now()
     and (p_claimant_user_id is null or s.created_by_user_id is distinct from p_claimant_user_id)
  returning s.* into v_share;

  if found then
    v_won := true;
    v_event := case when p_purpose = 'file' then 'burn_claimed' else 'text_revealed' end;
    v_used := 0;
  else
    -- Lost, or not claimable: read the latest committed state under the row lock.
    select * into v_share from app.shares s where s.id = p_share_id for update;
    if not found then
      return query select 'not_claimable'::text, null::timestamptz, 0, false;
      return;
    end if;
    if p_claimant_user_id is not null and v_share.created_by_user_id = p_claimant_user_id then
      raise exception 'creators never claim their own share' using errcode = '22023';
    end if;
    v_mine := coalesce(case when v_device
                            then v_share.claimed_by_user_id = p_claimant_user_id and v_share.claimed_device_id = p_claimant_device_id
                            else v_share.claimed_link_session_hash = p_link_session_hash end, false);

    if v_share.kind <> v_kind or not v_share.burn_after_download then
      return query select 'not_claimable'::text, null::timestamptz, 0, false;
      return;
    end if;
    if v_share.status = 'claimed' and v_mine and now() < v_share.claim_grace_until and v_share.expires_at > now() then
      select count(*)::integer into v_used
        from app.downloads d
       where d.share_id = p_share_id
         and ((p_purpose = 'file' and d.file_id = p_file_id and d.event in ('burn_claimed', 'burn_retry'))
              or (p_purpose = 'text' and d.event = 'text_revealed'));
      if v_used >= 3 then
        return query select 'retry_limit'::text, v_share.claim_grace_until, v_used, true;
        return;
      end if;
      v_event := case when p_purpose = 'file' then 'burn_retry' else 'text_revealed' end;
    elsif v_share.status in ('claimed', 'consumed') then
      return query select 'already_downloaded'::text, null::timestamptz, 0, v_mine;
      return;
    else
      return query select 'not_claimable'::text, null::timestamptz, 0, false;
      return;
    end if;
  end if;

  insert into app.downloads (share_id, file_id, network_space_id, room_id, actor_kind, user_id, device_id, link_id, event,
                             url_expires_at, user_agent_family, retention_until)
  values (p_share_id, p_file_id, v_share.network_space_id, v_share.room_id,
          case when v_viewer then 'link_viewer' when v_share.scope = 'room' then 'room_member' else 'network_device' end,
          p_claimant_user_id, p_claimant_device_id, case when v_viewer then p_link_id end, v_event,
          case when p_purpose = 'file' then now() + make_interval(secs => p_url_ttl_seconds) end,
          left(p_user_agent_family, 60),
          now() + make_interval(days => coalesce((v_share.entitlement_snapshot ->> 'historyRetentionDays')::integer, 30)));

  return query select case when v_won then 'claimed' else 'retry' end, v_share.claim_grace_until, v_used + 1, true;
end
$$;

-- ---------------------------------------------------------------------------
-- purge-ephemeral (every 10 min), P4-17 version: invites 7 days after they expire or are revoked; removed
-- memberships after 30 days; deleted rooms 30 days after deletion once no share row refers to them (share
-- tombstones go first, purge_tombstones). Otherwise as Phase 4C.
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
  update app.billing_checkouts set status = 'expired' where status = 'created' and expires_at <= now();
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app.billing_checkouts where created_at < now() - interval '30 days';
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app.billing_events where retention_until < now();
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app.room_invites where least(expires_at, coalesce(revoked_at, expires_at)) < now() - interval '7 days';
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app.room_members where removed_at < now() - interval '30 days';
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app.rooms r
   where r.deleted_at < now() - interval '30 days'
     and not exists (select 1 from app.shares s where s.room_id = r.id);
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  return v_total;
end
$$;

-- ---------------------------------------------------------------------------
-- Realtime topic authorization, P4-17 version (§17.8.4, §17.11.1). Adds:
--   room:{id}  an active member of the open room, whose session is bound to a non-revoked device of theirs,
--              and not suspended. Presence can't be tracked on room topics (the insert policy allows net: only),
--              so a room never shows who is online or where.
-- Otherwise as Phase 4A.
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
  elsif v_kind = 'room' then
    return v_session is not null
       and not exists (select 1 from app.user_flags uf where uf.user_id = v_uid and uf.suspended_at is not null)
       and exists (select 1 from app.devices d where d.auth_session_id = v_session and d.user_id = v_uid and d.revoked_at is null)
       and exists (
         select 1
           from app.room_members m
           join app.rooms r on r.id = m.room_id
          where m.room_id = v_id and m.user_id = v_uid and m.removed_at is null and r.deleted_at is null);
  end if;
  return false;
end
$$;

reset role;

-- ---------------------------------------------------------------------------
-- Realtime signals (DEC-011), P4-17 versions. ID-only payloads, owned by the migration role.
--   share.changed       room shares go to room:{room_id} (never to a net: topic) and their creator's user: topic
--   member.changed      room:{room_id}, { change }: someone joined, left, was removed, or the room was deleted
--   membership.changed  user:{user_id}, { roomId, change }: the user's own membership changed (the client
--                       refetches its rooms and drops the room's channel)
--   room.updated        room:{id}: name or settings changed;  room.deleted  room:{id}
-- ---------------------------------------------------------------------------
create or replace function app.emit_share_changed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_payload jsonb;
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status or new.expires_at is distinct from old.expires_at then
    v_payload := jsonb_build_object('v', 1, 'type', 'share.changed', 'shareId', new.id, 'status', new.status);
    if new.scope = 'network' then
      perform realtime.send(v_payload, 'share.changed', 'net:' || new.network_space_id::text, true);
    elsif new.scope = 'room' then
      perform realtime.send(v_payload, 'share.changed', 'room:' || new.room_id::text, true);
    end if;
    if new.created_by_user_id is not null then
      perform realtime.send(v_payload, 'share.changed', 'user:' || new.created_by_user_id::text, true);
    end if;
  elsif new.extension_pending is distinct from old.extension_pending and new.created_by_user_id is not null then
    v_payload := jsonb_build_object('v', 1, 'type', 'share.changed', 'shareId', new.id, 'status', new.status);
    perform realtime.send(v_payload, 'share.changed', 'user:' || new.created_by_user_id::text, true);
  end if;
  return null;
end
$$;

create or replace function app.emit_text_changed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_payload jsonb;
  v_creator uuid;
  v_space uuid;
  v_room uuid;
begin
  if new.version is distinct from old.version then
    select s.created_by_user_id, s.network_space_id, s.room_id into v_creator, v_space, v_room
      from app.shares s where s.id = new.share_id;
    v_payload := jsonb_build_object('v', 1, 'type', 'share.changed', 'shareId', new.share_id, 'version', new.version);
    if v_space is not null then
      perform realtime.send(v_payload, 'share.changed', 'net:' || v_space::text, true);
    end if;
    if v_room is not null then
      perform realtime.send(v_payload, 'share.changed', 'room:' || v_room::text, true);
    end if;
    if v_creator is not null then
      perform realtime.send(v_payload, 'share.changed', 'user:' || v_creator::text, true);
    end if;
  end if;
  return null;
end
$$;

create function app.emit_member_changed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_room uuid;
  v_user uuid;
  v_change text;
begin
  if tg_op = 'INSERT' then
    v_room := new.room_id;
    v_user := new.user_id;
    v_change := case when new.removed_at is null then 'joined' end;
  elsif tg_op = 'DELETE' then
    -- A purged removed row changes nothing for anyone; an active one went with its user (account deleted).
    v_room := old.room_id;
    v_user := old.user_id;
    v_change := case when old.removed_at is null then 'removed' end;
  else
    v_room := new.room_id;
    v_user := new.user_id;
    if new.user_id is distinct from old.user_id then
      -- A merge moved the membership to the account (§17.5.4).
      v_change := case when new.removed_at is null then 'joined' end;
    elsif old.removed_at is null and new.removed_at is not null then
      v_change := case new.removed_reason when 'left' then 'left' when 'room_deleted' then 'room_deleted' else 'removed' end;
    elsif old.removed_at is not null and new.removed_at is null then
      v_change := 'joined';
    end if;
  end if;
  if v_change is null then
    return null;
  end if;
  perform realtime.send(jsonb_build_object('v', 1, 'type', 'member.changed', 'change', v_change),
                        'member.changed', 'room:' || v_room::text, true);
  perform realtime.send(jsonb_build_object('v', 1, 'type', 'membership.changed', 'roomId', v_room, 'change', v_change),
                        'membership.changed', 'user:' || v_user::text, true);
  return null;
end
$$;

create function app.emit_room_updated()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    perform realtime.send(jsonb_build_object('v', 1, 'type', 'room.deleted'), 'room.deleted', 'room:' || new.id::text, true);
  elsif new.deleted_at is null
        and (new.label is distinct from old.label
             or new.members_can_create_links is distinct from old.members_can_create_links
             or new.default_expiry_seconds is distinct from old.default_expiry_seconds) then
    perform realtime.send(jsonb_build_object('v', 1, 'type', 'room.updated'), 'room.updated', 'room:' || new.id::text, true);
  end if;
  return null;
end
$$;

create trigger room_members_emit_changed
  after insert or update or delete on app.room_members
  for each row execute function app.emit_member_changed();
create trigger rooms_emit_updated
  after update of label, members_can_create_links, default_expiry_seconds, deleted_at on app.rooms
  for each row execute function app.emit_room_updated();

-- ---------------------------------------------------------------------------
-- merge_anonymous_user (Phase 4A), P4-17 version: room memberships move with the anonymous user (D4-19, AC-4.1),
-- part of P4-21 brought forward because the coverage test (M10) refuses an unhandled user column. The source's
-- active memberships become the account's; where the account already has a row in that room it stays, and is
-- active again if only the source's was. The rooms are locked before anything else (the room-first lock
-- order of delete_room and accept_room_invite). An anonymous user owns no room and made no invite (rooms are
-- Pro, Pro needs an account). Otherwise as Phase 4A.
-- ---------------------------------------------------------------------------
create or replace function app.merge_anonymous_user(
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
  v_memberships integer := 0;
  v_n integer;
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

  -- 5. Locks: the source's rooms and both users' member rows in them (room first, P4-17), the source's shares,
  -- its active reservations, both ledger rows (M8).
  perform 1 from app.rooms rm
   where rm.id in (select m.room_id from app.room_members m where m.user_id = v_source)
   order by rm.id
     for no key update;
  perform 1 from app.room_members m
   where m.user_id in (v_source, p_target_user_id)
     and m.room_id in (select m2.room_id from app.room_members m2 where m2.user_id = v_source)
   order by m.room_id, m.user_id
     for update;
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
  -- Room memberships (P4-17): the account's removed row in a room comes back when the source is active there;
  -- otherwise the source's row moves. Rows left behind (the account was already a member) go with the source.
  update app.room_members t
     set joined_via = s.joined_via, invite_id = s.invite_id, joined_device_id = s.joined_device_id, joined_at = s.joined_at,
         removed_at = null, removed_by_user_id = null, removed_reason = null
    from app.room_members s
   where s.user_id = v_source and s.removed_at is null and s.role = 'member'
     and t.room_id = s.room_id and t.user_id = p_target_user_id and t.removed_at is not null and t.role = 'member';
  get diagnostics v_n = row_count;
  v_memberships := v_n;
  with moved as (
    update app.room_members s set user_id = p_target_user_id
     where s.user_id = v_source
       and not exists (select 1 from app.room_members t where t.room_id = s.room_id and t.user_id = p_target_user_id)
    returning s.removed_at
  )
  select v_memberships + count(*) filter (where moved.removed_at is null) into v_memberships from moved;
  update app.room_members m set removed_by_user_id = p_target_user_id where m.removed_by_user_id = v_source;
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

  -- 10. The anonymous user goes; its sessions, identities, other devices, flags, idempotency keys and leftover
  -- member rows cascade. Its audit events keep its ID (history stays truthful).
  delete from auth.users u where u.id = v_source and u.is_anonymous;

  -- 11. Done (M16).
  v_result := jsonb_build_object('shares', v_shares, 'links', v_links, 'devices', 1, 'memberships', v_memberships, 'bytes', v_committed);
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
-- delete-due-accounts (Phase 4A), P4-17 version: the account's open rooms are deleted first (delete_room:
-- their shares end, invites are revoked, members removed), because an open room must keep its owner
-- (rooms_owner_while_open). Its memberships in other rooms go with the Auth user. Otherwise as Phase 4A.
-- Still not scheduled (P4-22).
-- ---------------------------------------------------------------------------
create or replace function app.delete_due_accounts(p_batch integer)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  r record;
  v_room uuid;
  v_share uuid;
  v_ended integer;
  v_rooms integer;
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
    v_rooms := 0;
    for v_room in select rm.id from app.rooms rm where rm.owner_user_id = r.user_id and rm.deleted_at is null order by rm.id loop
      if app.delete_room(v_room, r.user_id, 'account_deleted') is not null then
        v_rooms := v_rooms + 1;
      end if;
    end loop;
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
    values ('system', 'account.deleted', 'user', r.user_id::text, jsonb_build_object('sharesEnded', v_ended, 'roomsDeleted', v_rooms));
    delete from auth.users u where u.id = r.user_id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

-- ---------------------------------------------------------------------------
-- RLS and grants: the usual app_server policy on each new table; functions granted one by one.
-- ---------------------------------------------------------------------------
alter table app.rooms enable row level security;
create policy app_server_all on app.rooms for all to app_server using (true) with check (true);
grant select, insert, update, delete on app.rooms to app_server;

alter table app.room_members enable row level security;
create policy app_server_all on app.room_members for all to app_server using (true) with check (true);
grant select, insert, update, delete on app.room_members to app_server;

alter table app.room_invites enable row level security;
create policy app_server_all on app.room_invites for all to app_server using (true) with check (true);
grant select, insert, update, delete on app.room_invites to app_server;

revoke execute on all functions in schema app from public;
revoke execute on all functions in schema app_realtime from public;
grant execute on function app_realtime.can_access_topic(text) to authenticated;
grant execute on function
  app.room_role(uuid, uuid),
  app.create_room(uuid, uuid, text, boolean, jsonb, integer),
  app.accept_room_invite(text, bytea[], uuid, uuid),
  app.delete_room(uuid, uuid, text)
  to app_server;
