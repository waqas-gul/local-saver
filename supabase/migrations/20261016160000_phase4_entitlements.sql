-- Phase 4B: entitlements (phase 4 §17.6, §17.12, §17.16; tasks P4-09 and P4-10).
--
-- The plan of a request is resolved on the server from rows only operators and (later) billing write:
--   app.subscriptions          the billing migration's table, created here because resolution reads
--                              it (P4-09). Written only by app.apply_subscription_state (4C, P4-12);
--                              the app may read it, never write it.
--   app.entitlement_overrides  operator grants (support, beta testers, the 4D tests before billing
--                              exists). Whitelisted keys only; written through the admin functions,
--                              which are granted to nobody and audited.
-- app.entitlement_state() is the one query resolution makes: the database's now() decides every
-- time-based state (07 §2.2). Anonymous users never reach it; the service resolves them as Free.
--
-- Daily upload volume (C4-6, D4-26, recommended): a share's volume is charged in its creation
-- transaction, after the storage reservation succeeded, so a refused attempt costs nothing. The
-- charge is recorded per share, and refunded when the share ends without ever becoming active
-- (rejected at completion, deleted by its creator, its upload deadline or expiry passed), within
-- the same daily window. A takedown (blocked) is never refunded.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
set role app_owner;

-- §17.12.1. No foreign key to the user: kept for accounting after an account is deleted.
create table app.subscriptions (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z0-9_]{2,32}$'),
  provider_subscription_id text not null check (char_length(provider_subscription_id) between 1 and 255),
  provider_customer_id text not null check (char_length(provider_customer_id) between 1 and 255),
  subject_type text not null check (subject_type in ('user')),
  subject_id uuid not null,
  plan text not null check (plan in ('pro')),
  billing_interval text not null check (billing_interval in ('month', 'year')),
  status text not null check (status in ('trialing', 'active', 'past_due', 'paused', 'canceled', 'expired')),
  seats integer check (seats > 0),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  grace_until timestamptz,
  -- The ordering key: an older provider state never overwrites a newer one (4C).
  provider_updated_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscriptions_provider_id unique (provider, provider_subscription_id),
  constraint subscriptions_grace check (status <> 'past_due' or grace_until is not null)
);
create index subscriptions_subject_idx on app.subscriptions (subject_type, subject_id);
create index subscriptions_entitling_idx on app.subscriptions (subject_type, subject_id)
  where status in ('trialing', 'active', 'past_due', 'canceled');

-- §17.6.2 whitelist: the plan, four limits and the features. Values are checked by type in
-- admin_grant_override and again when resolution applies them.
create table app.entitlement_overrides (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('user')),
  subject_id uuid not null,
  key text not null check (key in (
    'plan',
    'limits.activeStorageBytes', 'limits.dailyUploadBytes', 'limits.maxFileBytes', 'limits.historyRetentionDays',
    'features.burnAfterDownload', 'features.linkPasswords', 'features.privateRooms', 'features.customRoomNames',
    'features.roomLinks', 'features.multiUseInvites', 'features.executablesInRemoteLinks',
    'features.transferHistory', 'features.extendExpiry', 'features.adminControls', 'features.brandedPages')),
  value jsonb not null,
  reason text not null check (char_length(reason) between 1 and 500),
  created_by text not null check (char_length(created_by) between 1 and 100),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  constraint entitlement_overrides_expiry check (expires_at is null or expires_at > created_at)
);
create index entitlement_overrides_subject_idx on app.entitlement_overrides (subject_type, subject_id) where revoked_at is null;

-- One row per file share: what its creation charged against the daily volume counters (C4-6).
-- The user's counter is the share creator's (re-pointed by a merge, whose counters are summed);
-- network_key is null when the plan isn't counted per network (D4-10).
create table app.upload_volume_charges (
  share_id uuid primary key references app.shares (id) on delete cascade,
  window_start timestamptz not null,
  kib integer not null check (kib > 0),
  network_key text check (char_length(network_key) between 1 and 200),
  charged_at timestamptz not null default now(),
  refunded_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Resolution input (§17.6.2): for one permanent user, in one query, with the database's clock.
--   subscription      the subscription to show: the entitling one, else the latest (null if none)
--   entitled          a subscription grants Pro: trialing or active; past_due within its grace;
--                     canceled before the end of the paid period
--   overrides         unrevoked, unexpired overrides, oldest first (a later one of a key wins)
--   deletion_pending  the account asked to be deleted and is in its grace (E30, D4-6)
-- ---------------------------------------------------------------------------
create function app.entitlement_state(p_user_id uuid)
returns table (subscription jsonb, entitled boolean, overrides jsonb, deletion_pending boolean)
language sql stable security invoker set search_path = ''
as $$
  with sub as (
    select s.*,
           (s.status in ('trialing', 'active')
            or (s.status = 'past_due' and s.grace_until > now())
            or (s.status = 'canceled' and s.current_period_end > now())) as entitles
      from app.subscriptions s
     where s.subject_type = 'user' and s.subject_id = p_user_id
  )
  select
    (select jsonb_build_object('status', sub.status, 'currentPeriodEnd', sub.current_period_end,
                               'cancelAtPeriodEnd', sub.cancel_at_period_end, 'graceUntil', sub.grace_until)
       from sub order by sub.entitles desc, sub.provider_updated_at desc limit 1),
    coalesce((select bool_or(sub.entitles) from sub), false),
    coalesce((select jsonb_agg(jsonb_build_object('key', o.key, 'value', o.value) order by o.created_at, o.id)
                from app.entitlement_overrides o
               where o.subject_type = 'user' and o.subject_id = p_user_id
                 and o.revoked_at is null and (o.expires_at is null or o.expires_at > now())), '[]'::jsonb),
    coalesce((select p.deletion_requested_at is not null from app.profiles p where p.user_id = p_user_id), false)
$$;

-- ---------------------------------------------------------------------------
-- Operator overrides (§17.6.2): run by an operator through SQL (the support runbook), never by the
-- app. Invoker functions granted to nobody. Only permanent users: anonymous users can't hold a plan.
-- ---------------------------------------------------------------------------
create function app.admin_grant_override(
  p_user_id uuid,
  p_key text,
  p_value jsonb,
  p_reason text,
  p_operator text,
  p_expires_at timestamptz default null
)
returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare
  v_id uuid;
  v_number numeric;
begin
  if coalesce(trim(p_reason), '') = '' or coalesce(trim(p_operator), '') = '' then
    raise exception 'a reason and the operator''s name are required' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id and u.is_anonymous = false) then
    raise exception 'overrides are for permanent accounts only' using errcode = '22023';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'the expiry must be in the future' using errcode = '22023';
  end if;
  if p_key = 'plan' then
    if jsonb_typeof(p_value) <> 'string' or p_value #>> '{}' not in ('free', 'pro') then
      raise exception 'plan must be "free" or "pro"' using errcode = '22023';
    end if;
  elsif p_key like 'limits.%' then
    if jsonb_typeof(p_value) <> 'number' then
      raise exception '% must be a number', p_key using errcode = '22023';
    end if;
    v_number := (p_value #>> '{}')::numeric;
    if v_number <> trunc(v_number) or v_number < 1 or v_number > 9007199254740991
       or (p_key = 'limits.historyRetentionDays' and v_number > 36500) then
      raise exception '% must be a positive whole number in range', p_key using errcode = '22023';
    end if;
  elsif p_key like 'features.%' then
    if jsonb_typeof(p_value) <> 'boolean' then
      raise exception '% must be true or false', p_key using errcode = '22023';
    end if;
  end if;

  insert into app.entitlement_overrides (subject_type, subject_id, key, value, reason, created_by, expires_at)
  values ('user', p_user_id, p_key, p_value, left(trim(p_reason), 500), left(trim(p_operator), 100), p_expires_at)
  returning id into v_id;

  insert into app.audit_events (actor_kind, action, target_type, target_id, metadata)
  values ('operator', 'admin.override_granted', 'user', p_user_id::text,
          jsonb_build_object('overrideId', v_id, 'key', p_key, 'value', p_value, 'expiresAt', p_expires_at,
                             'operator', left(trim(p_operator), 100), 'reason', left(trim(p_reason), 500)));
  return v_id;
end
$$;

create function app.admin_revoke_override(p_override_id uuid, p_reason text, p_operator text)
returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare
  v_row app.entitlement_overrides;
begin
  if coalesce(trim(p_reason), '') = '' or coalesce(trim(p_operator), '') = '' then
    raise exception 'a reason and the operator''s name are required' using errcode = '22023';
  end if;
  update app.entitlement_overrides set revoked_at = now()
   where id = p_override_id and revoked_at is null
  returning * into v_row;
  if not found then
    return false;
  end if;
  insert into app.audit_events (actor_kind, action, target_type, target_id, metadata)
  values ('operator', 'admin.override_revoked', 'user', v_row.subject_id::text,
          jsonb_build_object('overrideId', v_row.id, 'key', v_row.key,
                             'operator', left(trim(p_operator), 100), 'reason', left(trim(p_reason), 500)));
  return true;
end
$$;

-- ---------------------------------------------------------------------------
-- Daily volume refund (C4-6, D4-26). Internal: end_share calls it for a share that never became
-- active. Only the charge's own window is decremented (an earlier day's budget is already spent);
-- a second call finds the charge refunded and does nothing.
-- ---------------------------------------------------------------------------
create function app.refund_upload_volume(p_share_id uuid)
returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare
  v_charge app.upload_volume_charges;
  v_user uuid;
begin
  select * into v_charge from app.upload_volume_charges
   where share_id = p_share_id and refunded_at is null for update;
  if not found then
    return false;
  end if;
  select s.created_by_user_id into v_user from app.shares s where s.id = p_share_id;
  update app.rate_counters rc
     set value = greatest(rc.value - v_charge.kib, 0)
   where rc.window_start = v_charge.window_start
     and (rc.key = 'upload_kib:user:' || v_user::text
          or (v_charge.network_key is not null and rc.key = 'upload_kib:net:' || v_charge.network_key));
  update app.upload_volume_charges set refunded_at = now() where share_id = p_share_id;
  return true;
end
$$;

-- ---------------------------------------------------------------------------
-- end_share (04 §9.1, DEC-016), Phase 4B version: a share that ends while still pending_upload,
-- because its upload failed, its creator deleted it or it expired, gets its daily volume back
-- (C4-6). Otherwise as Phase 4A.
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

  if v_share.status = 'pending_upload' and p_reason in ('upload_failed', 'deleted_by_creator', 'expired') then
    perform app.refund_upload_volume(p_share_id);
  end if;

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

reset role;

-- ---------------------------------------------------------------------------
-- RLS and grants (§17.12.4): the app reads subscriptions and overrides, never writes them.
-- ---------------------------------------------------------------------------
alter table app.subscriptions enable row level security;
create policy app_server_read on app.subscriptions for select to app_server using (true);
grant select on app.subscriptions to app_server;

alter table app.entitlement_overrides enable row level security;
create policy app_server_read on app.entitlement_overrides for select to app_server using (true);
grant select on app.entitlement_overrides to app_server;

alter table app.upload_volume_charges enable row level security;
create policy app_server_all on app.upload_volume_charges for all to app_server using (true) with check (true);
grant select, insert, update, delete on app.upload_volume_charges to app_server;

revoke execute on all functions in schema app from public;

grant execute on function app.entitlement_state(uuid) to app_server;
-- admin_grant_override and admin_revoke_override are for operators only (no grant). refund_upload_volume
-- is internal to end_share, which app_server already executes.
grant execute on function app.refund_upload_volume(uuid) to app_server;
